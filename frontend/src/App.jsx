import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const money = (c) => `$${(c / 100).toFixed(2)}`;
const when = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, method = 'GET', body) {
  const token = localStorage.getItem('token');
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function useCountdown(iso) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const tick = () => setS(Math.max(0, Math.floor((new Date(iso) - Date.now()) / 1000)));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [iso]);
  return s;
}

function Stub({ e, onOpen }) {
  const d = new Date(e.starts_at);
  return (
    <button className="stub" onClick={onOpen}>
      <div className="stub-main">
        <h3>{e.title}</h3>
        <p>{e.venue}</p>
        <small>Sales close {when(e.sales_end_at)}</small>
      </div>
      <div className="stub-date"><b>{d.getDate()}</b><span>{d.toLocaleString([], { month: 'short' })}</span></div>
    </button>
  );
}

function Events({ open }) {
  const [list, setList] = useState(null);
  useEffect(() => { api('/events').then(setList).catch(() => setList([])); }, []);
  if (!list) return <p className="muted">Loading events…</p>;
  return (
    <>
      <h1>Find your next night out</h1>
      {!list.length && <p className="muted">No events on sale yet. Organizers can add one from the Dashboard.</p>}
      <div className="grid">{list.map((e) => <Stub key={e.id} e={e} onOpen={() => open(e.id)} />)}</div>
    </>
  );
}

function EventPage({ id, user, goLogin }) {
  const [ev, setEv] = useState(null);
  const [qty, setQty] = useState({});
  const [hold, setHold] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const left = useCountdown(hold?.expires_at);
  const load = () => api(`/events/${id}`).then(setEv).catch((e) => setMsg({ bad: true, t: e.message }));
  useEffect(() => { load(); }, [id]);

  const reserve = async (t) => {
    if (!user) return goLogin();
    setMsg(null);
    try {
      const r = await api('/reservations', 'POST', { tier_id: t.id, qty: qty[t.id] || 1 });
      setHold({ ...r, tier: t.name, total: t.price_cents * r.qty });
    } catch (e) { setMsg({ bad: true, t: e.message }); }
    load();
  };
  const pay = async (simulate) => {
    setBusy(true); setMsg(null);
    try {
      const { order_id } = await api('/checkout', 'POST', { reservation_id: hold.id, simulate });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const o = await api(`/orders/${order_id}`);
        if (o.status !== 'pending') {
          setMsg(o.status === 'paid' ? { t: 'Payment approved. Your tickets are confirmed.' } : { bad: true, t: 'Payment rejected. Your tickets were released.' });
          break;
        }
      }
    } catch (e) { setMsg({ bad: true, t: e.message }); }
    setHold(null); setBusy(false); load();
  };

  if (!ev) return <p className="muted">{msg ? msg.t : 'Loading…'}</p>;
  const closed = new Date(ev.sales_end_at) < new Date();
  const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
  return (
    <>
      <h1>{ev.title}</h1>
      <p className="muted">{ev.venue} · {when(ev.starts_at)}</p>
      <p>{ev.description}</p>
      {msg && <div className={`note ${msg.bad ? 'bad' : 'good'}`}>{msg.t}</div>}
      {hold && (
        <div className="hold">
          <div><b>{hold.qty} × {hold.tier}</b><p>{money(hold.total)}</p></div>
          {left > 0 ? <div className="timer">{mm}:{ss}<small>left to pay</small></div> : <div className="timer">Hold expired</div>}
          <div className="row">
            <button disabled={busy || left === 0} onClick={() => pay()}>{busy ? 'Processing…' : 'Pay now'}</button>
            <button className="ghost" disabled={busy || left === 0} onClick={() => pay('fail')}>Test a failed payment</button>
          </div>
        </div>
      )}
      <h2>Tickets</h2>
      {closed && <div className="note bad">Sales for this event have ended.</div>}
      {ev.tiers.map((t) => (
        <div className="tier" key={t.id}>
          <div><b>{t.name}</b><p className="muted">{money(t.price_cents)} · {t.available_qty} of {t.total_qty} left</p></div>
          <select value={qty[t.id] || 1} onChange={(e) => setQty({ ...qty, [t.id]: +e.target.value })}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}
          </select>
          <button disabled={closed || !t.available_qty} onClick={() => reserve(t)}>{t.available_qty ? 'Hold for 10 min' : 'Sold out'}</button>
        </div>
      ))}
    </>
  );
}

function Auth({ done }) {
  const [reg, setReg] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'attendee' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    try {
      const r = await api(reg ? '/auth/register' : '/auth/login', 'POST', f);
      localStorage.setItem('token', r.token); localStorage.setItem('user', JSON.stringify(r.user)); done(r.user);
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card narrow">
      <h1>{reg ? 'Create account' : 'Log in'}</h1>
      {reg && <input placeholder="Name" value={f.name} onChange={set('name')} />}
      <input placeholder="Email" value={f.email} onChange={set('email')} />
      <input placeholder="Password" type="password" value={f.password} onChange={set('password')} />
      {reg && <select value={f.role} onChange={set('role')}><option value="attendee">I want to buy tickets</option><option value="organizer">I want to host events</option></select>}
      {err && <div className="note bad">{err}</div>}
      <button onClick={submit}>{reg ? 'Create account' : 'Log in'}</button>
      <button className="link" onClick={() => { setReg(!reg); setErr(''); }}>{reg ? 'I already have an account' : 'Create a new account'}</button>
    </div>
  );
}

function Orders() {
  const [list, setList] = useState(null);
  useEffect(() => { api('/my/orders').then(setList).catch(() => setList([])); }, []);
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>My tickets</h1>
      {!list.length && <p className="muted">No orders yet. Pick an event and hold your tickets.</p>}
      {list.map((o) => (
        <div className="tier" key={o.id}>
          <div><b>{o.title}</b><p className="muted">{o.qty} × {o.tier} · {money(o.total_cents)} · {when(o.starts_at)}</p></div>
          <span className={`pill ${o.status}`}>{o.status}</span>
        </div>
      ))}
    </>
  );
}

function Dashboard() {
  const [a, setA] = useState(null);
  const [f, setF] = useState({ title: '', venue: '', description: '', starts_at: '', sales_end_at: '' });
  const [tiers, setTiers] = useState([{ name: 'VIP', price: 100, quantity: 20 }, { name: 'General', price: 40, quantity: 100 }]);
  const [msg, setMsg] = useState(null);
  const refresh = () => api('/organizer/analytics').then(setA).catch((e) => setMsg({ bad: true, t: e.message }));
  useEffect(() => { refresh(); const i = setInterval(refresh, 10000); return () => clearInterval(i); }, []);
  const setT = (i, k, v) => setTiers(tiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  const create = async () => {
    try {
      await api('/events', 'POST', { ...f, tiers: tiers.map((t) => ({ name: t.name, price_cents: Math.round(t.price * 100), quantity: +t.quantity })) });
      setMsg({ t: 'Event published.' }); refresh();
    } catch (e) { setMsg({ bad: true, t: e.message }); }
  };
  return (
    <>
      <h1>Dashboard</h1>
      {a && (
        <>
          <div className="stats">
            <div><b>{money(a.revenue.reduce((s, r) => s + r.revenue_cents, 0))}</b><span>revenue</span></div>
            <div><b>{a.perTier.reduce((s, r) => s + r.sold, 0)}</b><span>tickets sold</span></div>
            <div><b>{a.conversion_rate}%</b><span>holds that became sales</span></div>
          </div>
          <div className="charts">
            <div className="card"><h3>Revenue per day</h3>
              <ResponsiveContainer width="100%" height={200}><BarChart data={a.revenue.map((r) => ({ day: r.day.slice(5, 10), revenue: r.revenue_cents / 100 }))}><XAxis dataKey="day" /><YAxis /><Tooltip /><Bar dataKey="revenue" fill="#3b4cff" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>
            <div className="card"><h3>Tickets sold by tier</h3>
              <ResponsiveContainer width="100%" height={200}><BarChart data={a.perTier.map((r) => ({ name: `${r.title.slice(0, 10)} ${r.tier}`, sold: r.sold }))}><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="sold" fill="#ff8a3d" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>
          </div>
        </>
      )}
      <h2>Create an event</h2>
      <div className="card">
        <input placeholder="Event title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input placeholder="Venue" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
        <textarea placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <label>Event starts<input type="datetime-local" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></label>
        <label>Ticket sales close<input type="datetime-local" value={f.sales_end_at} onChange={(e) => setF({ ...f, sales_end_at: e.target.value })} /></label>
        {tiers.map((t, i) => (
          <div className="row" key={i}>
            <input placeholder="Tier name" value={t.name} onChange={(e) => setT(i, 'name', e.target.value)} />
            <input type="number" placeholder="Price $" value={t.price} onChange={(e) => setT(i, 'price', e.target.value)} />
            <input type="number" placeholder="Quantity" value={t.quantity} onChange={(e) => setT(i, 'quantity', e.target.value)} />
          </div>
        ))}
        <button className="ghost" onClick={() => setTiers([...tiers, { name: '', price: 0, quantity: 10 }])}>Add a tier</button>
        {msg && <div className={`note ${msg.bad ? 'bad' : 'good'}`}>{msg.t}</div>}
        <button onClick={create}>Publish event</button>
      </div>
    </>
  );
}

export default function App() {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('user') || 'null'));
  const [view, setView] = useState({ name: 'events' });
  const go = (name, id) => setView({ name, id });
  const logout = () => { localStorage.clear(); setUser(null); go('events'); };
  return (
    <>
      <header>
        <button className="brand" onClick={() => go('events')}>Ticketly</button>
        <nav>
          <button className="link" onClick={() => go('events')}>Events</button>
          {user && <button className="link" onClick={() => go('orders')}>My tickets</button>}
          {user && ['organizer', 'admin'].includes(user.role) && <button className="link" onClick={() => go('dash')}>Dashboard</button>}
          {user ? <button className="ghost" onClick={logout}>Log out ({user.name})</button> : <button onClick={() => go('login')}>Log in</button>}
        </nav>
      </header>
      <main>
        {view.name === 'events' && <Events open={(id) => go('event', id)} />}
        {view.name === 'event' && <EventPage id={view.id} user={user} goLogin={() => go('login')} />}
        {view.name === 'login' && <Auth done={(u) => { setUser(u); go('events'); }} />}
        {view.name === 'orders' && <Orders />}
        {view.name === 'dash' && <Dashboard />}
      </main>
    </>
  );
}
