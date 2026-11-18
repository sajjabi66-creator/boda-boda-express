// Storage layer: SQLite locally, Postgres when DATABASE_URL is set.
// Same SQL (with ? placeholders) works for both; only the DDL and a couple of
// date expressions differ, so those are branched on the dialect.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { Client } from "pg";

export type Dialect = "sqlite" | "postgres";

export interface Store {
  dialect: Dialect;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<number>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function sqliteStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const db = new Database(`${dir}/boda.db`, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  return {
    dialect: "sqlite",
    async query<T>(sql: string, params: any[] = []): Promise<T[]> {
      return db.query(sql).all(...params) as T[];
    },
    async run(sql: string, params: any[] = []): Promise<number> {
      return db.query(sql).run(...params).changes;
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const out = await fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async close() {
      db.close();
    },
  };
}

async function postgresStore(url: string): Promise<Store> {
  const needsSsl = /sslmode=require/i.test(url);
  const client = new Client({
    connectionString: url,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();

  const conv = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };

  return {
    dialect: "postgres",
    async query<T>(sql: string, params: any[] = []): Promise<T[]> {
      const res = await client.query(conv(sql), params);
      return res.rows as T[];
    },
    async run(sql: string, params: any[] = []): Promise<number> {
      const res = await client.query(conv(sql), params);
      return res.rowCount ?? 0;
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      await client.query("BEGIN");
      try {
        const out = await fn();
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
    async close() {
      await client.end();
    },
  };
}

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant  TEXT    NOT NULL,
    grand_total REAL    NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'pending',
    channel     TEXT    NOT NULL DEFAULT 'admin',
    customer_phone TEXT NOT NULL DEFAULT '',
    area        TEXT    NOT NULL DEFAULT '',
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    weight    REAL    NOT NULL DEFAULT 0,
    price     REAL    NOT NULL DEFAULT 0,
    cost      REAL    NOT NULL DEFAULT 0,
    total     REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS products (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL UNIQUE,
    price  REAL    NOT NULL DEFAULT 0,
    cost   REAL    NOT NULL DEFAULT 0,
    unit   TEXT    NOT NULL DEFAULT 'kg',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS restaurants (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL UNIQUE,
    phone  TEXT    NOT NULL DEFAULT '',
    token  TEXT    NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant TEXT    NOT NULL,
    amount     REAL    NOT NULL DEFAULT 0,
    method     TEXT    NOT NULL DEFAULT 'cash',
    note       TEXT    NOT NULL DEFAULT '',
    paid_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_items_name     ON order_items(name);
  CREATE INDEX IF NOT EXISTS idx_payments_rest  ON payments(restaurant);
`;

const POSTGRES_DDL = `
  CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL PRIMARY KEY,
    restaurant  TEXT    NOT NULL,
    grand_total NUMERIC NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'pending',
    channel     TEXT    NOT NULL DEFAULT 'admin',
    customer_phone TEXT NOT NULL DEFAULT '',
    area        TEXT    NOT NULL DEFAULT '',
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id        SERIAL PRIMARY KEY,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    weight    NUMERIC NOT NULL DEFAULT 0,
    price     NUMERIC NOT NULL DEFAULT 0,
    cost      NUMERIC NOT NULL DEFAULT 0,
    total     NUMERIC NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS products (
    id     SERIAL PRIMARY KEY,
    name   TEXT    NOT NULL UNIQUE,
    price  NUMERIC NOT NULL DEFAULT 0,
    cost   NUMERIC NOT NULL DEFAULT 0,
    unit   TEXT    NOT NULL DEFAULT 'kg',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS restaurants (
    id     SERIAL PRIMARY KEY,
    name   TEXT    NOT NULL UNIQUE,
    phone  TEXT    NOT NULL DEFAULT '',
    token  TEXT    NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS payments (
    id         SERIAL PRIMARY KEY,
    restaurant TEXT    NOT NULL,
    amount     NUMERIC NOT NULL DEFAULT 0,
    method     TEXT    NOT NULL DEFAULT 'cash',
    note       TEXT    NOT NULL DEFAULT '',
    paid_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_items_name     ON order_items(name);
  CREATE INDEX IF NOT EXISTS idx_payments_rest  ON payments(restaurant);
`;

// Databases created before the money layer need these columns added.
async function migrate(store: Store) {
  const type = store.dialect === "postgres" ? "NUMERIC" : "REAL";
  const adds = [
    `ALTER TABLE products ADD COLUMN cost ${type} NOT NULL DEFAULT 0`,
    `ALTER TABLE order_items ADD COLUMN cost ${type} NOT NULL DEFAULT 0`,
    `ALTER TABLE restaurants ADD COLUMN token TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'admin'`,
    `ALTER TABLE orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN area TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN note TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of adds) {
    try {
      await store.exec(sql);
    } catch {
      // column already exists
    }
  }
  await store.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id         ${store.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      restaurant TEXT    NOT NULL,
      amount     ${type} NOT NULL DEFAULT 0,
      method     TEXT    NOT NULL DEFAULT 'cash',
      note       TEXT    NOT NULL DEFAULT '',
      paid_at    ${store.dialect === "postgres" ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"}
    )
  `);
  await store.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
  await store.exec(`
    CREATE TABLE IF NOT EXISTS agent_logs (
      id         ${store.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      session    TEXT    NOT NULL DEFAULT '',
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL DEFAULT '',
      created_at ${store.dialect === "postgres" ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"}
    )
  `);
}

export async function openStore(): Promise<Store> {
  const url = (process.env.DATABASE_URL || "").trim();
  const store = url ? await postgresStore(url) : sqliteStore(process.env.DB_DIR || "./data");
  await store.exec(store.dialect === "postgres" ? POSTGRES_DDL : SQLITE_DDL);
  await migrate(store);
  return store;
}

// Day bucket in Uganda time (EAT, UTC+3), whichever database is in use.
export const dayExpr = (store: Store, column: string) =>
  store.dialect === "postgres"
    ? `to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')`
    : `date(${column}, '+3 hours')`;
