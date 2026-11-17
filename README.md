# Boda Boda Express — Admin Dashboard

Vegetable ordering dashboard for Panther, Wanda, The Bench and Molover.
Orders, prices and restaurants all live in a real database, so nothing disappears
when you close the app.

## Run it

Double-click `BodaBodaExpress.exe`, then open http://localhost:3000

Or from a terminal in this folder:

```
bun run server.ts
```

## Where your data lives

```
data/boda.db
```

That single file holds every order, item, price, restaurant and WhatsApp number.
**Back it up** by copying the `data` folder (e.g. to Google Drive) — that is your
whole business history.

## Pages

- **Orders** — pick the restaurant, search a vegetable, enter weight (price fills
  in from your price list), add items, submit. Every saved order gets a status
  chip: click it to move Pending → Dispatched → Delivered. Each order also has a
  **WhatsApp** button that opens a ready-written message.
- **Analytics** — revenue, order count, kilos moved, average order, revenue per
  day, revenue per restaurant, top vegetables. Switch 7 / 30 / 90 days.
- **Prices & Stock** — edit any price and it applies to the next order
  immediately; add new items; "Hide" an item to take it off the order screen
  without losing its history. Same page manages restaurants and their WhatsApp
  numbers (e.g. `256700123456`).

## WhatsApp

Clicking **WhatsApp** on an order opens WhatsApp with the order already written:

```
*PANTHER ORDER #12*
17 Nov 2026, 22:34

1. Tomatoes - 12.5 kg x 2,000 = 25,000
2. Onions - 8 kg x 3,000 = 24,000

*TOTAL: 49,000 UGX*

Boda Boda Express
```

If the restaurant has a number saved, it opens that chat directly. Otherwise
WhatsApp asks you to choose who to send it to. Nothing is sent automatically —
you still press send, so you always see what goes out.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/orders?limit=100` | Order history |
| POST | `/api/orders` | Save an order `{ restaurant, items:[{name,weight,price}] }` |
| PATCH | `/api/orders/:id/status` | Set `pending` / `dispatched` / `delivered` |
| GET | `/api/products` | Price list |
| POST | `/api/products` | Add item `{ name, price, unit }` |
| PATCH | `/api/products/:id` | Change `name` / `price` / `unit` / `active` |
| GET | `/api/restaurants` | Restaurants + WhatsApp numbers |
| POST | `/api/restaurants` | Add restaurant `{ name, phone }` |
| PATCH | `/api/restaurants/:id` | Change `name` / `phone` / `active` |
| GET | `/api/analytics?days=30` | Everything the Analytics page needs |
| POST | `/api/login` · `/api/logout` · GET `/api/session` | Password login |
| GET | `/health` | `{ ok, orders, authRequired, db }` |

Totals are recomputed on the server from weight × price, so the database stays
correct even if a browser sends odd numbers.

## Hosted version (online)

Live at **https://boda-boda-express.onrender.com** — same dashboard, reachable from any
phone or laptop, protected by a password.

How it is put together:

- **Render web service** `boda-boda-express` (Docker, free plan) built from
  github.com/sajjabi66-creator/boda-boda-express
- **Render Postgres** `boda-db` (free plan) as the database — the app switches to
  Postgres automatically when `DATABASE_URL` is set, and stays on SQLite otherwise
- `APP_PASSWORD` on the service turns on the login screen; `PUBLIC_URL` marks the
  session cookie `Secure`

**The free database expires on 17 December 2026** and is deleted unless the
compute plan is upgraded (about $6/month). Before then either upgrade, or export
the data and point `DATABASE_URL` at another Postgres (Neon, Supabase, etc.).

Free web services also sleep after ~15 minutes idle: the first visit afterwards
takes up to a minute to wake up.

### Local or cloud: where is my data?

| Where you run it | Where orders are saved |
| --- | --- |
| `BodaBodaExpress.exe` on your laptop | `data/boda.db` on that laptop |
| the hosted site | the Render Postgres database |

They are separate databases. Use the hosted one for real ordering and the local
one for testing, or stick to one of them to avoid confusion.

## Password (needed only when online)

Locally there is no password — open the app and you are in. When the app is
hosted on the internet, set `APP_PASSWORD` and the dashboard shows a login
screen; every `/api` route and the live socket then require the session cookie.

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DB_DIR` | `./data` | Folder holding `boda.db` |
| `APP_PASSWORD` | *(empty)* | Enables the login screen |
| `PUBLIC_URL` | *(empty)* | Set to your `https://…` address so the cookie is `Secure` |

## Rebuilding after a code change

```
cd frontend && bun run build
cd .. && Copy-Item frontend\dist dist -Recurse -Force
bun build --compile --outfile BodaBodaExpress.exe server.ts
```

## Why SQLite

No server to start, no password, nothing to install, and it is plenty for one
dashboard. It also means your whole history is one portable file. If this ever
moves to a hosted database (Postgres), the API and pages stay the same — only
the storage layer changes.
