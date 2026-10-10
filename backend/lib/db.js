/**
 * db.js — kết nối MySQL của dict, tự phục hồi (cùng quy ước với chimedis-home/lib/db.js, docs/INFRA-MYSQL.md).
 *
 * - Thử lần lượt: MYSQL_HOST → MYSQL_HOST_FALLBACK (nhiều giá trị, cách nhau dấu phẩy) → 'localhost'.
 * - Luôn nối bằng IPv4: đổi hostname → địa chỉ IPv4 (dns.lookup family 4) trước khi tạo kết nối.
 * - Tự kiểm tra lại mỗi 30 giây; hỏng thì chuyển sang ứng viên chạy được, khỏi thì báo qua onDbUp().
 * - Mỗi lần ĐỔI trạng thái ghi đúng 1 dòng log; dbStatus() an toàn để công khai (không host/user/mật khẩu).
 *
 * `mysqlPool` là lớp bọc mỏng có .query() như pool mysql2 — mọi truy vấn nghiệp vụ trong server.js giữ nguyên.
 */
import dns from 'node:dns';
import mysql from 'mysql2/promise';

const CONFIGURED = !!process.env.MYSQL_HOST;
const PROBE_MS = Number(process.env.MYSQL_PROBE_MS) || 30_000;

const CANDIDATES = [...new Set([
  process.env.MYSQL_HOST,
  ...String(process.env.MYSQL_HOST_FALLBACK || '').split(','),
  'localhost',
].map((x) => String(x || '').trim()).filter(Boolean))];

export async function resolveIPv4(host) {
  if (!host) return host;
  try { return (await dns.promises.lookup(host, { family: 4 })).address || host; }
  catch { return host; }
}

function makePool(host) {
  return mysql.createPool({
    host,
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectionLimit: 5,
    connectTimeout: 10_000,
  });
}

let pool = null;
const status = { ok: false, active: null, lastError: null, attempts: [], checkedAt: null };
let lastLogged = null; // 'ok:<i>' | 'down' — chỉ log khi giá trị này đổi
const upHandlers = [];

function logState(state, line, isError) {
  if (state === lastLogged) return;
  lastLogged = state;
  (isError ? console.error : console.log)(line);
}

/** Đăng ký hàm chạy mỗi khi DB chuyển từ không ổn → ổn, hoặc đổi sang ứng viên khác. */
export function onDbUp(fn) { upHandlers.push(fn); }

async function tryCandidate(i) {
  const ip = await resolveIPv4(CANDIDATES[i]);
  const p = makePool(ip);
  try { await p.query('SELECT 1'); return p; }
  catch (e) { await p.end().catch(() => {}); throw e; }
}

let probing = null;
/** Kiểm tra kết nối hiện tại; hỏng thì thử lần lượt các ứng viên và đổi sang cái chạy được. */
export function probeDb() {
  if (!CONFIGURED) return Promise.resolve(false);
  if (probing) return probing;
  probing = (async () => {
    const attempts = [];
    const order = CANDIDATES.map((_, i) => i);
    if (status.active != null) order.sort((a, b) => (a === status.active ? -1 : b === status.active ? 1 : a - b));
    for (const i of order) {
      try {
        if (pool && status.active === i && status.ok) {
          await pool.query('SELECT 1');
          status.checkedAt = new Date().toISOString();
          status.attempts = [];
          return true;
        }
        const p = await tryCandidate(i);
        const old = pool;
        pool = p;
        if (old && old !== p) old.end().catch(() => {});
        const changed = status.active !== i || !status.ok;
        status.ok = true; status.active = i; status.lastError = null; status.attempts = [];
        status.checkedAt = new Date().toISOString();
        logState(`ok:${i}`, `db: MySQL OK qua ứng viên #${i}${i === 0 ? ' (MYSQL_HOST)' : ' (dự phòng)'} → IPv4`, false);
        if (changed) upHandlers.forEach((fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* bỏ qua */ } });
        return true;
      } catch (e) {
        // `from` = địa chỉ nguồn MySQL thấy (IP đi ra của app, có trong "Access denied for user 'u'@'<IP>'") — đúng địa
        // chỉ cần khai báo ở Remote MySQL. Không lộ host MySQL, user hay mật khẩu.
        const m = /@'([^']+)'/.exec(e.message || '');
        attempts.push({ candidate: i, code: e.code || 'UNKNOWN', ...(m ? { from: m[1] } : {}) });
        status.lastError = e.code || 'UNKNOWN';
        if (status.active === i) status.ok = false;
      }
    }
    status.ok = false; status.attempts = attempts; status.checkedAt = new Date().toISOString();
    logState('down', `db: KHÔNG kết nối được MySQL với mọi ứng viên ${JSON.stringify(attempts)} — thử lại mỗi ${Math.round(PROBE_MS / 1000)}s`, true);
    return false;
  })().finally(() => { probing = null; });
  return probing;
}

if (CONFIGURED) {
  // Dựng sẵn pool từ ứng viên đầu để truy vấn không gặp null trước khi lần kiểm tra đầu hoàn tất.
  pool = makePool(CANDIDATES[0]);
  status.active = 0;
  probeDb();
  setInterval(() => { probeDb(); }, PROBE_MS).unref();
}

/** Giống pool mysql2 ở mức .query(); luôn trỏ vào pool đang chạy. null nếu chưa cấu hình MYSQL_HOST. */
export const mysqlPool = CONFIGURED ? { query: (...args) => pool.query(...args) } : null;

export function dbStatus() {
  return {
    configured: CONFIGURED,
    ok: status.ok,
    activeCandidate: status.active,
    candidates: CANDIDATES.length,
    lastError: status.lastError,
    attempts: status.attempts,
    checkedAt: status.checkedAt,
  };
}
