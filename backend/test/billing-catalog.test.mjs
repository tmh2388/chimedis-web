// Chạy: MYSQL_PORT=3398 node backend/test/billing-catalog.test.mjs  (cần DB có bảng users/orders/apps/plans/plan_grants/entitlements/ai_*: db/m44-catalog.sql của chimedis-home)
import assert from 'node:assert/strict'; import mysql from 'mysql2/promise';
const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3398), user: 'root', database: 't', multipleStatements: true });
const billing = await import('../lib/billing.js'); const aiBudget = await import('../lib/ai-budget.js'); await aiBudget.ensureTables(pool); await billing.ensureTables(pool);
const U = 'c2-test-uid', code = (n) => 'CHMTESTS' + 'ABCDEFG'[n];
await pool.query("DELETE FROM orders WHERE code LIKE 'CHMTESTS%'"); await pool.query('DELETE FROM entitlements WHERE firebase_uid=?', [U]); await pool.query('DELETE FROM users WHERE firebase_uid=?', [U]); await pool.query("DELETE FROM plan_grants WHERE plan_id LIKE 'c2t_%'"); await pool.query("DELETE FROM plans WHERE id LIKE 'c2t_%'");
await pool.query("INSERT INTO plans (id, app_id, kind, name_vi, name_zh, name_en, price_vnd, period_days, ai_budget_usd, tier) VALUES ('c2t_ielts_pro','ielts','plan','a','a','a',99000,30,1.5,'pro'),('c2t_bundle','dict'||NULL,'bundle','b','b','b',158400,30,3,NULL),('c2t_topup',NULL,'topup','t','t','t',59000,NULL,0,NULL)".replace("'dict'||NULL", 'NULL'));
await pool.query("UPDATE plans SET credits_included=1000 WHERE id='c2t_topup'");
await pool.query("INSERT INTO plan_grants VALUES ('c2t_bundle','dict','pro'),('c2t_bundle','ielts','pro')");
const mk = async (n, planId, amount) => { await pool.query("INSERT INTO orders (code, firebase_uid, email, plan, plan_period, amount, expires_at, plan_id) VALUES (?,?, 'c2@t.vn','catalog','month',?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?)", [code(n), U, amount, planId]); return code(n); };
const days = (d) => Math.round((new Date(d) - Date.now()) / 86400000);
const ent = async (app) => (await pool.query('SELECT tier, expires_at FROM entitlements WHERE firebase_uid=? AND app_id=?', [U, app]))[0][0];

// 1. Gói lẻ IELTS: webhook đủ tiền → entitlement IELTS 30 ngày, dict KHÔNG đổi
let c = await mk(1, 'c2t_ielts_pro', 99000);
let r = await billing.handleIncomingTransfer(pool, { content: 'chuyen tien ' + c, amount: 99000, ref: 'bank-c2-1' }); assert.equal(r.status, 'approved');
let e = await ent('ielts'); assert.equal(e.tier, 'pro'); assert.ok(days(e.expires_at) >= 29 && days(e.expires_at) <= 30); assert.equal(await ent('dict'), undefined);
// 2. Webhook gọi lại cùng giao dịch → không cộng trùng
r = await billing.handleIncomingTransfer(pool, { content: c, amount: 99000, ref: 'bank-c2-1' }); assert.equal(r.status, 'duplicate'); assert.ok(days((await ent('ielts')).expires_at) <= 30);
// 3. Thiếu tiền → không cấp
c = await mk(2, 'c2t_ielts_pro', 99000); r = await billing.handleIncomingTransfer(pool, { content: c, amount: 50000, ref: 'bank-c2-2' }); assert.equal(r.status, 'underpaid');
// 4. Bundle: cấp cả dict + ielts; gia hạn IELTS cộng dồn (30 + 30); users.plan của dict đồng bộ
c = await mk(3, 'c2t_bundle', 158400); r = await billing.handleIncomingTransfer(pool, { content: c, amount: 158400, ref: 'bank-c2-3' }); assert.equal(r.status, 'approved');
assert.equal((await ent('dict')).tier, 'pro'); assert.ok(days((await ent('ielts')).expires_at) >= 59, 'cộng dồn từ hạn cũ');
const [[u]] = await pool.query('SELECT plan, plan_expires_at FROM users WHERE firebase_uid=?', [U]); assert.equal(u.plan, 'pro'); assert.ok(days(u.plan_expires_at) >= 29);
// 5. Nạp credit theo danh mục
c = await mk(4, 'c2t_topup', 59000); r = await billing.handleIncomingTransfer(pool, { content: c, amount: 59000, ref: 'bank-c2-4' }); assert.equal(r.status, 'approved');
const [[cr]] = await pool.query('SELECT balance_micro FROM ai_credits WHERE firebase_uid=?', [U]); assert.equal(Number(cr.balance_micro), 1000 * aiBudget.CREDIT_MICRO);
// 6. plan_id lạ → đơn trở về chờ (không mất tiền không gói), có ghi chú
c = await mk(5, 'khong_co', 1000); await assert.rejects(() => billing.approveOrder(pool, c, { method: 'admin' }));
const [[o]] = await pool.query('SELECT status, note FROM orders WHERE code=?', [c]); assert.equal(o.status, 'pending'); assert.match(o.note, /Lỗi kích hoạt/);
// 7. Đơn dict cũ (không plan_id) vẫn chạy đường cũ
await pool.query("INSERT INTO orders (code, firebase_uid, plan, plan_period, amount, expires_at) VALUES ('CHMTESTSG',?,'max','month',249000, DATE_ADD(NOW(), INTERVAL 1 DAY))", [U]);
r = await billing.handleIncomingTransfer(pool, { content: 'CHMTESTSG', amount: 249000, ref: 'bank-c2-6' }); assert.equal(r.status, 'approved');
const [[u2]] = await pool.query('SELECT plan FROM users WHERE firebase_uid=?', [U]); assert.equal(u2.plan, 'max');
await pool.query("DELETE FROM orders WHERE code LIKE 'CHMTESTS%'"); await pool.query('DELETE FROM entitlements WHERE firebase_uid=?', [U]); await pool.query('DELETE FROM ai_credits WHERE firebase_uid=?', [U]); await pool.query('DELETE FROM ai_credit_txn WHERE firebase_uid=?', [U]); await pool.query('DELETE FROM users WHERE firebase_uid=?', [U]); await pool.query("DELETE FROM plan_grants WHERE plan_id LIKE 'c2t_%'"); await pool.query("DELETE FROM plans WHERE id LIKE 'c2t_%'");
console.log('ALL OK'); process.exit(0);
