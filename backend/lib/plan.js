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
  free: { docs: 0, docsPerDay: 0, charsPerDoc: 0, laoshiPerDay: 0 },
  pro: { docs: 15, docsPerDay: 5, charsPerDoc: 6000, laoshiPerDay: 0 },
  max: { docs: 60, docsPerDay: 20, charsPerDoc: 20000, laoshiPerDay: Number(process.env.LAOSHI_DAILY_LIMIT) || 60 },
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
  // Gói theo email (PRO_EMAILS/MAX_EMAILS) CHỈ áp dụng khi email đã xác minh — nếu không, ai đăng ký email/mật khẩu bằng
  // địa chỉ của chủ sở hữu (chưa verify) sẽ nghiễm nhiên có gói. Google/Apple/Facebook trả email_verified=true.
  const fromEnv = fbUser.emailVerified ? planFromEnv(fbUser.email) : null;
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

/** Gói + ngày hết hạn (nếu có) để hiện trong tài khoản. source: 'env' (không hết hạn) | 'db' | 'none'. */
export async function planInfo(pool, fbUser) {
  const base = { plan: 'free', expires_at: null, source: 'none' };
  if (!fbUser) return base;
  const fromEnv = fbUser.emailVerified ? planFromEnv(fbUser.email) : null;
  if (fromEnv) return { plan: fromEnv, expires_at: null, source: 'env' };
  if (!pool) return base;
  try {
    const [rows] = await pool.query('SELECT plan, plan_expires_at FROM users WHERE firebase_uid = ? LIMIT 1', [fbUser.uid]);
    const r = rows && rows[0];
    if (!r) return base;
    const exp = r.plan_expires_at ? new Date(r.plan_expires_at) : null;
    if (exp && exp.getTime() < Date.now()) return { plan: 'free', expires_at: exp.toISOString(), source: 'expired' };
    const plan = normalizePlan(r.plan);
    return { plan, expires_at: exp ? exp.toISOString() : null, source: plan === 'free' ? 'none' : 'db' };
  } catch (_) { return base; }
}

/** Quản trị viên (ADMIN_EMAILS, mặc định chủ dự án) — bắt buộc email đã xác minh. */
export function isAdmin(fbUser) {
  if (!fbUser || !fbUser.emailVerified || !fbUser.email) return false;
  return csv(process.env.ADMIN_EMAILS || 'tmh2388@gmail.com').includes(String(fbUser.email).toLowerCase());
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
  // Bảng `users` DÙNG CHUNG với workbench (chimedis-home). Migration m4 của workbench đã tạo `plan` dạng ENUM('free','pro');
  // dict cần thêm giá trị 'max' → nới thành VARCHAR(16). 'free'/'pro' giữ nguyên nên workbench đọc vẫn đúng.
  try {
    const [[c]] = await pool.query("SELECT DATA_TYPE AS dt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan'");
    if (c && String(c.dt).toLowerCase() === 'enum') {
      await pool.query("ALTER TABLE users MODIFY COLUMN plan VARCHAR(16) NOT NULL DEFAULT 'free'");
      console.log("plan: đã nới users.plan từ ENUM sang VARCHAR(16) (dùng chung với workbench)");
    }
  } catch (e) { console.error('plan: nới cột plan lỗi:', e.message); }
}
