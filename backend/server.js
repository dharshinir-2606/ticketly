const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
pool.on('error', (e) => console.error('DB error ignored:', e.message));
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const HOLD_MINUTES = 10;

// Redis is optional: if it is down, the app still works (just uncached).
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
redis?.connect().catch(() => console.log('Redis unavailable, caching off'));
const cacheGet = async (k) => { try { const v = await redis?.get(k); return v ? JSON.parse(v) : null; } catch { return null; } };
const cacheSet = async (k, v, ttl = 30) => { try { await redis?.set(k, JSON.stringify(v), 'EX', ttl); } catch {} };
const cacheDel = async (...k) => { try { await redis?.del(...k); } catch {} };

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const fail = (res, code, error) => res.status(code).json({ error });

// ---------- Auth & RBAC ----------
const auth = (...roles) => (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(token, SECRET);
  } catch { return fail(res, 401, 'Login required'); }
  if (roles.length && !roles.includes(req.user.role)) return fail(res, 403, 'Not allowed for your role');
  next();
};

app.post('/auth/register', wrap(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return fail(res, 400, 'name, email, password required');
  const safeRole = role === 'organizer' ? 'organizer' : 'attendee'; // admin is created manually in DB
  try {
    const { rows } = await pool.query(
      'INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role',
      [name, email.toLowerCase(), await bcrypt.hash(password, 10), safeRole]);
    const u = rows[0];
    res.status(201).json({ user: u, token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' }) });
  } catch (e) { if (e.code === '23505') return fail(res, 409, 'Email already used'); throw e; }
}));

app.post('/auth/login', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(req.body.email || '').toLowerCase()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return fail(res, 401, 'Wrong email or password');
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' }) });
}));

// ---------- Events ----------
app.post('/events', auth('organizer', 'admin'), wrap(async (req, res) => {
  const { title, description, venue, starts_at, sales_end_at, tiers } = req.body;
  if (!title || !starts_at || !sales_end_at || !Array.isArray(tiers) || !tiers.length) return fail(res, 400, 'title, starts_at, sales_end_at and tiers required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ev = (await client.query(
      'INSERT INTO events(organizer_id,title,description,venue,starts_at,sales_end_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, title, description, venue, starts_at, sales_end_at])).rows[0];
    for (const t of tiers)
      await client.query('INSERT INTO ticket_tiers(event_id,name,price_cents,total_qty,available_qty) VALUES($1,$2,$3,$4,$4)', [ev.id, t.name, t.price_cents, t.quantity]);
    await client.query('COMMIT');
    await cacheDel('events:list');
    res.status(201).json(ev);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

app.get('/events', wrap(async (req, res) => {
  const cached = await cacheGet('events:list');
  if (cached) return res.json(cached);
  const { rows } = await pool.query('SELECT * FROM events WHERE sales_end_at > now() ORDER BY starts_at');
  await cacheSet('events:list', rows);
  res.json(rows);
}));

app.get('/events/:id', wrap(async (req, res) => {
  const key = `events:${req.params.id}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(cached);
  const ev = (await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id])).rows[0];
  if (!ev) return fail(res, 404, 'Event not found');
  ev.tiers = (await pool.query('SELECT id,name,price_cents,total_qty,available_qty FROM ticket_tiers WHERE event_id=$1 ORDER BY price_cents DESC', [ev.id])).rows;
  await cacheSet(key, ev, 15);
  res.json(ev);
}));

app.delete('/events/:id', auth('organizer', 'admin'), wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM events WHERE id=$1 AND ($2 = \'admin\' OR organizer_id=$3)', [req.params.id, req.user.role, req.user.id]);
  if (!rowCount) return fail(res, 404, 'Event not found or not yours');
  await cacheDel('events:list', `events:${req.params.id}`);
  res.json({ deleted: true });
}));

// ---------- Reservation engine (race-condition safe) ----------
app.post('/reservations', auth('attendee', 'organizer', 'admin'), wrap(async (req, res) => {
  const { tier_id, qty } = req.body;
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail(res, 400, 'qty must be 1-10');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Row lock: concurrent requests for this tier queue up here, one at a time.
    const t = (await client.query(
      `SELECT t.*, e.sales_end_at, e.id AS event_id FROM ticket_tiers t JOIN events e ON e.id=t.event_id WHERE t.id=$1 FOR UPDATE OF t`, [tier_id])).rows[0];
    if (!t) { await client.query('ROLLBACK'); return fail(res, 404, 'Tier not found'); }
    if (new Date(t.sales_end_at) < new Date()) { await client.query('ROLLBACK'); return fail(res, 410, 'Sales have ended'); }
    if (t.available_qty < qty) { await client.query('ROLLBACK'); return fail(res, 409, `Only ${t.available_qty} left`); }
    await client.query('UPDATE ticket_tiers SET available_qty = available_qty - $1 WHERE id=$2', [qty, tier_id]);
    const r = (await client.query(
      `INSERT INTO reservations(user_id,tier_id,qty,expires_at) VALUES($1,$2,$3, now() + interval '${HOLD_MINUTES} minutes') RETURNING *`,
      [req.user.id, tier_id, qty])).rows[0];
    await client.query('COMMIT');
    await cacheDel(`events:${t.event_id}`);
    res.status(201).json(r);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// ---------- Checkout + mock payment ----------
app.post('/checkout', auth(), wrap(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query(
      `SELECT r.*, t.price_cents FROM reservations r JOIN ticket_tiers t ON t.id=r.tier_id WHERE r.id=$1 AND r.user_id=$2 FOR UPDATE OF r`,
      [req.body.reservation_id, req.user.id])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return fail(res, 404, 'Reservation not found'); }
    if (r.status !== 'held' || new Date(r.expires_at) < new Date()) { await client.query('ROLLBACK'); return fail(res, 410, 'Reservation expired or already used'); }
    await client.query("UPDATE reservations SET status='checkout' WHERE id=$1", [r.id]); // stops the expiry job from taking it
    const total = r.price_cents * r.qty;
    const order = (await client.query('INSERT INTO orders(reservation_id,user_id,total_cents) VALUES($1,$2,$3) RETURNING *', [r.id, req.user.id, total])).rows[0];
    await client.query('COMMIT');
    chargeAsync(order, r, req.body.simulate); // fire and forget
    res.status(202).json({ order_id: order.id, status: 'pending', message: 'Payment processing' });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// Mock gateway: approves after ~2s, rejects if simulate === 'fail' (or randomly 10% otherwise).
function chargeAsync(order, r, simulate) {
  setTimeout(async () => {
    const approved = simulate === 'fail' ? false : simulate === 'pass' ? true : Math.random() > 0.1;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO transactions(order_id,amount_cents,status) VALUES($1,$2,$3)', [order.id, order.total_cents, approved ? 'approved' : 'rejected']);
      await c.query('UPDATE orders SET status=$1 WHERE id=$2', [approved ? 'paid' : 'failed', order.id]);
      if (approved) await c.query("UPDATE reservations SET status='paid' WHERE id=$1", [r.id]);
      else {
        await c.query("UPDATE reservations SET status='cancelled' WHERE id=$1", [r.id]);
        await c.query('UPDATE ticket_tiers SET available_qty = available_qty + $1 WHERE id=$2', [r.qty, r.tier_id]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); console.error('payment error', e); } finally { c.release(); }
  }, 2000);
}

app.get('/orders/:id', auth(), wrap(async (req, res) => {
  const o = (await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!o) return fail(res, 404, 'Order not found');
  res.json(o);
}));

app.get('/my/orders', auth(), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.total_cents, r.qty, t.name AS tier, e.title, e.starts_at FROM orders o
     JOIN reservations r ON r.id=o.reservation_id JOIN ticket_tiers t ON t.id=r.tier_id JOIN events e ON e.id=t.event_id
     WHERE o.user_id=$1 ORDER BY o.created_at DESC`, [req.user.id]);
  res.json(rows);
}));

// ---------- Organizer analytics ----------
app.get('/organizer/analytics', auth('organizer', 'admin'), wrap(async (req, res) => {
  const scope = req.user.role === 'admin' ? 'TRUE' : 'e.organizer_id = $1';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const base = `FROM orders o JOIN reservations r ON r.id=o.reservation_id JOIN ticket_tiers t ON t.id=r.tier_id JOIN events e ON e.id=t.event_id WHERE o.status='paid' AND ${scope}`;
  const revenue = (await pool.query(`SELECT date_trunc('day', o.created_at)::date AS day, SUM(o.total_cents)::int AS revenue_cents ${base} GROUP BY 1 ORDER BY 1`, args)).rows;
  const perTier = (await pool.query(`SELECT e.title, t.name AS tier, SUM(r.qty)::int AS sold ${base} GROUP BY 1,2 ORDER BY 1,2`, args)).rows;
  const conv = (await pool.query(
    `SELECT COUNT(*)::int AS reservations, COUNT(*) FILTER (WHERE r.status='paid')::int AS paid
     FROM reservations r JOIN ticket_tiers t ON t.id=r.tier_id JOIN events e ON e.id=t.event_id WHERE ${scope}`, args)).rows[0];
  res.json({ revenue, perTier, conversion_rate: conv.reservations ? +(conv.paid / conv.reservations * 100).toFixed(1) : 0, ...conv });
}));

// ---------- Admin ----------
app.get('/admin/users', auth('admin'), wrap(async (req, res) => {
  res.json((await pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY id')).rows);
}));

// ---------- Background job: release expired holds (every minute) ----------
async function releaseExpired() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `UPDATE reservations SET status='expired' WHERE id IN (
         SELECT id FROM reservations WHERE status='held' AND expires_at < now() FOR UPDATE SKIP LOCKED)
       RETURNING tier_id, qty`);
    for (const r of rows) await c.query('UPDATE ticket_tiers SET available_qty = available_qty + $1 WHERE id=$2', [r.qty, r.tier_id]);
    await c.query('COMMIT');
    if (rows.length) { console.log(`Released ${rows.length} expired holds`); await cacheDel('events:list'); }
  } catch (e) { await c.query('ROLLBACK'); console.error('release job error', e); } finally { c.release(); }
}
cron.schedule('* * * * *', releaseExpired);
app.post('/admin/release-expired', auth('admin'), wrap(async (req, res) => { await releaseExpired(); res.json({ ok: true }); }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 4000, () => console.log('API running'));
