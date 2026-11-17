import { useState, useEffect, useCallback } from 'react';
import './App.css';

const VEGETABLES = [
  { name: "Onions", price: 3000 },
  { name: "Tomatoes", price: 2000 },
  { name: "Carrots", price: 3500 },
  { name: "Cabbage", price: 2500 },
  { name: "Irish Potatoes", price: 2700 },
  { name: "Ginger", price: 5000 },
  { name: "Garlic", price: 14000 },
  { name: "Green Peppers", price: 4000 },
  { name: "Bell Peppers", price: 8000 },
  { name: "Lettuce", price: 4000 },
  { name: "Broccoli", price: 6000 },
  { name: "Cauliflower", price: 5000 },
  { name: "Cucumber", price: 3000 },
  { name: "Zucchini", price: 3000 },
  { name: "Passion Fruit", price: 7000 },
  { name: "Lemons", price: 2500 },
  { name: "Oranges", price: 3000 },
  { name: "Pineapples", price: 3500 },
  { name: "Watermelon", price: 8000 },
  { name: "Matooke", price: 25000 }
];

const RESTAURANTS = ["Panther", "Wanda", "The Bench", "Molover"];

// Same origin in production (Bun serves the build); localhost:3000 during `vite dev`.
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

function App() {
  const [page, setPage] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState(false);

  const [restaurant, setRestaurant] = useState('Panther');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedVeg, setSelectedVeg] = useState({ name: '', price: 0 });
  const [showDropdown, setShowDropdown] = useState(false);
  const [weight, setWeight] = useState('');
  const [pricePerKg, setPricePerKg] = useState('');
  const [cart, setCart] = useState([]);

  const calculatedTotal = (Number(weight) || 0) * (Number(pricePerKg) || 0);
  const grandTotal = cart.reduce((sum, item) => sum + item.total, 0);
  const filteredVegetables = VEGETABLES.filter(v =>
    v.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Load saved order history from the database
  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/orders?limit=100`);
      const data = await res.json();
      if (data.ok) setOrders(data.orders);
    } catch (err) {
      console.error('Could not load orders', err);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  // Live updates for every screen/device
  useEffect(() => {
    let ws;
    let retry;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const updated = JSON.parse(event.data);
        if (!updated?.id) return;
        setOrders(prev => {
          const rest = prev.filter(o => o.id !== updated.id);
          return [updated, ...rest].sort((a, b) => b.id - a.id);
        });
      };
      ws.onclose = () => {
        setConnected(false);
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { clearTimeout(retry); ws?.close(); };
  }, []);

  const handleSelectVegetable = (veg) => {
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
      id: Date.now(),
      name: selectedVeg.name,
      weight: Number(weight),
      price: Number(pricePerKg),
      total: calculatedTotal
    }]);

    setSearchQuery('');
    setSelectedVeg({ name: '', price: 0 });
    setPricePerKg('');
    setWeight('');
    setShowDropdown(false);
  };

  const removeItem = (id) => setCart(cart.filter(item => item.id !== id));

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
        setOrders(prev => [data.order, ...prev]);
        setCart([]);
      } else {
        alert("Could not save order: " + (data.error || 'unknown error'));
      }
    } catch (err) {
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
    } catch (err) {
      alert("Could not update the order status.");
    }
  };

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

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', backgroundColor: '#0f172a', color: 'white' }}>

      {/* SIDEBAR */}
      <div style={{ width: '250px', backgroundColor: '#1e293b', padding: '20px', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ color: '#38bdf8', marginTop: 0 }}>🛵 Boda Boda Express</h2>
        <p style={{ color: '#94a3b8', fontSize: '14px' }}>Admin Dashboard</p>
        <div style={{ marginTop: '30px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {navBtn('orders', '📦 Orders')}
          {navBtn('analytics', '📊 Analytics')}
        </div>
        <div style={{ marginTop: 'auto', paddingBottom: '20px', fontSize: '14px' }}>
          Status: {connected
            ? <span style={{ color: '#22c55e' }}>🟢 Live</span>
            : <span style={{ color: '#ef4444' }}>🔴 Offline</span>}
          <div style={{ color: '#64748b', marginTop: '8px' }}>{orders.length} order{orders.length === 1 ? '' : 's'} saved</div>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, padding: '40px', overflowY: 'auto' }}>
        {page === 'orders' ? (
          <>
            {/* ORDER BUILDER */}
            <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '10px', marginBottom: '30px' }}>
              <h2 style={{ marginTop: 0, color: '#f8fafc' }}>Build New Order for:
                <select value={restaurant} onChange={(e) => setRestaurant(e.target.value)} style={{ marginLeft: '10px', padding: '5px 10px', fontSize: '18px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '5px' }}>
                  {RESTAURANTS.map(r => <option key={r} value={r}>{r}</option>)}
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
                  {showDropdown && searchQuery && filteredVegetables.length > 0 && (
                    <div style={{ position: 'absolute', top: '65px', left: 0, right: 0, backgroundColor: '#1e293b', border: '1px solid #38bdf8', borderRadius: '5px', zIndex: 10, maxHeight: '200px', overflowY: 'auto' }}>
                      {filteredVegetables.map((veg, index) => (
                        <div
                          key={index}
                          onClick={() => handleSelectVegetable(veg)}
                          style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #334155', backgroundColor: selectedVeg.name === veg.name ? '#334155' : 'transparent' }}
                          onMouseEnter={(e) => e.target.style.backgroundColor = '#3b82f6'}
                          onMouseLeave={(e) => e.target.style.backgroundColor = selectedVeg.name === veg.name ? '#334155' : 'transparent'}
                        >
                          {veg.name} - {veg.price.toLocaleString()} UGX
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Weight (KGS)</label>
                  <input type="number" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="2" style={{ padding: '10px', borderRadius: '5px', border: 'none', backgroundColor: '#334155', color: 'white', width: '100px' }} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Price / KG (UGX)</label>
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

            {/* CURRENT CART */}
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
                        <td style={{ padding: '10px' }}>{item.weight} KGS</td>
                        <td style={{ padding: '10px' }}>{item.price.toLocaleString()}</td>
                        <td style={{ padding: '10px', fontWeight: 'bold' }}>{item.total.toLocaleString()}</td>
                        <td style={{ padding: '10px' }}>
                          <button onClick={() => removeItem(item.id)} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>❌ Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ margin: 0, color: '#22c55e' }}>GRAND TOTAL: {grandTotal.toLocaleString()} UGX</h2>
                  <button onClick={submitOrder} disabled={saving} style={{ padding: '15px 30px', backgroundColor: saving ? '#475569' : '#3b82f6', color: 'white', border: 'none', borderRadius: '5px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '16px' }}>
                    {saving ? 'Saving...' : 'Submit Final Order 🚀'}
                  </button>
                </div>
              </div>
            )}

            {/* SAVED ORDERS */}
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
                                <td>{Number(item.total).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        <h3 style={{ margin: '15px 0 0 0', color: '#38bdf8', textAlign: 'right' }}>
                          TOTAL: {ugx(order.grand_total ?? order.grandTotal)} UGX
                        </h3>
                      </div>
                    );
                  })}
            </div>
          </>
        ) : (
          <Analytics />
        )}
      </div>
    </div>
  );
}

function Analytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API}/api/analytics?days=${days}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d.ok) setData(d); })
      .catch(err => console.error('analytics failed', err))
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

      {/* DAILY REVENUE */}
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
        {/* BY RESTAURANT */}
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

        {/* TOP VEGETABLES */}
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

export default App;
