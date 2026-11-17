// Boda Boda Express - admin backend
// Bun + SQLite (built in). Orders are persisted, live-broadcast, and analysable.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DB_DIR || "./data";
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
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_items_name     ON order_items(name);
`);

const insertOrder = db.query(
  "INSERT INTO orders (restaurant, grand_total, status) VALUES (?, ?, 'pending') RETURNING id, created_at"
);
const insertItem = db.query(
  "INSERT INTO order_items (order_id, name, weight, price, total) VALUES (?, ?, ?, ?, ?)"
);

function orderWithItems(id: number) {
  const order = db.query("SELECT * FROM orders WHERE id = ?").get(id) as any;
  if (!order) return null;
  order.items = db.query("SELECT name, weight, price, total FROM order_items WHERE order_id = ?").all(id);
  return { ...order, restaurant: order.restaurant, grandTotal: order.grand_total };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
        },
      });
    }

    // WebSocket upgrade (live dashboard updates)
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // ---- Save an order ------------------------------------------------
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

    // ---- List orders (history survives restarts) ----------------------
    if (req.method === "GET" && url.pathname === "/api/orders") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const rows = db
        .query("SELECT * FROM orders ORDER BY id DESC LIMIT ?")
        .all(limit) as any[];
      const data = rows.map((o) => ({
        ...o,
        grandTotal: o.grand_total,
        items: db.query("SELECT name, weight, price, total FROM order_items WHERE order_id = ?").all(o.id),
      }));
      return json({ ok: true, orders: data });
    }

    // ---- Update order status (dispatch flow) --------------------------
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

    // ---- Analytics ----------------------------------------------------
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
          `SELECT restaurant,
                  COUNT(*) AS orders,
                  COALESCE(SUM(grand_total), 0) AS revenue
             FROM orders WHERE created_at >= ${since}
            GROUP BY restaurant ORDER BY revenue DESC`
        )
        .all();

      const byVegetable = db
        .query(
          `SELECT i.name,
                  ROUND(SUM(i.weight), 2) AS kg,
                  COALESCE(SUM(i.total), 0) AS revenue,
                  COUNT(DISTINCT i.order_id) AS orders
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.created_at >= ${since}
            GROUP BY i.name ORDER BY revenue DESC`
        )
        .all();

      const daily = db
        .query(
          `SELECT date(created_at, ${TZ}) AS day,
                  COUNT(*) AS orders,
                  COALESCE(SUM(grand_total), 0) AS revenue
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
      return json({ ok: true, orders: c?.n ?? 0, db: `${DATA_DIR}/boda.db` });
    }

    // ---- Serve the React build ----------------------------------------
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
    message(ws, message) {
      // Orders now come in over REST; ignore stray socket messages.
      console.log("ignored ws message:", message.toString().slice(0, 80));
    },
    close() {
      console.log("client disconnected");
    },
  },
});

console.log(`Boda Boda Express running at http://localhost:${server.port}`);
console.log(`Database: ${DATA_DIR}/boda.db`);
