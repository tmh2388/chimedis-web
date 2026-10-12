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

export const PRICES = {
  pro: { month: 99000, year: 990000 }, // năm = 10 tháng
  max: { month: 249000, year: 2490000 },
};
export const PERIOD_MONTHS = { month: 1, year: 12 };
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

export async function getOrder(pool, code) {
  const [[row]] = await pool.query('SELECT * FROM orders WHERE code = ?', [String(code).toUpperCase()]);
  return row || null;
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
    "UPDATE orders SET status = 'paid', method = ?, bank_ref = ?, paid_amount = ?, note = ?, paid_at = NOW() WHERE code = ? AND status = 'pending'",
    [method, bankRef, paidAmount, note, String(code).toUpperCase()],
  );
  if (!res.affectedRows) return null;
  const order = await getOrder(pool, code);
  const months = PERIOD_MONTHS[order.plan_period] || 1;
  const expires = await grantPlan(pool, { uid: order.firebase_uid, email: order.email, plan: order.plan, months });
  return { order, expires };
}

export async function rejectOrder(pool, code, note = null) {
  const [res] = await pool.query("UPDATE orders SET status = 'cancelled', note = ? WHERE code = ? AND status = 'pending'", [note, String(code).toUpperCase()]);
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
  if (order.status !== 'pending') return { matched: true, status: 'already_' + order.status, code };
  if (Number(amount) < order.amount) {
    await pool.query('UPDATE orders SET note = ? WHERE code = ? AND status = ?', [`Thiếu tiền: nhận ${amount}/${order.amount}`, code, 'pending']);
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
