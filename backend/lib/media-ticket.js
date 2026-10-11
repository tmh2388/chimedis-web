/**
 * media-ticket.js — vé truy cập audio ngắn hạn, ký HMAC, cấp cho người dùng ĐÃ ĐĂNG NHẬP.
 *
 * Thẻ <audio> không gửi được header Authorization, nên audio được bảo vệ bằng tham số ?t=<vé>.
 * Vé = base64url(uid).hạn.chữ-ký ; chữ ký = HMAC-SHA256(uid.hạn). Khoá: MEDIA_TICKET_SECRET, nếu không đặt thì
 * sinh ngẫu nhiên mỗi lần khởi động (mọi vé cũ vô hiệu → client tự xin vé mới khi gặp 401).
 */
import crypto from 'node:crypto';

const SECRET = process.env.MEDIA_TICKET_SECRET || crypto.randomBytes(32).toString('hex');
export const TICKET_TTL_SEC = 6 * 3600;

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function signTicket(uid, ttlSec = TICKET_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${Buffer.from(String(uid)).toString('base64url')}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Trả về { uid, exp } nếu vé hợp lệ và còn hạn, ngược lại null. */
export function verifyTicket(ticket) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3) return null;
  const [uidB64, expStr, sig] = parts;
  const expected = sign(`${uidB64}.${expStr}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  return { uid: Buffer.from(uidB64, 'base64url').toString('utf8'), exp };
}
