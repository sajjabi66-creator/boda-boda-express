import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './App.css';

// Same origin when Bun serves the build; localhost:3000 during `vite dev`.
const API = import.meta.env.DEV ? 'http://localhost:3000' : '';
const WS_URL = import.meta.env.DEV
  ? 'ws://localhost:3000/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const CHANNEL_LABELS = {
  admin: { label: 'Office', color: '#94a3b8' },
  buyer: { label: 'Restaurant link', color: '#38bdf8' },
  shop: { label: 'Online shop', color: '#22c55e' },
  agent: { label: 'Shop chat', color: '#a78bfa' }
};

const ugx = (n) => Number(n || 0).toLocaleString('en-UG');

// Shrink a photo in the browser so uploads stay small (≈40-80 KB).
function resizeImage(file, max, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function ProductThumb({ src, name, size = 52 }) {
  if (src) {
    return <img src={src} alt={name} style={{ width: size, height: size, borderRadius: '10px', objectFit: 'cover', flexShrink: 0, backgroundColor: '#0f172a' }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '10px', backgroundColor: '#0f172a', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size / 2.6, flexShrink: 0, fontWeight: 'bold' }}>
      {String(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}
const STATUS_STYLES = {
  pending:    { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', label: 'Pending' },
  confirmed:  { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', label: 'Confirmed' },
  dispatched: { color: '#38bdf8', bg: 'rgba(56,189,248,0.15)', label: 'Dispatched' },
  delivered:  { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  label: 'Delivered' }
};
const NEXT_STATUS = { pending: 'confirmed', confirmed: 'dispatched', dispatched: 'delivered', delivered: 'pending' };

// ---- WhatsApp helpers ------------------------------------------------
const orderMessage = (order) => {
  const when = new Date(order.created_at).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const lines = (order.items || []).map((it, i) =>
    `${i + 1}. ${it.name} - ${it.weight} kg x ${ugx(it.price)} = ${ugx(it.total)}`
  );
  return [
    `*${String(order.restaurant).toUpperCase()} ORDER #${order.id}*`,
    when,
    '',
    ...lines,
    '',
    `*TOTAL: ${ugx(order.grand_total ?? order.grandTotal)} UGX*`,
    '',
    'Boda Boda Express'
  ].join('\n');
};

const whatsappLink = (phone, order) => {
  const digits = String(phone || '').replace(/\D/g, '');
  const text = encodeURIComponent(orderMessage(order));
  return digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`;
};

function App() {
  // /order/<token> is the buyer portal — a completely separate, scoped view.
  const buyer = window.location.pathname.match(/^\/order\/([A-Za-z0-9]+)/);
  if (buyer) return <BuyerApp token={buyer[1]} />;

  // /work/<token> is the workers screen.
  const staff = window.location.pathname.match(/^\/work\/([A-Za-z0-9]+)/);
  if (staff) return <StaffApp token={staff[1]} />;

  // /shop is the public retail storefront.
  if (window.location.pathname === '/shop' || window.location.pathname === '/shop/') return <ShopApp />;

  const [session, setSession] = useState(null); // { authRequired, authenticated }
  useEffect(() => {
    fetch(`${API}/api/session`)
      .then(r => r.json())
      .then(setSession)
      .catch(() => setSession({ authRequired: false, authenticated: true }));
  }, []);

  if (!session) {
    return <div style={{ backgroundColor: '#0f172a', color: '#94a3b8', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>Loading...</div>;
  }
  if (session.authRequired && !session.authenticated) {
    return <Login onDone={() => setSession({ authRequired: true, authenticated: true })} />;
  }
  return <Dashboard authRequired={session.authRequired} onLogout={() => setSession({ authRequired: true, authenticated: false })} />;
}

function ShopApp() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [weights, setWeights] = useState({});
  const [form, setForm] = useState({ name: '', phone: '', area: '', note: '' });
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chat, setChat] = useState([
    { role: 'assistant', content: "Karibu! Ask me about today's prices, or fill the list below and I'll get your order to the office." }
  ]);
  const sessionId = useMemo(() => Math.random().toString(36).slice(2), []);

  useEffect(() => {
    fetch(`${API}/api/shop`)
      .then(r => r.json())
      .then(d => d.ok ? setData(d) : setError(d.error || 'The shop is not available right now.'))
      .catch(() => setError('No connection. Please check your internet.'));
  }, []);

  const items = data
    ? data.products.map(p => ({ ...p, weight: Number(weights[p.name]) || 0 })).filter(p => p.weight > 0)
    : [];
  const subtotal = items.reduce((s, p) => s + Math.round(p.weight * p.price), 0);
  const fee = data?.shop.delivery_fee || 0;
  const total = subtotal + (items.length ? fee : 0);

  const placeOrder = async () => {
    if (!form.name.trim()) return alert('Please enter your name.');
    if (String(form.phone).replace(/\D/g, '').length < 9) return alert('Please enter a phone number we can call.');
    if (!items.length) return alert('Choose at least one item.');
    setPlacing(true);
    try {
      const res = await fetch(`${API}/api/shop/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          items: items.map(p => ({ name: p.name, weight: p.weight }))
        })
      });
      const d = await res.json();
      if (d.ok) {
        setPlaced(d.order);
        setWeights({});
        setForm({ name: '', phone: '', area: '', note: '' });
      } else {
        alert(d.error || 'Could not send the order.');
      }
    } catch {
      alert('Could not reach the shop. Please try again.');
    }
    setPlacing(false);
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const next = [...chat, { role: 'user', content: text }];
    setChat(next);
    setChatInput('');
    setChatBusy(true);
    try {
      const res = await fetch(`${API}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })), session: sessionId })
      });
      const d = await res.json();
      if (d.ok) {
        setChat(prev => [
          ...prev,
          { role: 'assistant', content: d.reply },
          ...(d.orderId ? [{ role: 'assistant', content: `✅ Order #${d.orderId} is with the office. They will call to confirm.` }] : [])
        ]);
      } else {
        setChat(prev => [...prev, { role: 'assistant', content: d.error || 'Sorry, please use the order form below.' }]);
      }
    } catch {
      setChat(prev => [...prev, { role: 'assistant', content: 'No connection. Please try again.' }]);
    }
    setChatBusy(false);
  };

  const shell = { minHeight: '100vh', backgroundColor: '#0f172a', color: 'white', fontFamily: 'sans-serif', padding: '16px' };
  const card = { backgroundColor: '#1e293b', borderRadius: '12px', padding: '16px', marginBottom: '14px' };
  const inputStyle = { width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '15px', boxSizing: 'border-box' };

  if (error) {
    return (
      <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...card, maxWidth: '420px', textAlign: 'center' }}>
          <h2 style={{ marginTop: 0, color: '#ef4444' }}>Shop unavailable</h2>
          <p style={{ color: '#94a3b8' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;

  return (
    <div style={shell}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <span style={{ fontSize: '26px' }}>🛵</span>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '20px' }}>{data.shop.name}</div>
            <div style={{ color: '#94a3b8', fontSize: '13px' }}>Fresh vegetables, delivered</div>
          </div>
        </div>

        <div style={{ ...card, display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px', color: '#94a3b8' }}>
          {fee > 0 && <span>Delivery: <b style={{ color: '#38bdf8' }}>{ugx(fee)} UGX</b></span>}
          {data.shop.min_order > 0 && <span>Minimum: <b style={{ color: '#38bdf8' }}>{ugx(data.shop.min_order)} UGX</b></span>}
          {data.shop.areas.length > 0 && <span>Areas: <b style={{ color: '#38bdf8' }}>{data.shop.areas.join(', ')}</b></span>}
          {data.shop.phone && <span>Call: <b style={{ color: '#38bdf8' }}>{data.shop.phone}</b></span>}
        </div>

        {placed && (
          <div style={{ ...card, backgroundColor: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e' }}>
            <div style={{ fontWeight: 'bold', color: '#22c55e', fontSize: '16px' }}>✅ Order #{placed.id} received</div>
            <div style={{ color: '#94a3b8', fontSize: '14px', marginTop: '4px' }}>
              {ugx(placed.grand_total)} UGX · we will call you to confirm delivery.
            </div>
            <button onClick={() => setPlaced(null)} style={{ marginTop: '10px', background: 'none', border: '1px solid #334155', color: '#94a3b8', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer' }}>
              Order more
            </button>
          </div>
        )}

        <div style={card}>
          <h3 style={{ marginTop: 0, marginBottom: '12px' }}>Today's prices — how many kilos?</h3>
          {data.products.map(p => {
            const w = weights[p.name] || '';
            const lineTotal = (Number(w) || 0) * p.price;
            return (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #0f172a' }}>
                <ProductThumb src={p.image} name={p.name} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{ugx(p.price)} UGX / {p.unit}</div>
                </div>
                <input
                  type="number" inputMode="decimal" min="0" step="0.5"
                  value={w}
                  onChange={e => setWeights({ ...weights, [p.name]: e.target.value })}
                  placeholder="0"
                  style={{ width: '76px', padding: '12px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '16px', textAlign: 'center' }}
                />
                <div style={{ width: '86px', textAlign: 'right', fontWeight: 'bold', fontSize: '14px', color: lineTotal ? '#38bdf8' : '#475569' }}>
                  {lineTotal ? ugx(lineTotal) : '—'}
                </div>
              </div>
            );
          })}
        </div>

        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Where should we deliver?</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input placeholder="Your name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
            <input placeholder="Phone number" inputMode="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
            {data.shop.areas.length > 0 ? (
              <select value={form.area} onChange={e => setForm({ ...form, area: e.target.value })} style={inputStyle}>
                <option value="">Choose your area</option>
                {data.shop.areas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : (
              <input placeholder="Area / landmark" value={form.area} onChange={e => setForm({ ...form, area: e.target.value })} style={inputStyle} />
            )}
            <input placeholder="Anything else? (optional)" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} style={inputStyle} />
          </div>
        </div>

        <div style={{ ...card, position: 'sticky', bottom: '12px', border: '1px solid #38bdf8' }}>
          <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
            {items.length} item{items.length === 1 ? '' : 's'}
            {fee > 0 && items.length > 0 ? ` + delivery ${ugx(fee)}` : ''}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '20px', fontWeight: 'bold', color: '#22c55e' }}>{ugx(total)} UGX</span>
            <button
              onClick={placeOrder}
              disabled={placing || !items.length}
              style={{ flex: 1, maxWidth: '260px', padding: '16px', fontSize: '17px', fontWeight: 'bold', border: 'none', borderRadius: '10px', cursor: placing || !items.length ? 'not-allowed' : 'pointer', backgroundColor: placing || !items.length ? '#475569' : '#22c55e', color: placing || !items.length ? '#94a3b8' : '#04321c' }}
            >
              {placing ? 'Sending...' : 'Place order 🚀'}
            </button>
          </div>
        </div>

        <p style={{ textAlign: 'center', color: '#475569', fontSize: '12px', paddingBottom: '80px' }}>
          Pay on delivery · prices change daily
        </p>
      </div>

      {data.agentAvailable && (
        <>
          {chatOpen && (
            <div style={{ position: 'fixed', right: '16px', bottom: '80px', width: 'min(360px, calc(100vw - 32px))', maxHeight: '70vh', display: 'flex', flexDirection: 'column', backgroundColor: '#1e293b', borderRadius: '14px', border: '1px solid #334155', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 'bold', fontSize: '14px' }}>💬 Order assistant</span>
                <button onClick={() => setChatOpen(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '18px', cursor: 'pointer' }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {chat.map((m, i) => (
                  <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '9px 12px', borderRadius: '12px', fontSize: '14px', lineHeight: 1.4, backgroundColor: m.role === 'user' ? '#3b82f6' : '#0f172a', color: 'white' }}>
                    {m.content}
                  </div>
                ))}
                {chatBusy && <div style={{ color: '#64748b', fontSize: '13px' }}>typing...</div>}
              </div>
              <div style={{ display: 'flex', gap: '6px', padding: '10px', borderTop: '1px solid #0f172a' }}>
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendChat(); }}
                  placeholder="Ask about prices..."
                  style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '14px' }}
                />
                <button onClick={sendChat} disabled={chatBusy} style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', backgroundColor: '#22c55e', color: '#04321c', fontWeight: 'bold', cursor: chatBusy ? 'not-allowed' : 'pointer' }}>Send</button>
              </div>
            </div>
          )}
          <button
            onClick={() => setChatOpen(o => !o)}
            style={{ position: 'fixed', right: '16px', bottom: '16px', width: '56px', height: '56px', borderRadius: '50%', border: 'none', backgroundColor: '#22c55e', color: '#04321c', fontSize: '24px', cursor: 'pointer', boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}
            title="Chat with the order assistant"
          >
            💬
          </button>
        </>
      )}
    </div>
  );
}

function StaffApp({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [updated, setUpdated] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/staff/${token}/orders`);
      const d = await res.json();
      if (d.ok) {
        setData(d);
        setUpdated(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      } else {
        setError(d.error || 'This staff link is not valid.');
      }
    } catch {
      setError('No connection. Check the internet.');
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 10000); // keeps the screen fresh on its own
    return () => clearInterval(timer);
  }, [load]);

  const advance = async (order, status) => {
    setBusyId(order.id);
    try {
      const res = await fetch(`${API}/api/staff/${token}/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const d = await res.json();
      if (!d.ok) alert(d.error || 'Could not update the order.');
      await load();
    } catch {
      alert('Could not reach the server.');
    }
    setBusyId(null);
  };

  const shell = { minHeight: '100vh', backgroundColor: '#0f172a', color: 'white', fontFamily: 'sans-serif', padding: '16px' };
  const card = { backgroundColor: '#1e293b', borderRadius: '12px', padding: '16px', marginBottom: '14px' };

  if (error) {
    return (
      <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...card, maxWidth: '400px', textAlign: 'center' }}>
          <h2 style={{ marginTop: 0, color: '#ef4444' }}>Link not valid</h2>
          <p style={{ color: '#94a3b8' }}>{error}</p>
          <p style={{ color: '#64748b', fontSize: '13px' }}>Ask the office for a fresh workers link.</p>
        </div>
      </div>
    );
  }

  if (!data) return <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;

  const counts = {
    confirmed: data.active.filter(o => o.status === 'confirmed').length,
    dispatched: data.active.filter(o => o.status === 'dispatched').length
  };

  return (
    <div style={shell}>
      <div style={{ maxWidth: '620px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '20px' }}>👷 Workers</div>
            <div style={{ color: '#94a3b8', fontSize: '12px' }}>Boda Boda Express · updated {updated}</div>
          </div>
          <button onClick={load} style={{ padding: '10px 16px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: 'transparent', color: '#38bdf8', fontWeight: 'bold', cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
          <div style={{ ...card, flex: 1, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontSize: '26px', fontWeight: 'bold', color: '#a78bfa' }}>{counts.confirmed}</div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>to prepare</div>
          </div>
          <div style={{ ...card, flex: 1, marginBottom: 0, textAlign: 'center' }}>
            <div style={{ fontSize: '26px', fontWeight: 'bold', color: '#38bdf8' }}>{counts.dispatched}</div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>on the way</div>
          </div>
        </div>

        {data.active.length === 0 && (
          <div style={{ ...card, textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: '30px', marginBottom: '8px' }}>✅</div>
            Nothing waiting. New orders appear here the moment the office confirms them.
          </div>
        )}

        {data.active.map(order => {
          const st = STATUS_STYLES[order.status] || STATUS_STYLES.confirmed;
          const onWay = order.status === 'dispatched';
          return (
            <div key={order.id} style={{ ...card, borderLeft: `5px solid ${st.color}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '19px', fontWeight: 'bold' }}>{order.restaurant}</div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                    Order #{order.id} · {new Date(order.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <span style={{ fontSize: '12px', fontWeight: 'bold', padding: '4px 10px', borderRadius: '999px', color: st.color, backgroundColor: st.bg }}>
                  {st.label}
                </span>
              </div>

              <div style={{ margin: '12px 0', borderTop: '1px solid #0f172a', paddingTop: '10px' }}>
                {(order.items || []).map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '15px' }}>
                    <span>{it.name}</span>
                    <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{it.weight} kg</span>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: '#94a3b8', fontSize: '13px' }}>{ugx(order.grand_total)} UGX</span>
                <button
                  onClick={() => advance(order, onWay ? 'delivered' : 'dispatched')}
                  disabled={busyId === order.id}
                  style={{ flex: 1, maxWidth: '220px', padding: '14px', fontSize: '16px', fontWeight: 'bold', border: 'none', borderRadius: '10px', cursor: busyId === order.id ? 'not-allowed' : 'pointer', backgroundColor: onWay ? '#22c55e' : '#38bdf8', color: onWay ? '#04321c' : '#0f172a' }}
                >
                  {busyId === order.id ? 'Working...' : onWay ? '✓ Delivered' : '🛵 Start delivery'}
                </button>
              </div>
            </div>
          );
        })}

        {data.done.length > 0 && (
          <>
            <div style={{ color: '#64748b', fontSize: '12px', margin: '18px 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Delivered (last 24h)
            </div>
            {data.done.map(o => (
              <div key={o.id} style={{ ...card, opacity: 0.6, padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
                  <span>{o.restaurant} · #{o.id}</span>
                  <span style={{ color: '#22c55e', fontWeight: 'bold' }}>{ugx(o.grand_total)} UGX</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function BuyerApp({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [weights, setWeights] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [placed, setPlaced] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/buyer/${token}`);
      const d = await res.json();
      if (d.ok) setData(d);
      else setError(d.error || 'This ordering link is not valid.');
    } catch {
      setError('Could not reach the server. Please check your internet and try again.');
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const items = data
    ? data.products
        .map(p => ({ ...p, weight: Number(weights[p.name]) || 0 }))
        .filter(p => p.weight > 0)
    : [];
  const total = items.reduce((s, p) => s + p.weight * p.price, 0);

  const submit = async () => {
    if (!items.length) return alert('Enter a weight next to at least one item.');
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/buyer/${token}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(p => ({ name: p.name, weight: p.weight })) })
      });
      const d = await res.json();
      if (d.ok) {
        setPlaced(d.order);
        setWeights({});
        await load();
      } else {
        alert(d.error || 'Could not send the order.');
      }
    } catch {
      alert('Could not reach the server.');
    }
    setSubmitting(false);
  };

  const shell = { minHeight: '100vh', backgroundColor: '#0f172a', color: 'white', fontFamily: 'sans-serif', padding: '20px' };
  const card = { backgroundColor: '#1e293b', borderRadius: '12px', padding: '18px', marginBottom: '16px' };

  if (error) {
    return (
      <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ ...card, maxWidth: '420px', textAlign: 'center' }}>
          <h2 style={{ marginTop: 0, color: '#ef4444' }}>Link not valid</h2>
          <p style={{ color: '#94a3b8' }}>{error}</p>
          <p style={{ color: '#64748b', fontSize: '13px' }}>Ask Boda Boda Express for a fresh link.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div style={{ ...shell, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;
  }

  return (
    <div style={shell}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
          <span style={{ fontSize: '24px' }}>🛵</span>
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '20px' }}>{data.restaurant.name}</div>
            <div style={{ color: '#94a3b8', fontSize: '13px' }}>Order vegetables from Boda Boda Express</div>
          </div>
        </div>

        {data.balance !== 0 && (
          <div style={{ ...card, backgroundColor: data.balance > 0 ? 'rgba(251,191,36,0.12)' : 'rgba(34,197,94,0.12)', border: `1px solid ${data.balance > 0 ? '#fbbf24' : '#22c55e'}` }}>
            <div style={{ fontSize: '13px', color: '#94a3b8' }}>{data.balance > 0 ? 'Your current balance' : 'You are in credit'}</div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: data.balance > 0 ? '#fbbf24' : '#22c55e' }}>
              {ugx(Math.abs(data.balance))} UGX
            </div>
          </div>
        )}

        {placed && (
          <div style={{ ...card, backgroundColor: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e' }}>
            <div style={{ fontWeight: 'bold', color: '#22c55e', fontSize: '16px' }}>
              ✅ Order #{placed.id} sent
            </div>
            <div style={{ color: '#94a3b8', fontSize: '14px', marginTop: '4px' }}>
              {ugx(placed.grand_total)} UGX — Boda Boda Express will confirm and deliver.
            </div>
            <button onClick={() => setPlaced(null)} style={{ marginTop: '10px', background: 'none', border: '1px solid #334155', color: '#94a3b8', padding: '8px 14px', borderRadius: '8px', cursor: 'pointer' }}>
              Place another order
            </button>
          </div>
        )}

        <div style={card}>
          <h3 style={{ marginTop: 0, marginBottom: '12px' }}>Today's prices — enter the kilos you need</h3>
          {data.products.map(p => {
            const w = weights[p.name] || '';
            const lineTotal = (Number(w) || 0) * p.price;
            return (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #0f172a' }}>
                <ProductThumb src={p.image} name={p.name} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px' }}>{p.name}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{ugx(p.price)} UGX / {p.unit}</div>
                </div>
                <input
                  type="number" inputMode="decimal" min="0" step="0.5"
                  value={w}
                  onChange={e => setWeights({ ...weights, [p.name]: e.target.value })}
                  placeholder="0"
                  style={{ width: '80px', padding: '12px', borderRadius: '8px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '16px', textAlign: 'center' }}
                />
                <div style={{ width: '90px', textAlign: 'right', color: lineTotal ? '#38bdf8' : '#475569', fontWeight: 'bold', fontSize: '14px' }}>
                  {lineTotal ? ugx(lineTotal) : '—'}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ ...card, position: 'sticky', bottom: '12px', border: '1px solid #38bdf8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ color: '#94a3b8', fontSize: '14px' }}>{items.length} item{items.length === 1 ? '' : 's'}</span>
            <span style={{ fontSize: '20px', fontWeight: 'bold', color: '#22c55e' }}>{ugx(total)} UGX</span>
          </div>
          <button
            onClick={submit}
            disabled={submitting || items.length === 0}
            style={{ width: '100%', padding: '16px', fontSize: '17px', fontWeight: 'bold', border: 'none', borderRadius: '10px', cursor: submitting || !items.length ? 'not-allowed' : 'pointer', backgroundColor: submitting || !items.length ? '#475569' : '#22c55e', color: submitting || !items.length ? '#94a3b8' : '#04321c' }}
          >
            {submitting ? 'Sending...' : 'Send order 🚀'}
          </button>
        </div>

        {data.orders.length > 0 && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Your recent orders</h3>
            {data.orders.map(o => (
              <div key={o.id} style={{ padding: '10px 0', borderBottom: '1px solid #0f172a' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
                  <span style={{ color: '#94a3b8' }}>
                    #{o.id} · {new Date(o.created_at).toLocaleDateString('en-GB')}
                  </span>
                  <span style={{ fontWeight: 'bold' }}>{ugx(o.grand_total)} UGX</span>
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '3px' }}>
                  {(o.items || []).map(it => `${it.name} ${it.weight}kg`).join(', ')}
                  {' · '}
                  {(STATUS_STYLES[o.status] || STATUS_STYLES.pending).label}
                </div>
              </div>
            ))}
          </div>
        )}

        <p style={{ textAlign: 'center', color: '#475569', fontSize: '12px', paddingBottom: '30px' }}>
          Boda Boda Express · prices change daily
        </p>
      </div>
    </div>
  );
}

function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.ok) onDone();
      else setError('Wrong password. Try again.');
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  };

  return (
    <div style={{ backgroundColor: '#0f172a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <form onSubmit={submit} style={{ backgroundColor: '#1e293b', padding: '40px', borderRadius: '12px', width: '320px' }}>
        <h2 style={{ color: '#38bdf8', marginTop: 0 }}>🛵 Boda Boda Express</h2>
        <p style={{ color: '#94a3b8', fontSize: '14px' }}>Enter the dashboard password</p>
        <input
          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Password" autoFocus
          style={{ width: '100%', padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: '#334155', color: 'white', boxSizing: 'border-box' }}
        />
        {error && <p style={{ color: '#ef4444', fontSize: '13px' }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ width: '100%', marginTop: '15px', padding: '12px', backgroundColor: busy ? '#475569' : '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer' }}>
          {busy ? 'Checking...' : 'Open dashboard'}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ authRequired, onLogout }) {
  const [page, setPage] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [connected, setConnected] = useState(false);

  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/orders?limit=100`);
      const data = await res.json();
      if (data.ok) setOrders(data.orders);
    } catch (err) { console.error(err); }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/products`);
      const data = await res.json();
      if (data.ok) setProducts(data.products);
    } catch (err) { console.error(err); }
  }, []);

  const loadRestaurants = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/restaurants`);
      const data = await res.json();
      if (data.ok) setRestaurants(data.restaurants);
    } catch (err) { console.error(err); }
  }, []);

  useEffect(() => {
    loadOrders(); loadProducts(); loadRestaurants();
  }, [loadOrders, loadProducts, loadRestaurants]);

  useEffect(() => {
    let ws, retry;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const updated = JSON.parse(event.data);
        if (updated?.deleted) {
          setOrders(prev => prev.filter(o => o.id !== updated.id));
          return;
        }
        if (!updated?.id) return;
        setOrders(prev => [updated, ...prev.filter(o => o.id !== updated.id)].sort((a, b) => b.id - a.id));
      };
      ws.onclose = () => { setConnected(false); retry = setTimeout(connect, 3000); };
    };
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  const navBtn = (key, label) => (
    <button
      onClick={() => setPage(key)}
      style={{
        textAlign: 'left', padding: '10px 12px', borderRadius: '8px', border: 'none', cursor: 'pointer',
        backgroundColor: page === key ? '#0f172a' : 'transparent',
        color: page === key ? '#38bdf8' : '#94a3b8',
        fontWeight: page === key ? 'bold' : 'normal', fontSize: '15px'
      }}
    >{label}</button>
  );

  const logout = async () => {
    await fetch(`${API}/api/logout`, { method: 'POST' }).catch(() => {});
    onLogout();
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#0f172a', color: 'white' }}>
      <div style={{ width: '250px', backgroundColor: '#1e293b', padding: '20px', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ color: '#38bdf8', marginTop: 0 }}>🛵 Boda Boda Express</h2>
        <p style={{ color: '#94a3b8', fontSize: '14px' }}>Admin Dashboard</p>
        <div style={{ marginTop: '30px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {navBtn('orders', '📦 Orders')}
          {navBtn('accounts', '💰 Accounts')}
          {navBtn('analytics', '📊 Analytics')}
          {navBtn('prices', '💲 Prices & Stock')}
        </div>
        <div style={{ marginTop: 'auto', paddingBottom: '10px', fontSize: '14px' }}>
          Status: {connected
            ? <span style={{ color: '#22c55e' }}>🟢 Live</span>
            : <span style={{ color: '#ef4444' }}>🔴 Offline</span>}
          <div style={{ color: '#64748b', marginTop: '8px' }}>{orders.length} order{orders.length === 1 ? '' : 's'} saved</div>
          {authRequired && (
            <button onClick={logout} style={{ marginTop: '12px', background: 'none', border: '1px solid #334155', color: '#94a3b8', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
              Log out
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, padding: '40px', overflowY: 'auto' }}>
        {page === 'orders' && (
          <OrdersView
            orders={orders} setOrders={setOrders}
            products={products} restaurants={restaurants}
          />
        )}
        {page === 'analytics' && <AnalyticsView />}
        {page === 'accounts' && <AccountsView />}
        {page === 'prices' && (
          <PricesView
            products={products} reloadProducts={loadProducts}
            restaurants={restaurants} reloadRestaurants={loadRestaurants}
          />
        )}
      </div>
    </div>
  );
}

function OrdersView({ orders, setOrders, products, restaurants }) {
  const activeProducts = products.filter(p => p.active);
  const activeRestaurants = restaurants.filter(r => r.active);

  const [restaurant, setRestaurant] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedVeg, setSelectedVeg] = useState({ name: '', price: 0, unit: 'kg' });
  const [showDropdown, setShowDropdown] = useState(false);
  const [weight, setWeight] = useState('');
  const [pricePerKg, setPricePerKg] = useState('');
  const [cart, setCart] = useState([]);
  const [saving, setSaving] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [staffToken, setStaffToken] = useState('');

  useEffect(() => {
    fetch(`${API}/api/staff-link`)
      .then(r => r.json())
      .then(d => { if (d.ok) setStaffToken(d.token); })
      .catch(() => {});
  }, []);

  const workersUrl = staffToken ? `${location.origin}/work/${staffToken}` : '';

  const copyWorkersLink = async () => {
    try {
      await navigator.clipboard.writeText(workersUrl);
      alert('Workers link copied. Send it to your team.');
    } catch {
      prompt('Workers link:', workersUrl);
    }
  };

  const rotateWorkersLink = async () => {
    if (!confirm('Create a new workers link?\nThe old one stops working immediately.')) return;
    const res = await fetch(`${API}/api/staff-link/rotate`, { method: 'POST' });
    const d = await res.json();
    if (d.ok) setStaffToken(d.token);
    else alert(d.error || 'Could not create a new link');
  };

  const confirmOrder = async (order) => {
    try {
      const res = await fetch(`${API}/api/orders/${order.id}/confirm`, { method: 'POST' });
      const d = await res.json();
      if (d.ok) setOrders(prev => prev.map(o => o.id === d.order.id ? d.order : o));
      else alert(d.error || 'Could not confirm the order');
    } catch { alert('Could not reach the server.'); }
  };

  useEffect(() => {
    if (!restaurant && activeRestaurants.length) setRestaurant(activeRestaurants[0].name);
  }, [activeRestaurants, restaurant]);

  const calculatedTotal = (Number(weight) || 0) * (Number(pricePerKg) || 0);
  const grandTotal = cart.reduce((sum, item) => sum + item.total, 0);
  const filtered = activeProducts.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const repeatLast = () => {
    const last = orders.find(o => o.restaurant === restaurant);
    if (!last) return alert(`No earlier order for ${restaurant} yet.`);
    setCart(last.items.map((it, i) => ({
      id: Date.now() + i, name: it.name, unit: 'kg',
      weight: Number(it.weight), price: Number(it.price), total: Number(it.total)
    })));
  };

  const handleSelect = (veg) => {
    setSelectedVeg(veg);
    setPricePerKg(veg.price);
    setSearchQuery(veg.name);
    setShowDropdown(false);
  };

  const handleAddItem = (e) => {
    e.preventDefault();
    if (!selectedVeg.name) return alert("Please select a vegetable from the search list!");
    if (!weight || !pricePerKg) return alert("Please enter weight!");

    setCart([...cart, {
      id: Date.now(), name: selectedVeg.name, unit: selectedVeg.unit || 'kg',
      weight: Number(weight), price: Number(pricePerKg), total: calculatedTotal
    }]);

    setSearchQuery('');
    setSelectedVeg({ name: '', price: 0, unit: 'kg' });
    setPricePerKg('');
    setWeight('');
    setShowDropdown(false);
  };

  const submitOrder = async () => {
    if (cart.length === 0) return alert("Your order list is empty!");
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurant,
          items: cart.map(({ name, weight, price }) => ({ name, weight, price }))
        })
      });
      const data = await res.json();
      if (data.ok) {
        setOrders(prev => [data.order, ...prev.filter(o => o.id !== data.order.id)]);
        setCart([]);
        setLastOrder(data.order);
      } else {
        alert("Could not save order: " + (data.error || 'unknown error'));
      }
    } catch {
      alert("Could not reach the server. Is it running?");
    }
    setSaving(false);
  };

  const cycleStatus = async (order) => {
    const next = NEXT_STATUS[order.status] || 'pending';
    try {
      const res = await fetch(`${API}/api/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next })
      });
      const data = await res.json();
      if (data.ok) setOrders(prev => prev.map(o => o.id === data.order.id ? data.order : o));
    } catch { alert("Could not update the order status."); }
  };

  const deleteOrder = async (order) => {
    if (!confirm(`Delete order #${order.id} for ${order.restaurant}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API}/api/orders/${order.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) setOrders(prev => prev.filter(o => o.id !== order.id));
      else alert(data.error || 'Could not delete the order');
    } catch { alert('Could not reach the server.'); }
  };

  const phoneFor = (name) =>
    restaurants.find(r => r.name.toLowerCase() === String(name).toLowerCase())?.phone || '';

  const waBtnStyle = {
    padding: '10px 18px', backgroundColor: '#25D366', color: '#04321c',
    border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', textDecoration: 'none', display: 'inline-block'
  };

  return (
    <>
      {/* WORKERS LINK */}
      <div style={{ backgroundColor: '#1e293b', padding: '14px 18px', borderRadius: '10px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontWeight: 'bold' }}>👷 Workers screen</div>
          <div style={{ color: '#64748b', fontSize: '12px' }}>Confirm an order and it appears there instantly — no WhatsApp needed</div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            readOnly value={workersUrl} onClick={(e) => e.target.select()}
            style={{ padding: '8px', borderRadius: '6px', border: '1px solid #334155', backgroundColor: '#0f172a', color: '#94a3b8', fontSize: '12px', width: '250px' }}
          />
          <button onClick={copyWorkersLink} style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '12px' }}>📋 Copy</button>
          <a href={workersUrl} target="_blank" rel="noreferrer" style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #38bdf8', color: '#38bdf8', cursor: 'pointer', fontSize: '12px', textDecoration: 'none' }}>Open</a>
          <button onClick={rotateWorkersLink} title="Old link stops working" style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '12px' }}>↻</button>
        </div>
      </div>
      {lastOrder && (
        <div style={{ backgroundColor: '#0b2e1c', border: '1px solid #22c55e', padding: '20px', borderRadius: '10px', marginBottom: '25px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '15px' }}>
          <div>
            <div style={{ fontWeight: 'bold', color: '#22c55e' }}>✅ Order #{lastOrder.id} saved for {lastOrder.restaurant}</div>
            <div style={{ color: '#94a3b8', fontSize: '13px' }}>{ugx(lastOrder.grand_total)} UGX · stored in the database</div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <a
              href={whatsappLink(phoneFor(lastOrder.restaurant), lastOrder)}
              target="_blank" rel="noreferrer" style={waBtnStyle}
            >Send on WhatsApp</a>
            <button onClick={() => setLastOrder(null)} style={{ background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: '8px', padding: '10px 14px', cursor: 'pointer' }}>Dismiss</button>
          </div>
        </div>
      )}

      {/* ORDER BUILDER */}
      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginBottom: '30px' }}>
        <h2 style={{ marginTop: 0, color: '#f8fafc' }}>Build New Order for:
          <select value={restaurant} onChange={(e) => setRestaurant(e.target.value)} style={{ marginLeft: '10px', padding: '5px 10px', fontSize: '18px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '5px' }}>
            {activeRestaurants.length === 0 && <option value="">Add a restaurant first</option>}
            {activeRestaurants.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
          <button type="button" onClick={repeatLast} style={{ marginLeft: '10px', padding: '7px 14px', fontSize: '13px', backgroundColor: 'transparent', color: '#38bdf8', border: '1px solid #38bdf8', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
            ↻ Repeat last order
          </button>
        </h2>

        <form onSubmit={handleAddItem} style={{ display: 'flex', gap: '15px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '200px', position: 'relative' }}>
            <label style={{ fontSize: '12px', color: '#94a3b8' }}>Search Vegetable</label>
            <input
              type="text" value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)}
              placeholder="Type to search (e.g. Tom...)"
              style={{ padding: '10px', borderRadius: '5px', border: 'none', backgroundColor: '#334155', color: 'white' }}
            />
            {showDropdown && searchQuery && filtered.length > 0 && (
              <div style={{ position: 'absolute', top: '65px', left: 0, right: 0, backgroundColor: '#1e293b', border: '1px solid #38bdf8', borderRadius: '5px', zIndex: 10, maxHeight: '200px', overflowY: 'auto' }}>
                {filtered.map((veg) => (
                  <div key={veg.id}
                    onClick={() => handleSelect(veg)}
                    style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #334155', backgroundColor: selectedVeg.id === veg.id ? '#334155' : 'transparent' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#3b82f6'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = selectedVeg.id === veg.id ? '#334155' : 'transparent'}
                  >
                    {veg.name} - {ugx(veg.price)} UGX / {veg.unit}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', color: '#94a3b8' }}>Weight ({String(selectedVeg.unit || 'kg').toUpperCase()})</label>
            <input type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="2" style={{ padding: '10px', borderRadius: '5px', border: 'none', backgroundColor: '#334155', color: 'white', width: '100px' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', color: '#94a3b8' }}>Price / {String(selectedVeg.unit || 'kg').toUpperCase()} (UGX)</label>
            <input type="number" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} placeholder="Auto" style={{ padding: '10px', borderRadius: '5px', border: 'none', backgroundColor: '#334155', color: '#38bdf8', fontWeight: 'bold', width: '120px' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 'bold' }}>Item Total</label>
            <input type="text" value={calculatedTotal.toLocaleString()} readOnly style={{ padding: '10px', borderRadius: '5px', border: '2px solid #38bdf8', backgroundColor: '#0f172a', color: '#38bdf8', fontWeight: 'bold', width: '100px' }} />
          </div>

          <button type="submit" style={{ padding: '12px 24px', backgroundColor: '#22c55e', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold' }}>
            + Add Item
          </button>
        </form>
      </div>

      {/* CART */}
      {cart.length > 0 && (
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginBottom: '30px', border: '1px solid #38bdf8' }}>
          <h2 style={{ marginTop: 0, color: '#38bdf8' }}>{restaurant.toUpperCase()} ORDER</h2>
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
                <th style={{ padding: '10px' }}>ITEMS</th>
                <th style={{ padding: '10px' }}>WEIGHT</th>
                <th style={{ padding: '10px' }}>PRICES</th>
                <th style={{ padding: '10px' }}>TOTALS</th>
                <th style={{ padding: '10px' }}></th>
              </tr>
            </thead>
            <tbody>
              {cart.map((item, index) => (
                <tr key={item.id} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '10px' }}>{index + 1}. {item.name}</td>
                  <td style={{ padding: '10px' }}>{item.weight} {String(item.unit).toUpperCase()}</td>
                  <td style={{ padding: '10px' }}>{ugx(item.price)}</td>
                  <td style={{ padding: '10px', fontWeight: 'bold' }}>{ugx(item.total)}</td>
                  <td style={{ padding: '10px' }}>
                    <button onClick={() => setCart(cart.filter(i => i.id !== item.id))} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>❌ Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <h2 style={{ margin: 0, color: '#22c55e' }}>GRAND TOTAL: {ugx(grandTotal)} UGX</h2>
            <button onClick={submitOrder} disabled={saving} style={{ padding: '15px 30px', backgroundColor: saving ? '#475569' : '#3b82f6', color: 'white', border: 'none', borderRadius: '5px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
              {saving ? 'Saving...' : 'Submit Final Order 🚀'}
            </button>
          </div>
        </div>
      )}

      {/* HISTORY */}
      <h2>Recent Orders</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '20px' }}>
        {orders.length === 0
          ? <p style={{ color: '#94a3b8' }}>No orders saved yet. Build one above and hit Submit.</p>
          : orders.map((order) => {
              const st = STATUS_STYLES[order.status] || STATUS_STYLES.pending;
              return (
                <div key={order.id} style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #3b82f6' }}>
                  <h3 style={{ margin: '0 0 10px 0', color: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    {order.restaurant.toUpperCase()}
                    <span style={{ color: '#94a3b8', fontSize: '13px' }}>#{order.id}</span>
                  </h3>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontSize: '12px', color: '#64748b' }}>
                      {new Date(order.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <button onClick={() => cycleStatus(order)} title="Click to advance status" style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '999px', border: 'none', cursor: 'pointer', color: st.color, backgroundColor: st.bg, fontWeight: 'bold' }}>
                      {st.label}
                    </button>
                  </div>

                  {order.channel && CHANNEL_LABELS[order.channel] && order.channel !== 'admin' && (
                    <div style={{ marginBottom: '10px' }}>
                      <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '6px', border: `1px solid ${CHANNEL_LABELS[order.channel].color}`, color: CHANNEL_LABELS[order.channel].color }}>
                        {CHANNEL_LABELS[order.channel].label}
                      </span>
                      {order.customer_phone && (
                        <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '8px' }}>
                          📞 {order.customer_phone}{order.area ? ` · ${order.area}` : ''}
                        </span>
                      )}
                      {order.note && <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>📝 {order.note}</div>}
                    </div>
                  )}

                  <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '14px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
                        <th style={{ padding: '5px 0' }}>ITEMS</th>
                        <th>WEIGHT</th>
                        <th>TOTALS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(order.items || []).map((item, i) => (
                        <tr key={i}>
                          <td style={{ padding: '8px 0' }}>{i + 1}. {item.name}</td>
                          <td>{item.weight} KGS</td>
                          <td>{ugx(item.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {order.status === 'pending' && (
                    <button
                      onClick={() => confirmOrder(order)}
                      style={{ width: '100%', marginTop: '14px', padding: '12px', backgroundColor: '#a78bfa', color: '#1e1b4b', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}
                    >
                      ✓ Confirm order → send to workers
                    </button>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px', gap: '10px' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <a href={whatsappLink(phoneFor(order.restaurant), order)} target="_blank" rel="noreferrer"
                         style={{ ...waBtnStyle, padding: '8px 14px', fontSize: '13px' }}>
                        WhatsApp
                      </a>
                      <button onClick={() => deleteOrder(order)} title="Delete this order" style={{ background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: '8px', padding: '7px 10px', cursor: 'pointer', fontSize: '13px' }}>🗑</button>
                    </div>
                    <h3 style={{ margin: 0, color: '#38bdf8' }}>TOTAL: {ugx(order.grand_total ?? order.grandTotal)} UGX</h3>
                  </div>
                </div>
              );
            })}
      </div>
    </>
  );
}

function AnalyticsView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API}/api/analytics?days=${days}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d.ok) setData(d); })
      .catch(err => console.error(err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const card = (label, value, sub) => (
    <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', flex: 1, minWidth: '180px' }}>
      <div style={{ color: '#94a3b8', fontSize: '13px' }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 'bold', color: '#f8fafc', marginTop: '6px' }}>{value}</div>
      {sub && <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>{sub}</div>}
    </div>
  );

  if (loading && !data) return <p style={{ color: '#94a3b8' }}>Loading analytics...</p>;
  if (!data) return <p style={{ color: '#ef4444' }}>Could not load analytics. Is the server running?</p>;

  const maxDaily = Math.max(...data.daily.map(d => d.revenue), 1);
  const maxRest = Math.max(...data.byRestaurant.map(r => r.revenue), 1);
  const topVeg = data.byVegetable.slice(0, 10);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <h2 style={{ margin: 0 }}>📊 Analytics</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #334155', cursor: 'pointer', backgroundColor: days === d ? '#38bdf8' : 'transparent', color: days === d ? '#0f172a' : '#94a3b8', fontWeight: 'bold' }}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', marginTop: '20px' }}>
        {card('Revenue', `${ugx(data.totals.revenue)} UGX`)}
        {card('Profit', `${ugx(data.totals.profit)} UGX`, `${data.totals.margin}% margin`)}
        {card('Orders', data.totals.orders, `${ugx(data.totals.kg)} KGS moved`)}
        {card('Average order', `${ugx(Math.round(data.totals.avg_order))} UGX`)}
        {card('All time', `${ugx(data.allTime.revenue)} UGX`, `${data.allTime.orders} orders`)}
      </div>

      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginTop: '20px' }}>
        <h3 style={{ marginTop: 0 }}>Revenue per day</h3>
        {data.daily.length === 0
          ? <p style={{ color: '#94a3b8' }}>No orders in this period.</p>
          : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '160px', overflowX: 'auto', paddingBottom: '5px' }}>
              {data.daily.map((d, i) => (
                <div key={d.day} title={`${d.day}: ${ugx(d.revenue)} UGX (${d.orders} orders)`} style={{ flex: '1 0 14px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                  <div style={{ height: `${Math.max((d.revenue / maxDaily) * 100, 2)}%`, backgroundColor: '#38bdf8', borderRadius: '3px 3px 0 0' }} />
                  {i % Math.ceil(data.daily.length / 12) === 0 && (
                    <div style={{ fontSize: '9px', color: '#64748b', whiteSpace: 'nowrap', transform: 'rotate(-45deg)', transformOrigin: 'top left', marginTop: '4px' }}>
                      {d.day.slice(5)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
      </div>

      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginTop: '20px' }}>
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', flex: 1, minWidth: '320px' }}>
          <h3 style={{ marginTop: 0 }}>Revenue by restaurant</h3>
          {data.byRestaurant.length === 0 && <p style={{ color: '#94a3b8' }}>No data yet.</p>}
          {data.byRestaurant.map(r => (
            <div key={r.restaurant} style={{ marginBottom: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '4px' }}>
                <span>{r.restaurant}</span>
                <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{ugx(r.revenue)} UGX</span>
              </div>
              <div style={{ backgroundColor: '#0f172a', borderRadius: '4px', height: '10px' }}>
                <div style={{ width: `${(r.revenue / maxRest) * 100}%`, backgroundColor: '#22c55e', height: '100%', borderRadius: '4px' }} />
              </div>
              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '3px' }}>{r.orders} order{r.orders === 1 ? '' : 's'}</div>
            </div>
          ))}
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', flex: 1, minWidth: '320px' }}>
          <h3 style={{ marginTop: 0 }}>Top vegetables</h3>
          {topVeg.length === 0 && <p style={{ color: '#94a3b8' }}>No data yet.</p>}
          {topVeg.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                  <th style={{ textAlign: 'left', padding: '6px 0' }}>ITEM</th>
                  <th style={{ textAlign: 'right' }}>KGS</th>
                  <th style={{ textAlign: 'right' }}>REVENUE</th>
                  <th style={{ textAlign: 'right' }}>PROFIT</th>
                </tr>
              </thead>
              <tbody>
                {topVeg.map(v => (
                  <tr key={v.name} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px 0' }}>{v.name}</td>
                    <td style={{ textAlign: 'right', color: '#94a3b8' }}>{Number(v.kg).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#38bdf8' }}>{ugx(v.revenue)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', color: (v.profit ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                      {ugx(v.profit)}{v.margin !== undefined ? ` · ${v.margin}%` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <p style={{ color: '#475569', fontSize: '12px', marginTop: '20px' }}>
        Updated {new Date(data.generatedAt).toLocaleTimeString('en-GB')} · showing last {data.days} days
      </p>
    </div>
  );
}

function AccountsView() {
  const [data, setData] = useState(null);
  const [restaurants, setRestaurants] = useState([]);
  const [openStatement, setOpenStatement] = useState('');
  const [statement, setStatement] = useState(null);
  const [payFor, setPayFor] = useState('');
  const [pay, setPay] = useState({ amount: '', method: 'cash', note: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([
        fetch(`${API}/api/accounts`).then(x => x.json()),
        fetch(`${API}/api/restaurants`).then(x => x.json()),
      ]);
      if (a.ok) setData(a);
      if (r.ok) setRestaurants(r.restaurants);
    } catch (err) { console.error(err); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const phoneFor = (name) =>
    restaurants.find(r => r.name.toLowerCase() === String(name).toLowerCase())?.phone || '';

  const toggleStatement = async (name) => {
    if (openStatement === name) { setOpenStatement(''); setStatement(null); return; }
    setOpenStatement(name);
    setStatement(null);
    try {
      const res = await fetch(`${API}/api/accounts/statement?restaurant=${encodeURIComponent(name)}&days=365`);
      const d = await res.json();
      if (d.ok) setStatement(d);
    } catch { alert('Could not load the statement.'); }
  };

  const recordPayment = async (e) => {
    e.preventDefault();
    if (!payFor) return;
    if (!pay.amount || Number(pay.amount) <= 0) return alert('Enter the amount paid');
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurant: payFor, amount: Number(pay.amount), method: pay.method, note: pay.note })
      });
      const d = await res.json();
      if (d.ok) {
        setMsg(`Payment of ${ugx(pay.amount)} UGX recorded for ${payFor}`);
        setTimeout(() => setMsg(''), 3000);
        setPay({ amount: '', method: 'cash', note: '' });
        setPayFor('');
        await load();
        if (openStatement === payFor) await toggleStatement(payFor);
      } else {
        alert(d.error || 'Could not record the payment');
      }
    } catch { alert('Could not reach the server.'); }
    setBusy(false);
  };

  const statementText = (s) => {
    const lines = s.entries.map(en =>
      `${new Date(en.date).toLocaleDateString('en-GB')}  ${en.type === 'order' ? 'Order' : 'Paid'}  ${en.debit ? '+' + ugx(en.debit) : '-' + ugx(en.credit)}`
    );
    return [
      `*STATEMENT - ${String(s.restaurant).toUpperCase()}*`,
      new Date().toLocaleDateString('en-GB'),
      '',
      ...lines,
      '',
      `Total billed: ${ugx(s.totals.billed)} UGX`,
      `Total paid:   ${ugx(s.totals.paid)} UGX`,
      `*BALANCE: ${ugx(s.totals.balance)} UGX*`,
      '',
      'Boda Boda Express'
    ].join('\n');
  };

  if (!data) return <p style={{ color: '#94a3b8' }}>Loading accounts...</p>;

  const card = (label, value, sub, color) => (
    <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', flex: 1, minWidth: '180px' }}>
      <div style={{ color: '#94a3b8', fontSize: '13px' }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 'bold', color: color || '#f8fafc', marginTop: '6px' }}>{value}</div>
      {sub && <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>{sub}</div>}
    </div>
  );

  const th = { textAlign: 'left', padding: '10px 8px', color: '#94a3b8', fontWeight: 'normal', fontSize: '12px' };
  const td = { padding: '10px 8px', borderTop: '1px solid #0f172a' };
  const smallBtn = { padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '12px' };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>💰 Accounts</h2>
      <p style={{ color: '#94a3b8', marginTop: '-8px' }}>
        What each restaurant has been billed, what they have paid, and what is still owed.
      </p>
      {msg && <div style={{ color: '#22c55e', marginBottom: '10px' }}>{msg}</div>}

      <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
        {card('Outstanding', `${ugx(data.totals.balance)} UGX`, 'owed to you right now', data.totals.balance > 0 ? '#fbbf24' : '#22c55e')}
        {card('Billed (all time)', `${ugx(data.totals.billed)} UGX`)}
        {card('Received', `${ugx(data.totals.paid)} UGX`)}
      </div>

      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginTop: '20px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '700px' }}>
          <thead>
            <tr>
              <th style={th}>RESTAURANT</th>
              <th style={th}>ORDERS</th>
              <th style={th}>BILLED</th>
              <th style={th}>PAID</th>
              <th style={th}>BALANCE</th>
              <th style={{ ...th, textAlign: 'right' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map(a => (
              <tr key={a.restaurant}>
                <td style={{ ...td, fontWeight: 'bold' }}>{a.restaurant}</td>
                <td style={{ ...td, color: '#94a3b8' }}>{a.orders}</td>
                <td style={{ ...td }}>{ugx(a.billed)}</td>
                <td style={{ ...td, color: '#22c55e' }}>{ugx(a.paid)}</td>
                <td style={{ ...td, fontWeight: 'bold', color: a.balance > 0 ? '#fbbf24' : '#22c55e' }}>
                  {ugx(a.balance)} UGX
                </td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => { setPayFor(a.restaurant); setPay({ amount: '', method: 'cash', note: '' }); }} style={{ ...smallBtn, marginRight: '6px' }}>+ Payment</button>
                  <button onClick={() => toggleStatement(a.restaurant)} style={smallBtn}>
                    {openStatement === a.restaurant ? 'Hide' : 'Statement'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {payFor && (
        <form onSubmit={recordPayment} style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginTop: '15px', border: '1px solid #22c55e' }}>
          <h3 style={{ marginTop: 0 }}>Record payment from {payFor}</h3>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '12px', color: '#94a3b8' }}>Amount (UGX)</label>
              <input type="number" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} style={{ padding: '10px', borderRadius: '6px', border: 'none', backgroundColor: '#0f172a', color: '#22c55e', fontWeight: 'bold', width: '140px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <label style={{ fontSize: '12px', color: '#94a3b8' }}>Method</label>
              <select value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })} style={{ padding: '10px', borderRadius: '6px', border: 'none', backgroundColor: '#0f172a', color: 'white' }}>
                <option value="cash">Cash</option>
                <option value="momo">Mobile money</option>
                <option value="bank">Bank</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '180px' }}>
              <label style={{ fontSize: '12px', color: '#94a3b8' }}>Note (optional)</label>
              <input value={pay.note} onChange={e => setPay({ ...pay, note: e.target.value })} placeholder="e.g. part payment for last week" style={{ padding: '10px', borderRadius: '6px', border: 'none', backgroundColor: '#0f172a', color: 'white', width: '100%' }} />
            </div>
            <button type="submit" disabled={busy} style={{ padding: '11px 22px', backgroundColor: busy ? '#475569' : '#22c55e', color: '#04321c', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer' }}>
              Save payment
            </button>
            <button type="button" onClick={() => setPayFor('')} style={smallBtn}>Cancel</button>
          </div>
        </form>
      )}

      {openStatement && (
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginTop: '15px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <h3 style={{ margin: 0 }}>Statement — {openStatement}</h3>
            {statement && (
              <a
                href={`https://wa.me/${phoneFor(openStatement).replace(/\D/g, '')}?text=${encodeURIComponent(statementText(statement))}`}
                target="_blank" rel="noreferrer"
                style={{ padding: '8px 16px', backgroundColor: '#25D366', color: '#04321c', borderRadius: '8px', fontWeight: 'bold', fontSize: '13px', textDecoration: 'none' }}
              >Send on WhatsApp</a>
            )}
          </div>

          {!statement && <p style={{ color: '#94a3b8' }}>Loading...</p>}
          {statement && (
            <>
              {statement.entries.length === 0
                ? <p style={{ color: '#94a3b8' }}>No orders or payments in the last year.</p>
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '12px', minWidth: '600px' }}>
                    <thead>
                      <tr>
                        <th style={th}>DATE</th>
                        <th style={th}>DESCRIPTION</th>
                        <th style={{ ...th, textAlign: 'right' }}>BILLED</th>
                        <th style={{ ...th, textAlign: 'right' }}>PAID</th>
                        <th style={{ ...th, textAlign: 'right' }}>BALANCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.entries.map((en, i) => (
                        <tr key={`${en.type}-${en.id}-${i}`}>
                          <td style={{ ...td, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                            {new Date(en.date).toLocaleDateString('en-GB')}
                          </td>
                          <td style={td}>{en.note}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#fbbf24' }}>{en.debit ? ugx(en.debit) : ''}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#22c55e' }}>{en.credit ? ugx(en.credit) : ''}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 'bold' }}>{ugx(en.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={{ ...td, fontWeight: 'bold' }} colSpan={2}>Balance</td>
                        <td style={{ ...td, textAlign: 'right' }}>{ugx(statement.totals.billed)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{ugx(statement.totals.paid)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 'bold', color: statement.totals.balance > 0 ? '#fbbf24' : '#22c55e' }}>
                          {ugx(statement.totals.balance)} UGX
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PricesView({ products, reloadProducts, restaurants, reloadRestaurants }) {
  const [newProduct, setNewProduct] = useState({ name: '', price: '', cost: '' });
  const [newRestaurant, setNewRestaurant] = useState({ name: '', phone: '' });
  const [edits, setEdits] = useState({});       // productId -> {name, price, unit}
  const [restEdits, setRestEdits] = useState({}); // restaurantId -> {name, phone}
  const [shopCfg, setShopCfg] = useState({ name: '', phone: '', fee: '', min: '', areas: '' });
  const fileRef = useRef(null);
  const [uploadFor, setUploadFor] = useState(null);

  const pickImage = (product) => {
    setUploadFor(product);
    fileRef.current?.click();
  };

  const onFilePicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !uploadFor) return;
    try {
      const dataUrl = await resizeImage(file, 480, 0.7);
      const ok = await patchProduct(uploadFor.id, { image: dataUrl });
      if (ok) flash(`Photo saved for ${uploadFor.name}`);
    } catch (err) {
      alert(err.message || 'Could not use that photo');
    }
    setUploadFor(null);
  };

  const clearImage = async (p) => {
    const ok = await patchProduct(p.id, { image: '' });
    if (ok) flash('Photo removed');
  };

  useEffect(() => {
    fetch(`${API}/api/shop/settings`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) setShopCfg({
          name: d.settings.name, phone: d.settings.phone,
          fee: String(d.settings.fee), min: String(d.settings.min), areas: d.settings.areas
        });
      })
      .catch(() => {});
  }, []);

  const saveShop = async (e) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`${API}/api/shop/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: shopCfg.name, phone: shopCfg.phone,
        fee: Number(shopCfg.fee) || 0, min: Number(shopCfg.min) || 0, areas: shopCfg.areas
      })
    });
    const d = await res.json();
    if (d.ok) flash('Shop settings saved');
    else alert(d.error || 'Could not save');
    setBusy(false);
  };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 2500); };

  const patchProduct = async (id, payload) => {
    setBusy(true);
    const res = await fetch(`${API}/api/products/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) alert(data.error || 'Could not update product');
    await reloadProducts();
    setBusy(false);
    return data.ok;
  };

  const patchRestaurant = async (id, payload) => {
    setBusy(true);
    const res = await fetch(`${API}/api/restaurants/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) alert(data.error || 'Could not update restaurant');
    await reloadRestaurants();
    setBusy(false);
    return data.ok;
  };

  const addProduct = async (e) => {
    e.preventDefault();
    if (!newProduct.name || !newProduct.price) return alert('Enter a name and a price');
    setBusy(true);
    const res = await fetch(`${API}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProduct.name, price: Number(newProduct.price), cost: Number(newProduct.cost) || 0 })
    });
    const data = await res.json();
    if (data.ok) { setNewProduct({ name: '', price: '', cost: '' }); flash(`Added ${data.product.name}`); await reloadProducts(); }
    else alert(data.error || 'Could not add product');
    setBusy(false);
  };

  const addRestaurant = async (e) => {
    e.preventDefault();
    if (!newRestaurant.name) return alert('Enter the restaurant name');
    setBusy(true);
    const res = await fetch(`${API}/api/restaurants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newRestaurant)
    });
    const data = await res.json();
    if (data.ok) { setNewRestaurant({ name: '', phone: '' }); flash(`Added ${data.restaurant.name}`); await reloadRestaurants(); }
    else alert(data.error || 'Could not add restaurant');
    setBusy(false);
  };

  const buyerLinkUrl = (r) => `${location.origin}/order/${r.token}`;

  const copyBuyerLink = async (r) => {
    const url = buyerLinkUrl(r);
    try {
      await navigator.clipboard.writeText(url);
      flash(`Link copied — send it to ${r.name}`);
    } catch {
      prompt('Copy this ordering link:', url);
    }
  };

  const rotateLink = async (r) => {
    if (!confirm(`Give ${r.name} a new ordering link?\nThe old link stops working immediately.`)) return;
    setBusy(true);
    const res = await fetch(`${API}/api/restaurants/${r.id}/rotate-token`, { method: 'POST' });
    const d = await res.json();
    if (d.ok) { flash('New ordering link created'); await reloadRestaurants(); }
    else alert(d.error || 'Could not create a new link');
    setBusy(false);
  };

  const cellInput = { padding: '8px', borderRadius: '6px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '14px' };
  const saveStyle = { padding: '7px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px', backgroundColor: '#38bdf8', color: '#0f172a' };
  const toggleStyle = { padding: '7px 14px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', fontSize: '13px', backgroundColor: 'transparent', color: '#94a3b8' };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>💲 Prices &amp; Stock</h2>
      <p style={{ color: '#94a3b8', marginTop: '-8px' }}>
        Change a price here and the order screen uses it immediately. "Cost" is what you pay per kg — it is what turns revenue into profit in Analytics. "Hide" keeps the item out of new orders without losing its history.
      </p>
      {msg && <div style={{ color: '#22c55e', fontSize: '14px', marginBottom: '10px' }}>{msg}</div>}
      <input ref={fileRef} type="file" accept="image/*" onChange={onFilePicked} style={{ display: 'none' }} />

      {/* ADD PRODUCT */}
      <form onSubmit={addProduct} style={{ backgroundColor: '#1e293b', padding: '15px', borderRadius: '10px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '180px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>New item</label>
          <input value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })} placeholder="e.g. Spinach" style={{ ...cellInput, width: '100%' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Selling price / kg (UGX)</label>
          <input type="number" value={newProduct.price} onChange={e => setNewProduct({ ...newProduct, price: e.target.value })} placeholder="3000" style={{ ...cellInput, width: '120px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Cost price / kg (UGX)</label>
          <input type="number" value={newProduct.cost} onChange={e => setNewProduct({ ...newProduct, cost: e.target.value })} placeholder="2000" style={{ ...cellInput, width: '120px' }} />
        </div>
        <button type="submit" disabled={busy} style={{ ...saveStyle, padding: '10px 20px', backgroundColor: '#22c55e', color: 'white' }}>+ Add item</button>
      </form>

      {/* PRODUCTS TABLE */}
      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '600px' }}>
          <thead>
            <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155' }}>
              <th style={{ textAlign: 'left', padding: '8px 0' }}>PHOTO</th>
              <th style={{ textAlign: 'left' }}>ITEM</th>
              <th style={{ textAlign: 'left' }}>PRICE / KG</th>
              <th style={{ textAlign: 'left' }}>COST / KG</th>
              <th style={{ textAlign: 'left' }}>UNIT</th>
              <th style={{ textAlign: 'right' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {products.map(p => {
              const edit = edits[p.id] || { name: p.name, price: p.price, cost: p.cost ?? 0, unit: p.unit };
              const dirty = edit.name !== p.name || Number(edit.price) !== Number(p.price) || Number(edit.cost) !== Number(p.cost ?? 0) || edit.unit !== p.unit;
              return (
                <tr key={p.id} style={{ borderBottom: '1px solid #0f172a', opacity: p.active ? 1 : 0.45 }}>
                  <td style={{ paddingRight: '8px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                      <ProductThumb src={p.image} name={p.name} size={44} />
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button onClick={() => pickImage(p)} style={{ background: 'none', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: '11px' }}>
                          {p.image ? 'change' : 'add'}
                        </button>
                        {p.image && (
                          <button onClick={() => clearImage(p)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px' }}>✕</button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <input value={edit.name} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, name: e.target.value } })} style={{ ...cellInput, width: '170px' }} />
                  </td>
                  <td>
                    <input type="number" value={edit.price} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, price: e.target.value } })} style={{ ...cellInput, width: '110px', color: '#38bdf8', fontWeight: 'bold' }} />
                  </td>
                  <td>
                    <input type="number" value={edit.cost} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, cost: e.target.value } })} placeholder="0" style={{ ...cellInput, width: '100px', color: '#fbbf24' }} />
                  </td>
                  <td>
                    <input value={edit.unit} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, unit: e.target.value } })} style={{ ...cellInput, width: '70px' }} />
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      disabled={!dirty || busy}
                      onClick={async () => {
                        const ok = await patchProduct(p.id, { name: edit.name, price: Number(edit.price), cost: Number(edit.cost), unit: edit.unit });
                        if (ok) {
                          const next = { ...edits }; delete next[p.id]; setEdits(next);
                          flash(`Saved ${edit.name}`);
                        }
                      }}
                      style={{ ...saveStyle, opacity: dirty ? 1 : 0.35, marginRight: '8px' }}
                    >Save</button>
                    <button onClick={() => patchProduct(p.id, { active: p.active ? 0 : 1 })} style={toggleStyle}>
                      {p.active ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {products.length === 0 && (
              <tr><td colSpan="5" style={{ padding: '15px 0', color: '#94a3b8' }}>No items yet — add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* RESTAURANTS */}
      <h2 style={{ marginTop: '35px' }}>Restaurants &amp; WhatsApp numbers</h2>
      <p style={{ color: '#94a3b8', marginTop: '-8px' }}>
        Add a number and the WhatsApp button on each order goes straight to that restaurant. Leave it empty to just share the message.
      </p>

      <form onSubmit={addRestaurant} style={{ backgroundColor: '#1e293b', padding: '15px', borderRadius: '10px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '180px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>New restaurant</label>
          <input value={newRestaurant.name} onChange={e => setNewRestaurant({ ...newRestaurant, name: e.target.value })} placeholder="e.g. Cafe Javas" style={{ ...cellInput, width: '100%' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>WhatsApp number</label>
          <input value={newRestaurant.phone} onChange={e => setNewRestaurant({ ...newRestaurant, phone: e.target.value })} placeholder="2567XXXXXXXX" style={{ ...cellInput, width: '160px' }} />
        </div>
        <button type="submit" disabled={busy} style={{ ...saveStyle, padding: '10px 20px', backgroundColor: '#22c55e', color: 'white' }}>+ Add restaurant</button>
      </form>

      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '560px' }}>
          <thead>
            <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155' }}>
              <th style={{ textAlign: 'left', padding: '8px 0' }}>RESTAURANT</th>
              <th style={{ textAlign: 'left' }}>WHATSAPP NUMBER</th>
              <th style={{ textAlign: 'left' }}>ORDERING LINK</th>
              <th style={{ textAlign: 'right' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {restaurants.map(r => {
              const edit = restEdits[r.id] || { name: r.name, phone: r.phone };
              const dirty = edit.name !== r.name || edit.phone !== r.phone;
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid #0f172a', opacity: r.active ? 1 : 0.45 }}>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <input value={edit.name} onChange={e => setRestEdits({ ...restEdits, [r.id]: { ...edit, name: e.target.value } })} style={{ ...cellInput, width: '180px' }} />
                  </td>
                  <td>
                    <input value={edit.phone} onChange={e => setRestEdits({ ...restEdits, [r.id]: { ...edit, phone: e.target.value } })} placeholder="2567XXXXXXXX" style={{ ...cellInput, width: '170px' }} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => copyBuyerLink(r)} style={{ ...toggleStyle, marginRight: '6px' }} title="Copy the ordering link">
                      📋 Copy
                    </button>
                    <button
                      onClick={() => window.open(`https://wa.me/${String(r.phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${r.name}, order your vegetables here: ${buyerLinkUrl(r)}`)}`, '_blank')}
                      style={{ ...toggleStyle, marginRight: '6px', color: '#25D366', borderColor: '#25D366' }}
                      title="Send the link on WhatsApp"
                    >
                      Send
                    </button>
                    <button onClick={() => rotateLink(r)} style={toggleStyle} title="Old link stops working">↻</button>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      disabled={!dirty || busy}
                      onClick={async () => {
                        const ok = await patchRestaurant(r.id, { name: edit.name, phone: edit.phone });
                        if (ok) {
                          const next = { ...restEdits }; delete next[r.id]; setRestEdits(next);
                          flash(`Saved ${edit.name}`);
                        }
                      }}
                      style={{ ...saveStyle, opacity: dirty ? 1 : 0.35, marginRight: '8px' }}
                    >Save</button>
                    <button onClick={() => patchRestaurant(r.id, { active: r.active ? 0 : 1 })} style={toggleStyle}>
                      {r.active ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {restaurants.length === 0 && (
              <tr><td colSpan="4" style={{ padding: '15px 0', color: '#94a3b8' }}>No restaurants yet — add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ONLINE SHOP */}
      <h2 style={{ marginTop: '35px' }}>🏪 Online shop</h2>
      <p style={{ color: '#94a3b8', marginTop: '-8px' }}>
        Your public shop page: <b style={{ color: '#38bdf8' }}>{location.origin}/shop</b> — anyone can order there, and it lands in Orders tagged “Online shop”.
      </p>

      <form onSubmit={saveShop} style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '180px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Shop name</label>
          <input value={shopCfg.name} onChange={e => setShopCfg({ ...shopCfg, name: e.target.value })} style={{ ...cellInput, width: '100%' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Phone to show</label>
          <input value={shopCfg.phone} onChange={e => setShopCfg({ ...shopCfg, phone: e.target.value })} placeholder="0772..." style={{ ...cellInput, width: '150px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Delivery fee</label>
          <input type="number" value={shopCfg.fee} onChange={e => setShopCfg({ ...shopCfg, fee: e.target.value })} placeholder="5000" style={{ ...cellInput, width: '110px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Minimum order</label>
          <input type="number" value={shopCfg.min} onChange={e => setShopCfg({ ...shopCfg, min: e.target.value })} placeholder="10000" style={{ ...cellInput, width: '110px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '220px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Delivery areas (comma separated)</label>
          <input value={shopCfg.areas} onChange={e => setShopCfg({ ...shopCfg, areas: e.target.value })} placeholder="Kira, Ntinda, Bukoto" style={{ ...cellInput, width: '100%' }} />
        </div>
        <button type="submit" disabled={busy} style={{ ...saveStyle, padding: '10px 20px' }}>Save shop</button>
      </form>
    </div>
  );
}

export default App;
