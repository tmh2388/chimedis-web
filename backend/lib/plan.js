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

/** Quản trị viên tối cao (ADMIN_EMAILS, mặc định chủ dự án): luôn ở gói cao nhất, không hết hạn. */
export function isSupremeEmail(email) {
  const e = String(email || '').toLowerCase();
  return !!e && csv(process.env.ADMIN_EMAILS || 'tmh2388@gmail.com').includes(e);
}

export function planFromEnv(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return null;
  if (isSupremeEmail(e)) return 'max';
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
  return (await planInfo(pool, fbUser)).plan;
}

/** Đọc plan/hạn/role; cột `role` (workbench) có thể chưa tồn tại nên thử lần lượt. */
async function readUserPlanRow(pool, uid) {
  try {
    const [rows] = await pool.query('SELECT plan, plan_expires_at, role FROM users WHERE firebase_uid = ? LIMIT 1', [uid]);
    return rows && rows[0];
  } catch (_) {
    const [rows] = await pool.query('SELECT plan, plan_expires_at FROM users WHERE firebase_uid = ? LIMIT 1', [uid]);
    return rows && rows[0];
  }
}

/** Gói + ngày hết hạn (nếu có) để hiện trong tài khoản. source: 'env' (không hết hạn) | 'db' | 'none'. */
export async function planInfo(pool, fbUser) {
  const base = { plan: 'free', expires_at: null, source: 'none' };
  if (!fbUser) return base;
  const fromEnv = fbUser.emailVerified ? planFromEnv(fbUser.email) : null;
  if (fromEnv) return { plan: fromEnv, expires_at: null, source: isSupremeEmail(fbUser.email) ? 'admin' : 'env' };
  if (!pool) return base;
  try {
    const r = await readUserPlanRow(pool, fbUser.uid);
    if (!r) return base;
    // Tài khoản admin (cột users.role dùng chung với workbench) luôn là gói cao nhất, không hết hạn.
    if (String(r.role || '').toLowerCase() === 'admin') return { plan: 'max', expires_at: null, source: 'admin' };
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
  // Bảng `users` DÙNG CHUNG với workbench (chimedis-home): KIỂM TRA TRƯỚC, chỉ ALTER khi thật sự thiếu/sai kiểu — lần khởi
  // động bình thường không chạm DDL nên không tranh khoá bảng với migration của workbench (nghi vấn gây 503).
  let cols = [];
  try {
    const [rows] = await pool.query(
      "SELECT COLUMN_NAME AS n, DATA_TYPE AS dt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('plan', 'plan_expires_at')");
    cols = rows || [];
  } catch (e) { console.error('plan: đọc cấu trúc users lỗi:', e.message); return; }
  const byName = new Map(cols.map((c) => [c.n, String(c.dt).toLowerCase()]));
  const ddls = [];
  if (!byName.has('plan')) ddls.push("ALTER TABLE users ADD COLUMN plan VARCHAR(16) NOT NULL DEFAULT 'free'");
  else if (byName.get('plan') === 'enum') {
    // Migration m4 của workbench tạo `plan` dạng ENUM('free','pro'); dict cần thêm 'max' → nới thành VARCHAR(16).
    // 'free'/'pro' giữ nguyên nên workbench đọc vẫn đúng.
    ddls.push("ALTER TABLE users MODIFY COLUMN plan VARCHAR(16) NOT NULL DEFAULT 'free'");
  }
  if (!byName.has('plan_expires_at')) ddls.push('ALTER TABLE users ADD COLUMN plan_expires_at DATETIME NULL');
  for (const ddl of ddls) {
    try { await pool.query(ddl); console.log('plan: đã chạy:', ddl.slice(0, 70)); }
    catch (e) { if (e && e.errno !== 1060) console.error('plan:', e.message); }
  }
}
