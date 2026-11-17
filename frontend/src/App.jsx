import { useState, useEffect, useCallback } from 'react';
import './App.css';

// Same origin when Bun serves the build; localhost:3000 during `vite dev`.
const API = import.meta.env.DEV ? 'http://localhost:3000' : '';
const WS_URL = import.meta.env.DEV
  ? 'ws://localhost:3000/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

const ugx = (n) => Number(n || 0).toLocaleString('en-UG');
const STATUS_STYLES = {
  pending:    { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)', label: 'Pending' },
  dispatched: { color: '#38bdf8', bg: 'rgba(56,189,248,0.15)', label: 'Dispatched' },
  delivered:  { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',  label: 'Delivered' }
};
const NEXT_STATUS = { pending: 'dispatched', dispatched: 'delivered', delivered: 'pending' };

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

  useEffect(() => {
    if (!restaurant && activeRestaurants.length) setRestaurant(activeRestaurants[0].name);
  }, [activeRestaurants, restaurant]);

  const calculatedTotal = (Number(weight) || 0) * (Number(pricePerKg) || 0);
  const grandTotal = cart.reduce((sum, item) => sum + item.total, 0);
  const filtered = activeProducts.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

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

  const phoneFor = (name) =>
    restaurants.find(r => r.name.toLowerCase() === String(name).toLowerCase())?.phone || '';

  const waBtnStyle = {
    padding: '10px 18px', backgroundColor: '#25D366', color: '#04321c',
    border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', textDecoration: 'none', display: 'inline-block'
  };

  return (
    <>
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

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '15px', gap: '10px' }}>
                    <a href={whatsappLink(phoneFor(order.restaurant), order)} target="_blank" rel="noreferrer"
                       style={{ ...waBtnStyle, padding: '8px 14px', fontSize: '13px' }}>
                      WhatsApp
                    </a>
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
                </tr>
              </thead>
              <tbody>
                {topVeg.map(v => (
                  <tr key={v.name} style={{ borderBottom: '1px solid #1e293b' }}>
                    <td style={{ padding: '8px 0' }}>{v.name}</td>
                    <td style={{ textAlign: 'right', color: '#94a3b8' }}>{Number(v.kg).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#38bdf8' }}>{ugx(v.revenue)}</td>
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

function PricesView({ products, reloadProducts, restaurants, reloadRestaurants }) {
  const [newProduct, setNewProduct] = useState({ name: '', price: '' });
  const [newRestaurant, setNewRestaurant] = useState({ name: '', phone: '' });
  const [edits, setEdits] = useState({});       // productId -> {name, price, unit}
  const [restEdits, setRestEdits] = useState({}); // restaurantId -> {name, phone}
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
      body: JSON.stringify({ name: newProduct.name, price: Number(newProduct.price) })
    });
    const data = await res.json();
    if (data.ok) { setNewProduct({ name: '', price: '' }); flash(`Added ${data.product.name}`); await reloadProducts(); }
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

  const cellInput = { padding: '8px', borderRadius: '6px', border: '1px solid #334155', backgroundColor: '#0f172a', color: 'white', fontSize: '14px' };
  const saveStyle = { padding: '7px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px', backgroundColor: '#38bdf8', color: '#0f172a' };
  const toggleStyle = { padding: '7px 14px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', fontSize: '13px', backgroundColor: 'transparent', color: '#94a3b8' };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>💲 Prices &amp; Stock</h2>
      <p style={{ color: '#94a3b8', marginTop: '-8px' }}>
        Change a price here and the order screen uses it immediately. "Hide" keeps the item out of new orders without losing its history.
      </p>
      {msg && <div style={{ color: '#22c55e', fontSize: '14px', marginBottom: '10px' }}>{msg}</div>}

      {/* ADD PRODUCT */}
      <form onSubmit={addProduct} style={{ backgroundColor: '#1e293b', padding: '15px', borderRadius: '10px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: '180px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>New item</label>
          <input value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })} placeholder="e.g. Spinach" style={{ ...cellInput, width: '100%' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <label style={{ fontSize: '12px', color: '#94a3b8' }}>Price / kg (UGX)</label>
          <input type="number" value={newProduct.price} onChange={e => setNewProduct({ ...newProduct, price: e.target.value })} placeholder="3000" style={{ ...cellInput, width: '120px' }} />
        </div>
        <button type="submit" disabled={busy} style={{ ...saveStyle, padding: '10px 20px', backgroundColor: '#22c55e', color: 'white' }}>+ Add item</button>
      </form>

      {/* PRODUCTS TABLE */}
      <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '600px' }}>
          <thead>
            <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155' }}>
              <th style={{ textAlign: 'left', padding: '8px 0' }}>ITEM</th>
              <th style={{ textAlign: 'left' }}>PRICE / KG</th>
              <th style={{ textAlign: 'left' }}>UNIT</th>
              <th style={{ textAlign: 'right' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {products.map(p => {
              const edit = edits[p.id] || { name: p.name, price: p.price, unit: p.unit };
              const dirty = edit.name !== p.name || Number(edit.price) !== Number(p.price) || edit.unit !== p.unit;
              return (
                <tr key={p.id} style={{ borderBottom: '1px solid #0f172a', opacity: p.active ? 1 : 0.45 }}>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <input value={edit.name} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, name: e.target.value } })} style={{ ...cellInput, width: '170px' }} />
                  </td>
                  <td>
                    <input type="number" value={edit.price} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, price: e.target.value } })} style={{ ...cellInput, width: '110px', color: '#38bdf8', fontWeight: 'bold' }} />
                  </td>
                  <td>
                    <input value={edit.unit} onChange={e => setEdits({ ...edits, [p.id]: { ...edit, unit: e.target.value } })} style={{ ...cellInput, width: '70px' }} />
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      disabled={!dirty || busy}
                      onClick={async () => {
                        const ok = await patchProduct(p.id, { name: edit.name, price: Number(edit.price), unit: edit.unit });
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
              <tr><td colSpan="4" style={{ padding: '15px 0', color: '#94a3b8' }}>No items yet — add one above.</td></tr>
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
              <tr><td colSpan="3" style={{ padding: '15px 0', color: '#94a3b8' }}>No restaurants yet — add one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default App;
