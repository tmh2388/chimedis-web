/**
 * plan.js — gói dịch vụ (free < pro < max) và quyền theo gói.
 *
 * Quyền hiện tại:
 *  - free (đã đăng nhập): nghe audio, ghi âm và nghe lại giọng mình.
 *  - pro : + phân tích AI (chấm điểm/đối chiếu ý), + "Tự Thêm" (tải tài liệu riêng, AI tự biên tập, tạo audio).
 *  - max : như pro, hạn mức lớn hơn.
 *
 * Gói xác định theo thứ tự: PRO_EMAILS/MAX_EMAILS (biến môi trường, phẩy) → cột users.plan (còn hạn) → free.
 * Mặc định PRO_EMAILS = chủ dự án (tmh2388@gmail.com) theo yêu cầu 2026-10-11 cho tới khi có thanh toán thật.
 */
export const PLANS = ['free', 'pro', 'max'];

export const LIMITS = {
  free: { docs: 0, docsPerDay: 0, charsPerDoc: 0 },
  pro: { docs: 15, docsPerDay: 5, charsPerDoc: 6000 },
  max: { docs: 60, docsPerDay: 20, charsPerDoc: 20000 },
};

export function normalizePlan(p) { return PLANS.includes(p) ? p : 'free'; }
export function atLeast(plan, min) { return PLANS.indexOf(normalizePlan(plan)) >= PLANS.indexOf(min); }

const csv = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export function planFromEnv(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return null;
  if (csv(process.env.MAX_EMAILS).includes(e)) return 'max';
  if (csv(process.env.PRO_EMAILS || 'tmh2388@gmail.com').includes(e)) return 'pro';
  return null;
}

/** Gói hiện hành của người dùng Firebase (không ném lỗi: mọi sự cố → 'free'). */
export async function resolvePlan(pool, fbUser) {
  if (!fbUser) return 'free';
  const fromEnv = planFromEnv(fbUser.email);
  if (fromEnv) return fromEnv;
  if (!pool) return 'free';
  try {
    const [rows] = await pool.query('SELECT plan, plan_expires_at FROM users WHERE firebase_uid = ? LIMIT 1', [fbUser.uid]);
    const r = rows && rows[0];
    if (!r) return 'free';
    if (r.plan_expires_at && new Date(r.plan_expires_at).getTime() < Date.now()) return 'free';
    return normalizePlan(r.plan);
  } catch (_) {
    return 'free';
  }
}

/** Middleware: yêu cầu gói tối thiểu `min` (đặt SAU verifyFirebaseToken). */
export function requirePlan(pool, min) {
  return async (req, res, next) => {
    const plan = await resolvePlan(pool, req.firebaseUser);
    req.plan = plan;
    if (!atLeast(plan, min)) {
      return res.status(403).json({ success: false, error: 'pro_required', plan, required: min });
    }
    next();
  };
}

/** Thêm cột plan vào bảng users nếu chưa có (idempotent). */
export async function ensurePlanColumns(pool) {
  if (!pool) return;
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN plan VARCHAR(16) NOT NULL DEFAULT 'free'",
    'ALTER TABLE users ADD COLUMN plan_expires_at DATETIME NULL',
  ]) {
    try { await pool.query(ddl); } catch (e) { if (e && e.errno !== 1060) console.error('plan: ', e.message); }
  }
}
