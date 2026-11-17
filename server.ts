// Boda Boda Express - admin backend
// Bun + SQLite. Orders persist, prices/restaurants are editable, optional password login.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DB_DIR || "./data";
const PASSWORD = (process.env.APP_PASSWORD || "").trim(); // empty = no login (local use)
const AUTH_ON = PASSWORD.length > 0;
const COOKIE = "boda_session";

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(`${DATA_DIR}/boda.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant  TEXT    NOT NULL,
    grand_total REAL    NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'pending',
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    weight    REAL    NOT NULL DEFAULT 0,
    price     REAL    NOT NULL DEFAULT 0,
    total     REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS products (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL UNIQUE,
    price  REAL    NOT NULL DEFAULT 0,
    unit   TEXT    NOT NULL DEFAULT 'kg',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS restaurants (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL UNIQUE,
    phone  TEXT    NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_items_name     ON order_items(name);
`);

// ---- Seed the original catalogue on a fresh database ------------------
const SEED_PRODUCTS: [string, number][] = [
  ["Onions", 3000], ["Tomatoes", 2000], ["Carrots", 3500], ["Cabbage", 2500],
  ["Irish Potatoes", 2700], ["Ginger", 5000], ["Garlic", 14000], ["Green Peppers", 4000],
  ["Bell Peppers", 8000], ["Lettuce", 4000], ["Broccoli", 6000], ["Cauliflower", 5000],
  ["Cucumber", 3000], ["Zucchini", 3000], ["Passion Fruit", 7000], ["Lemons", 2500],
  ["Oranges", 3000], ["Pineapples", 3500], ["Watermelon", 8000], ["Matooke", 25000],
];
const SEED_RESTAURANTS = ["Panther", "Wanda", "The Bench", "Molover"];

const countOf = (table: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

if (countOf("products") === 0) {
  const ins = db.query("INSERT INTO products (name, price) VALUES (?, ?)");
  for (const [name, price] of SEED_PRODUCTS) ins.run(name, price);
}
if (countOf("restaurants") === 0) {
  const ins = db.query("INSERT INTO restaurants (name) VALUES (?)");
  for (const name of SEED_RESTAURANTS) ins.run(name);
}

// ---- Auth helpers ----------------------------------------------------
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

// ---- Shared helpers --------------------------------------------------
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

function orderWithItems(id: number) {
  const order = db.query("SELECT * FROM orders WHERE id = ?").get(id) as any;
  if (!order) return null;
  order.items = db.query(
    "SELECT name, weight, price, total FROM order_items WHERE order_id = ?"
  ).all(id);
  return { ...order, grandTotal: order.grand_total };
}

const insertOrder = db.query(
  "INSERT INTO orders (restaurant, grand_total, status) VALUES (?, ?, 'pending') RETURNING id, created_at"
);
const insertItem = db.query(
  "INSERT INTO order_items (order_id, name, weight, price, total) VALUES (?, ?, ?, ?, ?)"
);

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

    // ---- Login / session ----------------------------------------------
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

    // Everything below needs a session when a password is configured.
    const isApi = url.pathname.startsWith("/api/");
    if ((isApi || url.pathname === "/ws") && !isAuthed(req)) {
      return json({ ok: false, error: "Not authenticated" }, 401);
    }

    // ---- WebSocket upgrade (live dashboard) ----------------------------
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // ---- Products (prices manager) ------------------------------------
    if (req.method === "GET" && url.pathname === "/api/products") {
      const rows = db.query("SELECT * FROM products ORDER BY active DESC, name ASC").all();
      return json({ ok: true, products: rows });
    }

    if (req.method === "POST" && url.pathname === "/api/products") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {}

      const name = String(body?.name ?? "").trim();
      const price = Math.round(Number(body?.price) || 0);
      const unit = String(body?.unit ?? "kg").trim().toLowerCase() || "kg";

      if (!name) return json({ ok: false, error: "Name is required" }, 400);
      if (price <= 0) return json({ ok: false, error: "Price must be more than zero" }, 400);

      const exists = db.query("SELECT id FROM products WHERE lower(name) = lower(?)").get(name);
      if (exists) return json({ ok: false, error: `${name} already exists` }, 409);

      const row = db
        .query("INSERT INTO products (name, price, unit) VALUES (?, ?, ?) RETURNING *")
        .get(name, price, unit);
      return json({ ok: true, product: row }, 201);
    }

    const productMatch = url.pathname.match(/^\/api\/products\/(\d+)$/);
    if (req.method === "PATCH" && productMatch) {
      const id = Number(productMatch[1]);
      let body: any = {};
      try {
        body = await req.json();
      } catch {}

      const current = db.query("SELECT * FROM products WHERE id = ?").get(id) as any;
      if (!current) return json({ ok: false, error: "Product not found" }, 404);

      const name = body.name !== undefined ? String(body.name).trim() : current.name;
      const price = body.price !== undefined ? Math.round(Number(body.price) || 0) : current.price;
      const unit = body.unit !== undefined ? String(body.unit).trim() : current.unit;
      const active = body.active !== undefined ? (body.active ? 1 : 0) : current.active;

      if (!name) return json({ ok: false, error: "Name cannot be empty" }, 400);
      if (price <= 0) return json({ ok: false, error: "Price must be more than zero" }, 400);

      const row = db
        .query("UPDATE products SET name = ?, price = ?, unit = ?, active = ? WHERE id = ? RETURNING *")
        .get(name, price, unit, active, id);
      return json({ ok: true, product: row });
    }

    // ---- Restaurants (names + WhatsApp numbers) -----------------------
    if (req.method === "GET" && url.pathname === "/api/restaurants") {
      const rows = db.query("SELECT * FROM restaurants ORDER BY active DESC, name ASC").all();
      return json({ ok: true, restaurants: rows });
    }

    if (req.method === "POST" && url.pathname === "/api/restaurants") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {}

      const name = String(body?.name ?? "").trim();
      const phone = String(body?.phone ?? "").replace(/[^\d+]/g, "");
      if (!name) return json({ ok: false, error: "Name is required" }, 400);

      const exists = db.query("SELECT id FROM restaurants WHERE lower(name) = lower(?)").get(name);
      if (exists) return json({ ok: false, error: `${name} already exists` }, 409);

      const row = db
        .query("INSERT INTO restaurants (name, phone) VALUES (?, ?) RETURNING *")
        .get(name, phone);
      return json({ ok: true, restaurant: row }, 201);
    }

    const restMatch = url.pathname.match(/^\/api\/restaurants\/(\d+)$/);
    if (req.method === "PATCH" && restMatch) {
      const id = Number(restMatch[1]);
      let body: any = {};
      try {
        body = await req.json();
      } catch {}

      const current = db.query("SELECT * FROM restaurants WHERE id = ?").get(id) as any;
      if (!current) return json({ ok: false, error: "Restaurant not found" }, 404);

      const name = body.name !== undefined ? String(body.name).trim() : current.name;
      const phone = body.phone !== undefined ? String(body.phone).replace(/[^\d+]/g, "") : current.phone;
      const active = body.active !== undefined ? (body.active ? 1 : 0) : current.active;
      if (!name) return json({ ok: false, error: "Name cannot be empty" }, 400);

      const row = db
        .query("UPDATE restaurants SET name = ?, phone = ?, active = ? WHERE id = ? RETURNING *")
        .get(name, phone, active, id);
      return json({ ok: true, restaurant: row });
    }

    // ---- Save an order -------------------------------------------------
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

      const save = db.transaction(() => {
        const row = insertOrder.get(restaurant, grandTotal) as { id: number; created_at: string };
        for (const it of clean) insertItem.run(row.id, it.name, it.weight, it.price, it.total);
        return row;
      });

      try {
        const row = save();
        const saved = orderWithItems(row.id);
        srv.publish("orders", JSON.stringify(saved));
        return json({ ok: true, order: saved }, 201);
      } catch (err) {
        console.error("Failed to save order:", err);
        return json({ ok: false, error: "Could not save the order" }, 500);
      }
    }

    // ---- Order history --------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/orders") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const rows = db.query("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit) as any[];
      const data = rows.map((o) => ({
        ...o,
        grandTotal: o.grand_total,
        items: db.query("SELECT name, weight, price, total FROM order_items WHERE order_id = ?").all(o.id),
      }));
      return json({ ok: true, orders: data });
    }

    // ---- Order status ---------------------------------------------------
    const statusMatch = url.pathname.match(/^\/api\/orders\/(\d+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      const id = Number(statusMatch[1]);
      const allowed = ["pending", "dispatched", "delivered"];
      let next = "";
      try {
        next = String((await req.json())?.status ?? "");
      } catch {}
      if (!allowed.includes(next)) return json({ ok: false, error: "Invalid status" }, 400);

      const res = db.query("UPDATE orders SET status = ? WHERE id = ?").run(next, id);
      if (res.changes === 0) return json({ ok: false, error: "Order not found" }, 404);

      const updated = orderWithItems(id);
      srv.publish("orders", JSON.stringify(updated));
      return json({ ok: true, order: updated });
    }

    // ---- Analytics ------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/analytics") {
      const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
      const since = `datetime('now', '-${days} days')`;
      const TZ = "'+3 hours'"; // Uganda EAT

      const totals = db
        .query(
          `SELECT COUNT(*) AS orders,
                  COALESCE(SUM(grand_total), 0) AS revenue,
                  COALESCE(AVG(grand_total), 0) AS avg_order
             FROM orders WHERE created_at >= ${since}`
        )
        .get() as any;

      const kg = db
        .query(
          `SELECT COALESCE(SUM(i.weight), 0) AS kg
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ${since}`
        )
        .get() as any;

      const byRestaurant = db
        .query(
          `SELECT restaurant, COUNT(*) AS orders, COALESCE(SUM(grand_total), 0) AS revenue
             FROM orders WHERE created_at >= ${since}
            GROUP BY restaurant ORDER BY revenue DESC`
        )
        .all();

      const byVegetable = db
        .query(
          `SELECT i.name, ROUND(SUM(i.weight), 2) AS kg, COALESCE(SUM(i.total), 0) AS revenue,
                  COUNT(DISTINCT i.order_id) AS orders
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ${since}
            GROUP BY i.name ORDER BY revenue DESC`
        )
        .all();

      const daily = db
        .query(
          `SELECT date(created_at, ${TZ}) AS day, COUNT(*) AS orders, COALESCE(SUM(grand_total), 0) AS revenue
             FROM orders WHERE created_at >= ${since}
            GROUP BY day ORDER BY day ASC`
        )
        .all();

      const allTime = db
        .query("SELECT COUNT(*) AS orders, COALESCE(SUM(grand_total),0) AS revenue FROM orders")
        .get() as any;

      return json({
        ok: true,
        days,
        totals: { ...totals, kg: kg?.kg ?? 0 },
        allTime,
        byRestaurant,
        byVegetable,
        daily,
        generatedAt: new Date().toISOString(),
      });
    }

    if (url.pathname === "/health") {
      const c = db.query("SELECT COUNT(*) AS n FROM orders").get() as any;
      return json({ ok: true, orders: c?.n ?? 0, authRequired: AUTH_ON, db: `${DATA_DIR}/boda.db` });
    }

    // ---- Serve the React build ------------------------------------------
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset = Bun.file(`./dist${rel}`);
    if (await asset.exists()) return new Response(asset);

    const index = Bun.file("./dist/index.html");
    if (await index.exists()) return new Response(index);

    return new Response("Frontend build not found. Run: cd frontend && bun run build", { status: 500 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("orders");
      console.log("client connected");
    },
    message() {},
    close() {
      console.log("client disconnected");
    },
  },
});

console.log(`Boda Boda Express running at http://localhost:${server.port}`);
console.log(`Database: ${DATA_DIR}/boda.db${AUTH_ON ? " (password required)" : " (no password - local mode)"}`);
