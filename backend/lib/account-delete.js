/**
 * account-delete.js — xoá tài khoản người dùng (Apple 5.1.1(v), Google Play "Account deletion").
 * Xoá dữ liệu gắn với tài khoản trong MySQL; bản ghi thanh toán giữ lại ở dạng ẩn danh (nghĩa vụ kế toán);
 * dữ liệu dùng chung không gắn người (từ điển AI, bộ đệm giọng đọc…) được gỡ liên kết người tạo.
 * Xoá user Firebase do route gọi sau khi hàm này xong.
 */
const DELETE_BY_UID = [
  ['ai_credits', 'firebase_uid'], ['ai_credit_txn', 'firebase_uid'], ['ai_ledger', 'firebase_uid'], ['ai_lookup_usage', 'firebase_uid'],
  ['laoshi_usage', 'firebase_uid'], ['laoshi_faq_askers', 'firebase_uid'], ['asr_fix_votes', 'firebase_uid'],
  ['quick_usage', 'firebase_uid'], ['term_feedback', 'firebase_uid'],
];
const ANONYMIZE = [
  ['ai_lookup', 'created_by'], ['laoshi_faq', 'created_by'], ['redeem_codes', 'used_by_uid'],
];
const ignoreMissing = (e) => { if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR')) return; throw e; };

export async function deleteAccountData(pool, uid) {
  const out = { deleted: {}, anonymized: {} };
  const run = async (sql, params, bucket, key) => {
    try { const [r] = await pool.query(sql, params); out[bucket][key] = (r && r.affectedRows) || 0; } catch (e) { ignoreMissing(e); }
  };
  // Tài liệu riêng + giọng đọc của tài liệu
  try {
    const [docs] = await pool.query('SELECT id FROM user_documents WHERE user_uid = ?', [uid]);
    const ids = docs.map((d) => d.id);
    if (ids.length) await run('DELETE FROM user_document_audio WHERE doc_id IN (?)', [ids], 'deleted', 'user_document_audio');
    await run('DELETE FROM user_documents WHERE user_uid = ?', [uid], 'deleted', 'user_documents');
  } catch (e) { ignoreMissing(e); }
  for (const [tbl, col] of DELETE_BY_UID) await run(`DELETE FROM ${tbl} WHERE ${col} = ?`, [uid], 'deleted', tbl);
  for (const [tbl, col] of ANONYMIZE) await run(`UPDATE ${tbl} SET ${col} = NULL WHERE ${col} = ?`, [uid], 'anonymized', tbl);
  // Bản ghi thanh toán: giữ để đối soát kế toán nhưng bỏ email, thay mã người dùng bằng mã băm không đảo ngược được
  await run("UPDATE orders SET email = NULL, firebase_uid = CONCAT('deleted-', SUBSTRING(SHA2(firebase_uid, 256), 1, 24)) WHERE firebase_uid = ?", [uid], 'anonymized', 'orders');
  // Hồ sơ người dùng (các bảng user_favorites/progress/settings/... xoá theo khoá ngoại ON DELETE CASCADE)
  await run('DELETE FROM users WHERE firebase_uid = ?', [uid], 'deleted', 'users');
  return out;
}
