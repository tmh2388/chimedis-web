/**
 * billing.js — đơn nâng cấp gói, thanh toán chuyển khoản (VietQR) và kích hoạt gói.
 *
 * Luồng: người dùng chọn gói + kỳ hạn → tạo đơn có MÃ DUY NHẤT (CHMxxxxxx) → chuyển khoản kèm mã trong nội dung →
 * tiền vào được xác nhận theo một trong ba cách, đều gọi approveOrder():
 *   (1) webhook của dịch vụ theo dõi giao dịch (SePay… — POST /api/payments/sepay, xác thực khoá API),
 *   (2) quản trị viên bấm "Duyệt" trong hàng chờ,
 *   (3) mã kích hoạt (redeem code) bán qua kênh khác.
 * Quy ước an toàn: khớp cả MÃ lẫn SỐ TIỀN; mỗi giao dịch ngân hàng chỉ dùng MỘT lần (bank_ref duy nhất); gia hạn cộng dồn.
 * Chỉ dùng ở web — app iOS không có giao diện mua (App Store Guideline 3.1.1/3.1.3).
 */
import crypto from 'node:crypto';
import * as aiBudget from './ai-budget.js';

export const PRICES = {
  pro: { month: 99000, year: 990000 }, // năm = 10 tháng
  max: { month: 249000, year: 2490000 },
};
export const PERIOD_MONTHS = { month: 1, year: 12 };
// Gói nạp credit (1 credit = 0,01 USD chi phí AI/TTS). Giá bán ≈ 2,3× giá vốn, mua nhiều rẻ hơn. Chỉ bán ở web (App Store 3.1.1).
export const PACKS = {
  p100: { credits: 100, amount: 59000 },
  p300: { credits: 300, amount: 159000 },
  p800: { credits: 800, amount: 399000 },
};
const ORDER_TTL_HOURS = 72;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // bỏ ký tự dễ nhầm (0/O, 1/I/L)

const rnd = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

export function bankConfig() {
  const bin = process.env.BANK_BIN || '';
  const account = process.env.BANK_ACCOUNT || '';
  return {
    configured: !!(bin && account && process.env.BANK_ACCOUNT_NAME),
    bin, account,
    accountName: process.env.BANK_ACCOUNT_NAME || '',
    bankName: process.env.BANK_NAME || '',
  };
}

export function qrUrl(order) {
  const b = bankConfig();
  if (!b.configured) return null;
  const q = new URLSearchParams({ amount: String(order.amount), addInfo: order.code, accountName: b.accountName });
  return `https://img.vietqr.io/image/${encodeURIComponent(b.bin)}-${encodeURIComponent(b.account)}-compact2.png?${q}`;
}

export async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    code VARCHAR(16) NOT NULL PRIMARY KEY,
    firebase_uid VARCHAR(128) NOT NULL, email VARCHAR(255) NULL,
    plan VARCHAR(16) NOT NULL, plan_period VARCHAR(8) NOT NULL, amount INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    method VARCHAR(24) NULL, bank_ref VARCHAR(80) NULL UNIQUE, paid_amount INT NULL, note VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, paid_at DATETIME NULL,
    KEY idx_uid (firebase_uid), KEY idx_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Cột mới cho đơn nạp credit (bảng đã có sẵn trên production → kiểm tra trước rồi mới ALTER).
  try {
    const [cols] = await pool.query("SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME IN ('kind', 'credits')");
    const have = new Set((cols || []).map((c) => c.n));
    if (!have.has('kind')) await pool.query("ALTER TABLE orders ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'plan'");
    if (!have.has('credits')) await pool.query('ALTER TABLE orders ADD COLUMN credits INT NULL');
  } catch (e) { console.error('[billing] cột kind/credits:', e.message); }
  await pool.query(`CREATE TABLE IF NOT EXISTS redeem_codes (
    code VARCHAR(24) NOT NULL PRIMARY KEY, plan VARCHAR(16) NOT NULL, months INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(255) NULL,
    used_by_uid VARCHAR(128) NULL, used_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // 31/1 + 1 tháng → cuối tháng 2
  return d;
}

/** Cấp/gia hạn gói. Cùng gói còn hạn → cộng dồn từ ngày hết hạn; khác gói hoặc đã hết hạn → tính từ bây giờ. */
export async function grantPlan(pool, { uid, email = null, plan, months }) {
  if (!['pro', 'max'].includes(plan) || !(months > 0)) throw new Error('bad_grant');
  await pool.query('INSERT IGNORE INTO users (firebase_uid, email) VALUES (?, ?)', [uid, email]);
  const [[u]] = await pool.query('SELECT plan, plan_expires_at FROM users WHERE firebase_uid = ?', [uid]);
  const now = new Date();
  const cur = u && u.plan_expires_at ? new Date(u.plan_expires_at) : null;
  const base = u && u.plan === plan && cur && cur > now ? cur : now;
  const exp = addMonths(base, months);
  await pool.query('UPDATE users SET plan = ?, plan_expires_at = ? WHERE firebase_uid = ?', [plan, exp, uid]);
  return exp;
}

export async function createOrder(pool, user, plan, period) {
  const amount = PRICES[plan] && PRICES[plan][period];
  if (!amount) throw Object.assign(new Error('bad_plan'), { code: 'bad_plan' });
  const [[ex]] = await pool.query(
    "SELECT * FROM orders WHERE firebase_uid = ? AND plan = ? AND plan_period = ? AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    [user.uid, plan, period],
  );
  if (ex) return ex;
  // Người dùng chọn lại gói/kỳ hạn: các đơn chờ KHÁC bị thay thế (vẫn nhận tiền nếu lỡ chuyển — xem approveOrder cho phép 'cancelled').
  await pool.query("UPDATE orders SET status = 'cancelled', note = 'Thay bằng đơn mới' WHERE firebase_uid = ? AND status = 'pending'", [user.uid]);
  for (let i = 0; i < 5; i++) {
    const code = 'CHM' + rnd(6);
    try {
      await pool.query(
        'INSERT INTO orders (code, firebase_uid, email, plan, plan_period, amount, expires_at) VALUES (?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
        [code, user.uid, user.email || null, plan, period, amount, ORDER_TTL_HOURS],
      );
      const [[row]] = await pool.query('SELECT * FROM orders WHERE code = ?', [code]);
      return row;
    } catch (e) { if (e.errno !== 1062) throw e; }
  }
  throw new Error('order_code_collision');
}

/** Đơn nạp credit: dùng cột plan='topup', plan_period='once'. */
export async function createTopupOrder(pool, user, packKey) {
  const pack = PACKS[packKey];
  if (!pack) throw Object.assign(new Error('bad_pack'), { code: 'bad_pack' });
  const [[ex]] = await pool.query(
    "SELECT * FROM orders WHERE firebase_uid = ? AND kind = 'topup' AND credits = ? AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    [user.uid, pack.credits]);
  if (ex) return ex;
  await pool.query("UPDATE orders SET status = 'cancelled', note = 'Thay bằng đơn mới' WHERE firebase_uid = ? AND status = 'pending'", [user.uid]);
  for (let i = 0; i < 5; i++) {
    const code = 'CHM' + rnd(6);
    try {
      await pool.query(
        "INSERT INTO orders (code, firebase_uid, email, plan, plan_period, amount, kind, credits, expires_at) VALUES (?,?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
        [code, user.uid, user.email || null, 'topup', 'once', pack.amount, 'topup', pack.credits, ORDER_TTL_HOURS]);
      const [[row]] = await pool.query('SELECT * FROM orders WHERE code = ?', [code]);
      return row;
    } catch (e) { if (e.errno !== 1062) throw e; }
  }
  throw new Error('order_code_collision');
}

export async function getOrder(pool, code) {
  const [[row]] = await pool.query('SELECT * FROM orders WHERE code = ?', [String(code).toUpperCase()]);
  return row || null;
}
/** Người dùng tự huỷ đơn chờ để chọn lại gói. */
export async function cancelOwnOrder(pool, code, uid) {
  const [res] = await pool.query(
    "UPDATE orders SET status = 'cancelled', note = 'Người dùng huỷ' WHERE code = ? AND firebase_uid = ? AND status = 'pending'",
    [String(code).toUpperCase(), uid],
  );
  return res.affectedRows > 0;
}
export async function listMine(pool, uid, limit = 10) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE firebase_uid = ? ORDER BY created_at DESC LIMIT ?', [uid, limit]);
  return rows;
}
export async function listAdmin(pool, status = 'pending', limit = 100) {
  const [rows] = await pool.query('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, limit]);
  return rows;
}

/** Duyệt đơn (idempotent): chỉ đơn pending mới được kích hoạt; trả { order, expires } hoặc null nếu không áp dụng. */
export async function approveOrder(pool, code, { method, bankRef = null, paidAmount = null, note = null }) {
  const [res] = await pool.query(
    "UPDATE orders SET status = 'paid', method = ?, bank_ref = ?, paid_amount = ?, note = ?, paid_at = NOW() WHERE code = ? AND status IN ('pending', 'cancelled')",
    [method, bankRef, paidAmount, note, String(code).toUpperCase()],
  );
  if (!res.affectedRows) return null;
  const order = await getOrder(pool, code);
  const months = PERIOD_MONTHS[order.plan_period] || 1;
  try {
    if (order.kind === 'topup') {
      await aiBudget.addCredits({ uid: order.firebase_uid, credits: order.credits, reason: 'topup', ref: `order-${order.code}`, pool });
      return { order, expires: null };
    }
    const expires = await grantPlan(pool, { uid: order.firebase_uid, email: order.email, plan: order.plan, months });
    return { order, expires };
  } catch (e) {
    // Không để đơn "đã trả" mà gói chưa được cấp: trả đơn về chờ (kèm ghi chú) để webhook thử lại / quản trị viên xử lý.
    await pool.query("UPDATE orders SET status = 'pending', method = NULL, bank_ref = NULL, paid_amount = NULL, paid_at = NULL, note = ? WHERE code = ?",
      [`Lỗi kích hoạt gói: ${String(e.message).slice(0, 150)}`, String(code).toUpperCase()]).catch(() => {});
    throw e;
  }
}

export async function rejectOrder(pool, code, note = null) {
  const [res] = await pool.query("UPDATE orders SET status = 'rejected', note = ? WHERE code = ? AND status IN ('pending', 'cancelled')", [note, String(code).toUpperCase()]);
  return res.affectedRows > 0;
}

/** Từ nội dung chuyển khoản tìm mã đơn (bỏ khoảng trắng/dấu gạch vì ngân hàng có thể chèn). */
export function findCode(text) {
  const s = String(text || '').toUpperCase().replace(/[\s\-_.]/g, '');
  const m = s.match(/CHM[A-HJKMNP-Z2-9]{6}/);
  return m ? m[0] : null;
}

/**
 * Xử lý một giao dịch tiền VÀO từ webhook. Trả { matched, status } — luôn an toàn khi gọi lặp.
 * Chỉ tự duyệt khi số tiền >= số tiền đơn; thiếu tiền → để pending và ghi chú cho quản trị viên.
 */
export async function handleIncomingTransfer(pool, { content, amount, ref }) {
  const code = findCode(content);
  if (!code) return { matched: false, status: 'no_code' };
  if (ref) {
    const [[dup]] = await pool.query('SELECT code FROM orders WHERE bank_ref = ?', [String(ref)]);
    if (dup) return { matched: true, status: 'duplicate', code: dup.code };
  }
  const order = await getOrder(pool, code);
  if (!order) return { matched: false, status: 'unknown_code', code };
  if (order.status !== 'pending' && order.status !== 'cancelled') return { matched: true, status: 'already_' + order.status, code };
  if (Number(amount) < order.amount) {
    await pool.query("UPDATE orders SET note = ? WHERE code = ? AND status IN ('pending', 'cancelled')", [`Thiếu tiền: nhận ${amount}/${order.amount}`, code]);
    return { matched: true, status: 'underpaid', code };
  }
  const r = await approveOrder(pool, code, { method: 'bank_auto', bankRef: ref ? String(ref) : null, paidAmount: Number(amount) });
  return { matched: true, status: r ? 'approved' : 'race', code };
}

// ===== Mã kích hoạt =====
export async function createCodes(pool, { plan, months, count, by }) {
  if (!['pro', 'max'].includes(plan) || !(months > 0)) throw new Error('bad_code');
  const out = [];
  for (let i = 0; i < Math.min(Math.max(1, count), 100); i++) {
    for (let k = 0; k < 5; k++) {
      const code = `CH-${rnd(4)}-${rnd(4)}`;
      try {
        await pool.query('INSERT INTO redeem_codes (code, plan, months, created_by) VALUES (?,?,?,?)', [code, plan, months, by || null]);
        out.push({ code, plan, months });
        break;
      } catch (e) { if (e.errno !== 1062) throw e; }
    }
  }
  return out;
}
export async function listCodes(pool, limit = 100) {
  const [rows] = await pool.query('SELECT * FROM redeem_codes ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows;
}
export async function redeem(pool, user, rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/\s+/g, '');
  const [res] = await pool.query('UPDATE redeem_codes SET used_by_uid = ?, used_at = NOW() WHERE code = ? AND used_by_uid IS NULL', [user.uid, code]);
  if (!res.affectedRows) return null;
  const [[row]] = await pool.query('SELECT plan, months FROM redeem_codes WHERE code = ?', [code]);
  const expires = await grantPlan(pool, { uid: user.uid, email: user.email, plan: row.plan, months: row.months });
  return { plan: row.plan, months: row.months, expires };
}

/**
 * Đọc email "biến động số dư" của ngân hàng (do Apps Script trong hộp thư nhận tiền chuyển lên).
 * Khuôn email có thể đổi nên bộ đọc DUNG THỨ: mã đơn tìm trong toàn văn; số tiền = số có đơn vị VND/₫/đ
 * (ưu tiên số có dấu '+'). Không đọc được số tiền → KHÔNG tự duyệt, chỉ ghi chú để quản trị viên xem.
 */
export function parseBankEmail(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const code = findCode(t);
  const re = /([+\-]?)\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+)\s*(?:VND|VNĐ|₫|đồng|đ)(?!\p{L})/giu;
  let m; const all = [];
  while ((m = re.exec(t))) all.push({ sign: m[1], n: Number(m[2].replace(/[.,\s]/g, '')) });
  const plus = all.find((x) => x.sign === '+');
  return { code, amounts: all.filter((x) => x.sign !== '-').map((x) => x.n), plusAmount: plus ? plus.n : null,
    incoming: !!plus || /(ghi\s*có|tiền\s*vào|nhận\s*(được\s*)?tiền|đã\s*nhận|credit)/i.test(t),
    outgoing: all.some((x) => x.sign === '-') || /(ghi\s*nợ|chuyển\s*tiền\s*đi|biên\s*lai|chuyển\s*khoản\s*thành\s*công|giao\s*dịch\s*chuyển|debit)/i.test(t) };
}

/**
 * Xử lý một email báo tiền. Chống duyệt nhầm do đọc phải SỐ DƯ: chỉ duyệt khi MỘT số tiền trong thư bằng ĐÚNG số tiền đơn
 * (hoặc số có dấu '+' không nhỏ hơn). Còn lại → để chờ kèm ghi chú cho quản trị viên.
 */
export async function handleBankEmail(pool, { messageId, subject, body }) {
  const p = parseBankEmail(`${subject || ''}\n${body || ''}`);
  if (!p.code) return { matched: false, status: 'no_code' };
  const order = await getOrder(pool, p.code);
  if (!order) return { matched: false, status: 'unknown_code', code: p.code };
  // Biên lai chuyển tiền ĐI, hoặc thư không có dấu hiệu tiền VÀO → không bao giờ tự duyệt (để quản trị viên xem).
  if (p.outgoing || !p.incoming) {
    await pool.query("UPDATE orders SET note = ? WHERE code = ? AND status IN ('pending', 'cancelled')", [p.outgoing ? 'Email là biên lai chuyển tiền đi — bỏ qua' : 'Email không rõ là tiền vào — kiểm tra rồi Duyệt', p.code]);
    return { matched: true, status: p.outgoing ? 'outgoing_ignored' : 'not_incoming', code: p.code };
  }
  const note = async (txt) => { await pool.query("UPDATE orders SET note = ? WHERE code = ? AND status IN ('pending', 'cancelled')", [txt, p.code]); };
  let amount = null;
  if (p.amounts.includes(order.amount)) amount = order.amount;
  else if (p.plusAmount != null && p.plusAmount >= order.amount) amount = p.plusAmount;
  else if (p.plusAmount != null) { await note(`Thiếu tiền: email báo ${p.plusAmount}/${order.amount}`); return { matched: true, status: 'underpaid', code: p.code }; }
  if (amount == null) { await note('Email báo có tiền nhưng chưa đối chiếu được số tiền — kiểm tra rồi Duyệt'); return { matched: true, status: 'amount_unreadable', code: p.code }; }
  return handleIncomingTransfer(pool, { content: p.code, amount, ref: `email-${String(messageId || p.code + amount).slice(0, 60)}` });
}
