import admin from 'firebase-admin';

// Giống pattern mysqlPool trong server.js: Firebase Admin là TÙY CHỌN — nếu chưa cấu hình
// env var, app vẫn chạy bình thường (chỉ các route cần đăng nhập trả lỗi 503 rõ ràng thay vì
// crash toàn bộ server). Cho phép deploy code này trước khi user hoàn tất setup Firebase Console.
//
// FIREBASE_ADMIN_CREDENTIALS_JSON_B64: base64 1 dòng của file service account JSON (Firebase
// Console > Project settings > Service accounts > Generate new private key) — cùng lý do dùng
// base64 như GOOGLE_CREDENTIALS_JSON_B64 (xem reference_chimedis_infra): Hostinger deploy lại từ
// Git mỗi lần nên không giữ file upload tay, và ô nhập env var không chịu được JSON nhiều dòng.
let firebaseApp = null;
if (process.env.FIREBASE_ADMIN_CREDENTIALS_JSON_B64) {
  try {
    const json = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS_JSON_B64, 'base64').toString('utf8');
    const credentials = JSON.parse(json);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(credentials),
    });
  } catch (err) {
    console.error('⚠️  Không khởi tạo được Firebase Admin (kiểm tra FIREBASE_ADMIN_CREDENTIALS_JSON_B64):', err.message);
  }
}

export function isFirebaseConfigured() {
  return !!firebaseApp;
}

/**
 * Middleware: xác thực Firebase ID token trong header `Authorization: Bearer <token>`.
 * Thành công -> req.firebaseUser = { uid, email, name, picture }.
 * Thất bại -> 401. Chưa cấu hình Firebase Admin -> 503 (khác 401, để phân biệt rõ "chưa bật
 * tính năng đăng nhập" với "token sai/hết hạn" khi debug).
 */
export async function verifyFirebaseToken(req, res, next) {
  if (!firebaseApp) {
    return res.status(503).json({ success: false, error: 'Đăng nhập chưa được cấu hình trên server' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Thiếu token đăng nhập' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      picture: decoded.picture || null,
    };
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}
