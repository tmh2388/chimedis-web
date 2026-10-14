/**
 * ai-budget.js — NGÂN SÁCH AI/TTS dùng chung của một người dùng, cho CẢ dict.chimedis.vn và workbench (chimedis.vn).
 *
 * FILE NÀY ĐƯỢC SAO NGUYÊN VĂN ở hai repo (chimedis-web/backend/lib và chimedis-home/lib). Sửa một nơi thì sửa cả hai.
 * Nguồn sự thật = cùng MySQL, cùng người dùng (firebase_uid):
 *   ai_ledger      mỗi lần tốn chi phí (micro-USD) — mọi ứng dụng cùng ghi vào đây
 *   ai_credits     số dư credit nạp thêm + mốc đã "chốt" phần vượt hạn mức tháng
 *   ai_credit_txn  sổ nạp credit (cộng) — để đối soát
 *
 * Quy tắc:
 *   - Hạn mức THÁNG theo gói (free/pro/max). Thêm hạn mức NGÀY (12% tháng) và GIỜ (6% tháng, cuốn chiếu 60 phút) để không ai
 *     dùng hết cả tháng trong vài ngày/giờ.
 *   - Hết hạn mức tháng: dùng credit đã nạp (không bị chặn theo ngày/giờ vì đã trả tiền); hết credit thì chặn đến tháng sau.
 *   - 1 credit = 0,001 USD chi phí nhà cung cấp (đổi 2026-10-14 từ 0,01: số credit hiển thị ×10 cho dễ hình dung, giá trị tiền không đổi).
 * Giá bên dưới là ƯỚC LƯỢNG chi phí (không phải giá bán).
 */
export const CREDIT_MICRO = 1000; // 1 credit = $0.001 = 1.000 micro-USD
export const CREDITS_PER_USD = 1e6 / CREDIT_MICRO; // 1.000
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

export const PLAN_BUDGET_USD = {
  free: envNum('AI_BUDGET_FREE', 2),
  pro: envNum('AI_BUDGET_PRO', 2),
  max: envNum('AI_BUDGET_MAX', 4),
};
export const DAY_FRACTION = envNum('AI_DAY_FRACTION', 0.12);   // tối đa 12% hạn mức tháng mỗi ngày
export const HOUR_FRACTION = envNum('AI_HOUR_FRACTION', 0.06); // tối đa 6% hạn mức tháng mỗi 60 phút

// ---- Ước lượng chi phí (USD) ----
const TOKEN_PRICE = { // USD / 1M token
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-audio-mini': { in: 0.6, out: 2.4, audioIn: 10, audioOut: 20 },
};
const TTS_PRICE_PER_MCHAR = { wavenet: 16, chirp: 30, openai: 15 };

export function costFromUsage(model, usage) {
  const p = TOKEN_PRICE[model];
  if (!p || !usage) return 0;
  const audioIn = (usage.prompt_tokens_details && usage.prompt_tokens_details.audio_tokens) || 0;
  const audioOut = (usage.completion_tokens_details && usage.completion_tokens_details.audio_tokens) || 0;
  const textIn = Math.max(0, (usage.prompt_tokens || 0) - audioIn);
  const textOut = Math.max(0, (usage.completion_tokens || 0) - audioOut);
  return (textIn * p.in + textOut * p.out + audioIn * (p.audioIn || p.in) + audioOut * (p.audioOut || p.out)) / 1e6;
}
/** kind: 'wavenet' | 'chirp' | 'openai' */
export function costForTts(chars, kind = 'chirp') {
  return (Math.max(0, chars) * (TTS_PRICE_PER_MCHAR[kind] || TTS_PRICE_PER_MCHAR.chirp)) / 1e6;
}

// ---- Bảng + trạng thái ----
let sharedPool = null;
export function init(pool) { sharedPool = pool || null; }

export async function ensureTables(pool = sharedPool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_ledger (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, firebase_uid VARCHAR(128) NOT NULL, app VARCHAR(16) NOT NULL,
    feature VARCHAR(40) NOT NULL, cost_micro BIGINT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_uid_time (firebase_uid, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_credits (
    firebase_uid VARCHAR(128) NOT NULL PRIMARY KEY, balance_micro BIGINT NOT NULL DEFAULT 0,
    settled_month CHAR(7) NULL, settled_micro BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_credit_txn (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, firebase_uid VARCHAR(128) NOT NULL, delta_micro BIGINT NOT NULL,
    reason VARCHAR(24) NOT NULL, ref VARCHAR(80) NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_uid (firebase_uid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const usd = (micro) => micro / 1e6;

/**
 * Trạng thái ngân sách của người dùng (và tự "chốt" phần vượt hạn mức tháng vào credit).
 * @returns {Promise<{state:'ok'|'hour'|'day'|'month', plan, monthLimit, usedMonth, dayLimit, usedDay, hourLimit, usedHour,
 *   creditsMicro:number, credits:number, usingCredits:boolean, retryAfterS:number|null}>}  (số tiền theo USD)
 */
export async function getBudget({ uid, plan = 'free', pool = sharedPool }) {
  const monthLimit = PLAN_BUDGET_USD[plan] ?? PLAN_BUDGET_USD.free;
  const limMicro = Math.round(monthLimit * 1e6);
  const dayLimit = monthLimit * DAY_FRACTION, hourLimit = monthLimit * HOUR_FRACTION;
  const base = { plan, monthLimit, dayLimit, hourLimit, usedMonth: 0, usedDay: 0, usedHour: 0, creditsMicro: 0, credits: 0, usingCredits: false, retryAfterS: null, state: 'ok' };
  if (!pool || !uid) return base;

  const [[u]] = await pool.query(
    `SELECT COALESCE(SUM(cost_micro),0) AS m,
            COALESCE(SUM(CASE WHEN created_at >= CURDATE() THEN cost_micro END),0) AS d,
            COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL 1 HOUR THEN cost_micro END),0) AS h,
            TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(CURDATE(), INTERVAL 1 DAY)) AS day_reset_s,
            TIMESTAMPDIFF(SECOND, NOW(), MIN(CASE WHEN created_at >= NOW() - INTERVAL 1 HOUR THEN created_at END) + INTERVAL 1 HOUR) AS hour_reset_s,
            DATE_FORMAT(NOW(), '%Y-%m') AS ym
     FROM ai_ledger WHERE firebase_uid = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`, [uid]);
  const usedM = Number(u.m), usedD = Number(u.d), usedH = Number(u.h);

  // Chốt phần vượt hạn mức tháng vào số dư credit (lười: mỗi lần kiểm tra). Có khoá lạc quan để hai ứng dụng không trừ trùng.
  await pool.query('INSERT IGNORE INTO ai_credits (firebase_uid) VALUES (?)', [uid]);
  let [[c]] = await pool.query('SELECT balance_micro, settled_month, settled_micro FROM ai_credits WHERE firebase_uid = ?', [uid]);
  const settledNow = c.settled_month === u.ym ? Number(c.settled_micro) : 0;
  const overage = Math.max(0, usedM - limMicro);
  let balance = Number(c.balance_micro);
  if (overage > settledNow) {
    const delta = overage - settledNow;
    const [r] = await pool.query(
      'UPDATE ai_credits SET balance_micro = balance_micro - ?, settled_month = ?, settled_micro = ? WHERE firebase_uid = ? AND settled_micro = ? AND (settled_month <=> ?)',
      [delta, u.ym, overage, uid, c.settled_micro, c.settled_month]);
    if (r.affectedRows) balance -= delta;
    else { const [[c2]] = await pool.query('SELECT balance_micro FROM ai_credits WHERE firebase_uid = ?', [uid]); balance = Number(c2.balance_micro); }
  } else if (c.settled_month !== u.ym && settledNow === 0 && c.settled_month) {
    await pool.query('UPDATE ai_credits SET settled_month = ?, settled_micro = 0 WHERE firebase_uid = ? AND settled_month <> ?', [u.ym, uid, u.ym]);
  }

  const out = { ...base, usedMonth: usd(usedM), usedDay: usd(usedD), usedHour: usd(usedH), creditsMicro: balance, credits: Math.max(0, Math.floor(balance / CREDIT_MICRO)) };
  if (usedM >= limMicro) {
    out.usingCredits = true;
    if (balance <= 0) { out.state = 'month'; }
  } else if (usedH >= Math.round(hourLimit * 1e6)) {
    out.state = 'hour'; out.retryAfterS = Math.max(60, Number(u.hour_reset_s) || 3600);
  } else if (usedD >= Math.round(dayLimit * 1e6)) {
    out.state = 'day'; out.retryAfterS = Math.max(60, Number(u.day_reset_s) || 3600);
  }
  return out;
}

/** Ghi một lần tốn chi phí (USD). Không ném lỗi — ghi sổ hỏng không được làm hỏng tính năng. */
export async function charge({ uid, app, feature, costUsd, pool = sharedPool }) {
  if (!pool || !uid || !(costUsd > 0)) return;
  try {
    await pool.query('INSERT INTO ai_ledger (firebase_uid, app, feature, cost_micro) VALUES (?,?,?,?)', [uid, String(app).slice(0, 16), String(feature).slice(0, 40), Math.round(costUsd * 1e6)]);
  } catch (e) { console.error('[ai-budget] charge:', e.message); }
}

/** Cộng credit đã mua (ref duy nhất → gọi lại không cộng trùng). Trả true nếu có cộng. */
export async function addCredits({ uid, credits, reason = 'topup', ref = null, pool = sharedPool }) {
  if (!pool || !uid || !Number.isFinite(credits) || credits === 0) return false;
  const micro = Math.round(credits * CREDIT_MICRO);
  try {
    await pool.query('INSERT INTO ai_credit_txn (firebase_uid, delta_micro, reason, ref) VALUES (?,?,?,?)', [uid, micro, reason, ref]);
  } catch (e) { if (e.errno === 1062) return false; throw e; }
  await pool.query('INSERT IGNORE INTO ai_credits (firebase_uid) VALUES (?)', [uid]);
  await pool.query('UPDATE ai_credits SET balance_micro = balance_micro + ? WHERE firebase_uid = ?', [micro, uid]);
  return true;
}

/** Dạng gọn gửi cho giao diện (credit làm tròn, USD 2 chữ số). */
export function publicView(b) {
  const toCr = (u) => Math.round(u * CREDITS_PER_USD * 10) / 10; // USD → credit, làm tròn 0,1 (tránh hiển thị 0 rồi nhảy 1)
  return {
    state: b.state, plan: b.plan, usingCredits: b.usingCredits, retryAfterS: b.retryAfterS,
    month: { used: toCr(b.usedMonth), limit: toCr(b.monthLimit) },
    day: { used: toCr(b.usedDay), limit: toCr(b.dayLimit) },
    hour: { used: toCr(b.usedHour), limit: toCr(b.hourLimit) },
    credits: b.credits,
  };
}
