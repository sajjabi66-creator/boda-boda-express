// Boda Boda Express - admin backend
// SQLite locally, Postgres in the cloud (set DATABASE_URL).
// Orders persist, prices/restaurants are editable, optional password login.

import { openStore, dayExpr } from "./store";

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = (process.env.APP_PASSWORD || "").trim(); // empty = no login (local use)
const AUTH_ON = PASSWORD.length > 0;
const COOKIE = "boda_session";

const store = await openStore();
const dbLabel = store.dialect === "postgres" ? "Postgres (DATABASE_URL)" : `${process.env.DB_DIR || "./data"}/boda.db`;

// ---- Seed the original catalogue on a fresh database ------------------
const SEED_PRODUCTS: [string, number][] = [
  ["Onions", 3000], ["Tomatoes", 2000], ["Carrots", 3500], ["Cabbage", 2500],
  ["Irish Potatoes", 2700], ["Ginger", 5000], ["Garlic", 14000], ["Green Peppers", 4000],
  ["Bell Peppers", 8000], ["Lettuce", 4000], ["Broccoli", 6000], ["Cauliflower", 5000],
  ["Cucumber", 3000], ["Zucchini", 3000], ["Passion Fruit", 7000], ["Lemons", 2500],
  ["Oranges", 3000], ["Pineapples", 3500], ["Watermelon", 8000], ["Matooke", 25000],
];
const SEED_RESTAURANTS = ["Panther", "Wanda", "The Bench", "Molover"];

async function countOf(table: string): Promise<number> {
  const rows = await store.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

if ((await countOf("products")) === 0) {
  for (const [name, price] of SEED_PRODUCTS) {
    await store.run("INSERT INTO products (name, price) VALUES (?, ?)", [name, price]);
  }
}
if ((await countOf("restaurants")) === 0) {
  for (const name of SEED_RESTAURANTS) {
    await store.run("INSERT INTO restaurants (name) VALUES (?)", [name]);
  }
}

// ---- Auth ------------------------------------------------------------
const TOKEN = AUTH_ON
  ? new Bun.CryptoHasher("sha256").update(`${PASSWORD}::boda-boda-express`).digest("hex")
  : "";

function isAuthed(req: Request) {
  if (!AUTH_ON) return true;
  const cookie = req.headers.get("cookie") || "";
  const hit = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return !!hit && hit.slice(COOKIE.length + 1) === TOKEN;
}

function sessionCookie() {
  const secure = (process.env.PUBLIC_URL || "").startsWith("https") ? "; Secure" : "";
  return `${COOKIE}=${TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`;
}

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      ...extraHeaders,
    },
  });

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

async function orderWithItems(id: number) {
  const rows = await store.query("SELECT * FROM orders WHERE id = ?", [id]);
  const order = rows[0];
  if (!order) return null;
  const items = await store.query(
    "SELECT name, weight, price, cost, total FROM order_items WHERE order_id = ?",
    [id]
  );
  return {
    ...order,
    id: num(order.id),
    grand_total: num(order.grand_total),
    grandTotal: num(order.grand_total),
    items: items.map((it: any) => ({
      name: it.name,
      weight: num(it.weight),
      price: num(it.price),
      cost: num(it.cost),
      total: num(it.total),
    })),
  };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        },
      });
    }

    try {
      // ---- Session / login ---------------------------------------------
      if (url.pathname === "/api/session") {
        return json({ ok: true, authRequired: AUTH_ON, authenticated: isAuthed(req) });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        let pass = "";
        try {
          pass = String((await req.json())?.password ?? "");
        } catch {}
        if (!AUTH_ON) return json({ ok: true });
        if (pass !== PASSWORD) return json({ ok: false, error: "Wrong password" }, 401);
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie() });
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        return json({ ok: true }, 200, {
          "Set-Cookie": `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
        });
      }

      const isApi = url.pathname.startsWith("/api/");
      if ((isApi || url.pathname === "/ws") && !isAuthed(req)) {
        return json({ ok: false, error: "Not authenticated" }, 401);
      }

      // ---- WebSocket upgrade -------------------------------------------
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return;
        return new Response("Upgrade failed", { status: 400 });
      }

      // ---- Products ------------------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/products") {
        const rows = await store.query("SELECT * FROM products ORDER BY active DESC, name ASC");
        return json({ ok: true, products: rows.map((r: any) => ({ ...r, id: num(r.id), price: num(r.price), active: num(r.active) })) });
      }

      if (req.method === "POST" && url.pathname === "/api/products") {
        let body: any = {};
        try {
          body = await req.json();
        } catch {}

        const name = String(body?.name ?? "").trim();
        const price = Math.round(Number(body?.price) || 0);
        const cost = Math.round(Number(body?.cost) || 0);
        const unit = String(body?.unit ?? "kg").trim().toLowerCase() || "kg";

        if (!name) return json({ ok: false, error: "Name is required" }, 400);
        if (price <= 0) return json({ ok: false, error: "Price must be more than zero" }, 400);

        const exists = await store.query("SELECT id FROM products WHERE lower(name) = lower(?)", [name]);
        if (exists.length) return json({ ok: false, error: `${name} already exists` }, 409);

        const rows = await store.query(
          "INSERT INTO products (name, price, cost, unit) VALUES (?, ?, ?, ?) RETURNING *",
          [name, price, cost, unit]
        );
        return json({ ok: true, product: rows[0] }, 201);
      }

      const productMatch = url.pathname.match(/^\/api\/products\/(\d+)$/);
      if (req.method === "PATCH" && productMatch) {
        const id = Number(productMatch[1]);
        let body: any = {};
        try {
          body = await req.json();
        } catch {}

        const currentRows = await store.query("SELECT * FROM products WHERE id = ?", [id]);
        const current: any = currentRows[0];
        if (!current) return json({ ok: false, error: "Product not found" }, 404);

        const name = body.name !== undefined ? String(body.name).trim() : current.name;
        const price = body.price !== undefined ? Math.round(Number(body.price) || 0) : num(current.price);
        const cost = body.cost !== undefined ? Math.round(Number(body.cost) || 0) : num(current.cost);
        const unit = body.unit !== undefined ? String(body.unit).trim() : current.unit;
        const active = body.active !== undefined ? (body.active ? 1 : 0) : num(current.active);

        if (!name) return json({ ok: false, error: "Name cannot be empty" }, 400);
        if (price <= 0) return json({ ok: false, error: "Price must be more than zero" }, 400);

        const rows = await store.query(
          "UPDATE products SET name = ?, price = ?, cost = ?, unit = ?, active = ? WHERE id = ? RETURNING *",
          [name, price, cost, unit, active, id]
        );
        return json({ ok: true, product: rows[0] });
      }

      // ---- Restaurants ---------------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/restaurants") {
        const rows = await store.query("SELECT * FROM restaurants ORDER BY active DESC, name ASC");
        return json({ ok: true, restaurants: rows.map((r: any) => ({ ...r, id: num(r.id), active: num(r.active) })) });
      }

      if (req.method === "POST" && url.pathname === "/api/restaurants") {
        let body: any = {};
        try {
          body = await req.json();
        } catch {}

        const name = String(body?.name ?? "").trim();
        const phone = String(body?.phone ?? "").replace(/[^\d+]/g, "");
        if (!name) return json({ ok: false, error: "Name is required" }, 400);

        const exists = await store.query("SELECT id FROM restaurants WHERE lower(name) = lower(?)", [name]);
        if (exists.length) return json({ ok: false, error: `${name} already exists` }, 409);

        const rows = await store.query(
          "INSERT INTO restaurants (name, phone) VALUES (?, ?) RETURNING *",
          [name, phone]
        );
        return json({ ok: true, restaurant: rows[0] }, 201);
      }

      const restMatch = url.pathname.match(/^\/api\/restaurants\/(\d+)$/);
      if (req.method === "PATCH" && restMatch) {
        const id = Number(restMatch[1]);
        let body: any = {};
        try {
          body = await req.json();
        } catch {}

        const currentRows = await store.query("SELECT * FROM restaurants WHERE id = ?", [id]);
        const current: any = currentRows[0];
        if (!current) return json({ ok: false, error: "Restaurant not found" }, 404);

        const name = body.name !== undefined ? String(body.name).trim() : current.name;
        const phone = body.phone !== undefined ? String(body.phone).replace(/[^\d+]/g, "") : current.phone;
        const active = body.active !== undefined ? (body.active ? 1 : 0) : num(current.active);
        if (!name) return json({ ok: false, error: "Name cannot be empty" }, 400);

        // Keep history attached when a restaurant is renamed.
        if (name !== current.name) {
          await store.run("UPDATE orders SET restaurant = ? WHERE restaurant = ?", [name, current.name]);
          await store.run("UPDATE payments SET restaurant = ? WHERE restaurant = ?", [name, current.name]);
        }

        const rows = await store.query(
          "UPDATE restaurants SET name = ?, phone = ?, active = ? WHERE id = ? RETURNING *",
          [name, phone, active, id]
        );
        return json({ ok: true, restaurant: rows[0] });
      }

      // ---- Save an order ---------------------------------------------------
      if (req.method === "POST" && url.pathname === "/api/orders") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400);
        }

        const restaurant = String(body?.restaurant ?? "").trim();
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!restaurant) return json({ ok: false, error: "Restaurant is required" }, 400);
        if (items.length === 0) return json({ ok: false, error: "Order has no items" }, 400);

        const clean = items.map((it: any) => {
          const name = String(it?.name ?? "").trim();
          const weight = Number(it?.weight) || 0;
          const price = Number(it?.price) || 0;
          return { name, weight, price, total: Math.round(weight * price) };
        });

        if (clean.some((it: any) => !it.name || it.weight <= 0)) {
          return json({ ok: false, error: "Every item needs a name and a weight" }, 400);
        }

        const grandTotal = clean.reduce((sum: number, it: any) => sum + it.total, 0);

        // Snapshot today's cost per item so profit stays correct if prices move.
        const productCosts = await store.query("SELECT name, cost FROM products");
        const costOf = new Map<string, number>();
        for (const p of productCosts as any[]) costOf.set(String(p.name).toLowerCase(), num(p.cost));
        for (const it of clean) it.cost = costOf.get(it.name.toLowerCase()) ?? 0;

        const newId = await store.tx(async () => {
          const rows = await store.query(
            "INSERT INTO orders (restaurant, grand_total, status) VALUES (?, ?, 'pending') RETURNING id",
            [restaurant, grandTotal]
          );
          const id = num(rows[0].id);
          for (const it of clean) {
            await store.run(
              "INSERT INTO order_items (order_id, name, weight, price, cost, total) VALUES (?, ?, ?, ?, ?, ?)",
              [id, it.name, it.weight, it.price, it.cost, it.total]
            );
          }
          return id;
        });

        const saved = await orderWithItems(newId);
        srv.publish("orders", JSON.stringify(saved));
        return json({ ok: true, order: saved }, 201);
      }

      // ---- Order history ----------------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/orders") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        const rows = await store.query("SELECT * FROM orders ORDER BY id DESC LIMIT ?", [limit]);
        const data = [];
        for (const o of rows as any[]) {
          const items = await store.query(
            "SELECT name, weight, price, cost, total FROM order_items WHERE order_id = ?",
            [num(o.id)]
          );
          data.push({
            ...o,
            id: num(o.id),
            grand_total: num(o.grand_total),
            grandTotal: num(o.grand_total),
            items: items.map((it: any) => ({
              name: it.name, weight: num(it.weight), price: num(it.price), cost: num(it.cost), total: num(it.total),
            })),
          });
        }
        return json({ ok: true, orders: data });
      }

      // ---- Delete an order (fixing mistakes) --------------------------------
      const deleteMatch = url.pathname.match(/^\/api\/orders\/(\d+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = Number(deleteMatch[1]);
        await store.run("DELETE FROM order_items WHERE order_id = ?", [id]);
        const changed = await store.run("DELETE FROM orders WHERE id = ?", [id]);
        if (changed === 0) return json({ ok: false, error: "Order not found" }, 404);
        srv.publish("orders", JSON.stringify({ id, deleted: true }));
        return json({ ok: true, deleted: id });
      }

      // ---- Order status ------------------------------------------------------
      const statusMatch = url.pathname.match(/^\/api\/orders\/(\d+)\/status$/);
      if (req.method === "PATCH" && statusMatch) {
        const id = Number(statusMatch[1]);
        const allowed = ["pending", "dispatched", "delivered"];
        let next = "";
        try {
          next = String((await req.json())?.status ?? "");
        } catch {}
        if (!allowed.includes(next)) return json({ ok: false, error: "Invalid status" }, 400);

        const changed = await store.run("UPDATE orders SET status = ? WHERE id = ?", [next, id]);
        if (changed === 0) return json({ ok: false, error: "Order not found" }, 404);

        const updated = await orderWithItems(id);
        srv.publish("orders", JSON.stringify(updated));
        return json({ ok: true, order: updated });
      }

      // ---- Payments (money coming in) -----------------------------------------
      if (req.method === "GET" && url.pathname === "/api/payments") {
        const restaurant = url.searchParams.get("restaurant");
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        const rows = restaurant
          ? await store.query("SELECT * FROM payments WHERE restaurant = ? ORDER BY paid_at DESC LIMIT ?", [restaurant, limit])
          : await store.query("SELECT * FROM payments ORDER BY paid_at DESC LIMIT ?", [limit]);
        return json({
          ok: true,
          payments: (rows as any[]).map((p) => ({ ...p, id: num(p.id), amount: num(p.amount) })),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/payments") {
        let body: any = {};
        try {
          body = await req.json();
        } catch {}

        const restaurant = String(body?.restaurant ?? "").trim();
        const amount = Math.round(Number(body?.amount) || 0);
        const method = String(body?.method ?? "cash").trim().toLowerCase() || "cash";
        const note = String(body?.note ?? "").trim();

        if (!restaurant) return json({ ok: false, error: "Restaurant is required" }, 400);
        if (amount <= 0) return json({ ok: false, error: "Amount must be more than zero" }, 400);

        const rows = await store.query(
          "INSERT INTO payments (restaurant, amount, method, note) VALUES (?, ?, ?, ?) RETURNING *",
          [restaurant, amount, method, note]
        );
        return json({ ok: true, payment: rows[0] }, 201);
      }

      const paymentMatch = url.pathname.match(/^\/api\/payments\/(\d+)$/);
      if (req.method === "DELETE" && paymentMatch) {
        const changed = await store.run("DELETE FROM payments WHERE id = ?", [Number(paymentMatch[1])]);
        if (changed === 0) return json({ ok: false, error: "Payment not found" }, 404);
        return json({ ok: true });
      }

      // ---- Accounts: who owes what --------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/accounts") {
        const billed = await store.query(
          `SELECT restaurant, COUNT(*) AS orders, COALESCE(SUM(grand_total),0) AS billed, MAX(created_at) AS last_order
             FROM orders GROUP BY restaurant`
        );
        const paidRows = await store.query(
          `SELECT restaurant, COALESCE(SUM(amount),0) AS paid, MAX(paid_at) AS last_payment
             FROM payments GROUP BY restaurant`
        );
        const names = await store.query("SELECT name FROM restaurants ORDER BY name");

        const blank = (name: string) => ({
          restaurant: name, orders: 0, billed: 0, paid: 0, lastOrder: null as any, lastPayment: null as any,
        });
        const map = new Map<string, any>();
        for (const n of names as any[]) map.set(n.name, blank(n.name));
        for (const b of billed as any[]) {
          const row = map.get(b.restaurant) ?? blank(b.restaurant);
          row.orders = num(b.orders);
          row.billed = num(b.billed);
          row.lastOrder = b.last_order;
          map.set(b.restaurant, row);
        }
        for (const p of paidRows as any[]) {
          const row = map.get(p.restaurant) ?? blank(p.restaurant);
          row.paid = num(p.paid);
          row.lastPayment = p.last_payment;
          map.set(p.restaurant, row);
        }

        const accounts = [...map.values()]
          .map((r) => ({ ...r, balance: Math.round(r.billed - r.paid) }))
          .sort((a, b) => b.balance - a.balance);

        const totals = accounts.reduce(
          (acc, r) => ({ billed: acc.billed + r.billed, paid: acc.paid + r.paid, balance: acc.balance + r.balance }),
          { billed: 0, paid: 0, balance: 0 }
        );
        return json({ ok: true, accounts, totals });
      }

      if (req.method === "GET" && url.pathname === "/api/accounts/statement") {
        const restaurant = String(url.searchParams.get("restaurant") || "").trim();
        if (!restaurant) return json({ ok: false, error: "restaurant is required" }, 400);

        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 365, 1), 3650);
        const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

        const orders = await store.query(
          "SELECT id, grand_total, created_at, status FROM orders WHERE restaurant = ? AND created_at >= ? ORDER BY created_at ASC",
          [restaurant, sinceIso]
        );
        const payments = await store.query(
          "SELECT id, amount, method, note, paid_at FROM payments WHERE restaurant = ? AND paid_at >= ? ORDER BY paid_at ASC",
          [restaurant, sinceIso]
        );

        type Entry = { type: string; id: number; date: string; debit: number; credit: number; note: string };
        const entries: Entry[] = [
          ...(orders as any[]).map((o) => ({
            type: "order", id: num(o.id), date: o.created_at,
            debit: num(o.grand_total), credit: 0, note: `Order #${o.id} (${o.status})`,
          })),
          ...(payments as any[]).map((p) => ({
            type: "payment", id: num(p.id), date: p.paid_at,
            debit: 0, credit: num(p.amount),
            note: `${p.method}${p.note ? " - " + p.note : ""}`,
          })),
        ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

        let running = 0;
        const withBalance = entries.map((e) => {
          running += e.debit - e.credit;
          return { ...e, balance: Math.round(running) };
        });
        const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
        const totalCredit = entries.reduce((s, e) => s + e.credit, 0);

        return json({
          ok: true,
          restaurant,
          days,
          entries: withBalance,
          totals: {
            billed: Math.round(totalDebit),
            paid: Math.round(totalCredit),
            balance: Math.round(totalDebit - totalCredit),
          },
          generatedAt: new Date().toISOString(),
        });
      }

      // ---- Analytics ----------------------------------------------------------
      if (req.method === "GET" && url.pathname === "/api/analytics") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
        const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

        const totalsRows = await store.query(
          `SELECT COUNT(*) AS orders, COALESCE(SUM(grand_total), 0) AS revenue, COALESCE(AVG(grand_total), 0) AS avg_order
             FROM orders WHERE created_at >= ?`,
          [sinceIso]
        );
        const totals: any = totalsRows[0] || {};

        const kgRows = await store.query(
          `SELECT COALESCE(SUM(i.weight), 0) AS kg
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ?`,
          [sinceIso]
        );

        const costRows = await store.query(
          `SELECT COALESCE(SUM(i.weight * i.cost), 0) AS cost
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ?`,
          [sinceIso]
        );

        const byRestaurant = await store.query(
          `SELECT restaurant, COUNT(*) AS orders, COALESCE(SUM(grand_total), 0) AS revenue
             FROM orders WHERE created_at >= ?
            GROUP BY restaurant ORDER BY revenue DESC`,
          [sinceIso]
        );

        const byVegetable = await store.query(
          `SELECT i.name, SUM(i.weight) AS kg, COALESCE(SUM(i.total), 0) AS revenue,
                  COALESCE(SUM(i.weight * i.cost), 0) AS cost,
                  COUNT(DISTINCT i.order_id) AS orders
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ?
            GROUP BY i.name ORDER BY revenue DESC`,
          [sinceIso]
        );

        const daily = await store.query(
          `SELECT ${dayExpr(store, "created_at")} AS day, COUNT(*) AS orders,
                  COALESCE(SUM(grand_total), 0) AS revenue
             FROM orders WHERE created_at >= ?
            GROUP BY day ORDER BY day ASC`,
          [sinceIso]
        );

        const allTimeRows = await store.query(
          "SELECT COUNT(*) AS orders, COALESCE(SUM(grand_total),0) AS revenue FROM orders"
        );

        const round2 = (v: any) => Math.round(num(v) * 100) / 100;
        const revenue = num(totals.revenue);
        const costTotal = round2(costRows[0]?.cost);
        const profit = round2(revenue - costTotal);

        return json({
          ok: true,
          days,
          totals: {
            orders: num(totals.orders),
            revenue,
            avg_order: num(totals.avg_order),
            kg: round2(kgRows[0]?.kg),
            cost: costTotal,
            profit,
            margin: revenue > 0 ? round2((profit / revenue) * 100) : 0,
          },
          allTime: {
            orders: num((allTimeRows[0] as any)?.orders),
            revenue: num((allTimeRows[0] as any)?.revenue),
          },
          byRestaurant: (byRestaurant as any[]).map((r) => ({
            restaurant: r.restaurant, orders: num(r.orders), revenue: num(r.revenue),
          })),
          byVegetable: (byVegetable as any[]).map((v) => {
            const rev = num(v.revenue);
            const cost = round2(v.cost);
            return {
              name: v.name, kg: round2(v.kg), revenue: rev, cost,
              profit: round2(rev - cost),
              margin: rev > 0 ? round2(((rev - cost) / rev) * 100) : 0,
              orders: num(v.orders),
            };
          }),
          daily: (daily as any[]).map((d) => ({
            day: d.day, orders: num(d.orders), revenue: num(d.revenue),
          })),
          generatedAt: new Date().toISOString(),
        });
      }

      if (url.pathname === "/health") {
        return json({
          ok: true,
          orders: await countOf("orders"),
          authRequired: AUTH_ON,
          database: store.dialect,
          db: dbLabel,
        });
      }

      // ---- Serve the React build ----------------------------------------------
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const asset = Bun.file(`./dist${rel}`);
      if (await asset.exists()) return new Response(asset);

      const index = Bun.file("./dist/index.html");
      if (await index.exists()) return new Response(index);

      return new Response("Frontend build not found. Run: cd frontend && bun run build", { status: 500 });
    } catch (err) {
      console.error("Request failed:", err);
      return json({ ok: false, error: "Server error" }, 500);
    }
  },
  websocket: {
    open(ws) {
      ws.subscribe("orders");
    },
    message() {},
    close() {},
  },
});

console.log(`Boda Boda Express running at http://localhost:${server.port}`);
console.log(`Database: ${dbLabel}${AUTH_ON ? " (password required)" : " (no password - local mode)"}`);
