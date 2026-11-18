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
  in from your price list), add items, submit. **↻ Repeat last order** rebuilds a
  restaurant's usual basket in one click. **✓ Confirm order** releases it to the
  workers screen. Every order gets a status chip: Pending → Confirmed →
  Dispatched → Delivered. Each order also has a **WhatsApp** button if you still
  want to send a message.
- **Accounts** — what each restaurant has been billed, what they have paid, and
  what is still owed. Record a payment (cash / mobile money / bank / cheque, full
  or partial), open a **statement** with a running balance, and send that
  statement on WhatsApp in one tap.
- **Analytics** — revenue, **profit and margin**, order count, kilos moved,
  average order, revenue per day, revenue per restaurant, and top vegetables by
  revenue and profit. Switch 7 / 30 / 90 days.
- **Prices & Stock** — edit the selling price **and the cost price** (that is what
  turns revenue into profit); add new items; "Hide" an item to take it off the
  order screen without losing its history. Same page manages restaurants and
  their WhatsApp numbers (e.g. `256700123456`).

## How the money side works

- Every submitted order is a charge against that restaurant's account.
- Every recorded payment reduces the balance. Overpayment shows a negative
  balance, i.e. credit.
- A **statement** lists orders and payments in date order with a running balance,
  so you can prove what is owed.
- When an order is saved the **cost price at that moment is copied onto the
  order line**. Changing a cost price later never rewrites past profit.
- **Profit appears only after you fill in cost prices** on the Prices page. Until
  then cost is 0 and profit equals revenue.
- Renaming a restaurant moves its orders and payments with it — history is never
  orphaned.

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
| DELETE | `/api/orders/:id` | Remove a mistaken order |
| GET | `/api/products` | Price list (selling + cost) |
| POST | `/api/products` | Add item `{ name, price, cost, unit }` |
| PATCH | `/api/products/:id` | Change `name` / `price` / `cost` / `unit` / `active` |
| GET | `/api/restaurants` | Restaurants + WhatsApp numbers |
| POST | `/api/restaurants` | Add restaurant `{ name, phone }` |
| PATCH | `/api/restaurants/:id` | Change `name` / `phone` / `active` (history follows) |
| GET | `/api/payments?restaurant=` | Payments received |
| POST | `/api/payments` | Record payment `{ restaurant, amount, method, note }` |
| DELETE | `/api/payments/:id` | Remove a mistaken payment |
| GET | `/api/accounts` | Billed / paid / balance per restaurant |
| GET | `/api/accounts/statement?restaurant=X&days=365` | Statement with running balance |
| GET | `/api/buyer/:token` | Buyer page data: their products, orders, balance |
| POST | `/api/buyer/:token/orders` | Buyer submits an order (prices from the price list) |
| POST | `/api/restaurants/:id/rotate-token` | Issue a new buyer link |
| POST | `/api/orders/:id/confirm` | Confirm an order and release it to the workers |
| GET | `/api/staff-link` | The shared workers link token |
| POST | `/api/staff-link/rotate` | Issue a new workers link |
| GET | `/api/staff/:token/orders` | Active orders + delivered today (no money internals) |
| PATCH | `/api/staff/:token/orders/:id/status` | Worker sets `dispatched` / `delivered` |
| GET | `/api/shop` | Public catalogue + shop settings |
| POST | `/api/shop/orders` | Public order `{ name, phone, area, items:[{name,weight}] }` |
| POST | `/api/agent/chat` | Sales assistant `{ messages:[{role,content}], session }` |
| GET/PATCH | `/api/shop/settings` | Shop name, phone, delivery fee, minimum, areas |
| GET | `/api/analytics?days=30` | Everything the Analytics page needs |
| POST | `/api/login` · `/api/logout` · GET `/api/session` | Password login |
| GET | `/health` | `{ ok, orders, authRequired, db }` |

Totals are recomputed on the server from weight × price, so the database stays
correct even if a browser sends odd numbers.

## Workers screen (no WhatsApp needed)

A separate phone-sized page for your team, e.g.
`https://boda-boda-express.onrender.com/work/541f7b59044f464b`.

1. You build and submit an order — it is **Pending**.
2. Press **✓ Confirm order → send to workers**. It is now **Confirmed** and appears
   on the workers screen instantly.
3. A worker presses **🛵 Start delivery** → **Dispatched**.
4. When it arrives they press **✓ Delivered** → **Delivered**, and it drops into the
   "delivered today" list at the bottom.

Workers see the restaurant, order number, time, the item list in kilos and the
order total — enough to pack and collect payment. They cannot see your cost
prices, profit, analytics, accounts or other admin screens.

The screen refreshes itself every 10 seconds, so nobody has to reload it. Get or
change the link on **Orders → 👷 Workers screen**: copy it, open it, or press ↻
for a fresh link (the old one stops working immediately).

WhatsApp is still there as an option, but it is no longer the way an order reaches
the team.

## Buyer ordering links (let restaurants order themselves)

Every restaurant has a private link like
`https://boda-boda-express.onrender.com/order/78cbe58175fe4c96`.

On that page the restaurant sees **only their own** name, today's prices, weight
boxes, their own recent orders and their own balance. They cannot see other
restaurants, your cost prices, your profit, or any admin screen — the buyer API
is scoped by the token in the link and sits outside the password login entirely.

Manage links on **Prices & Stock → Restaurants**:

- **📋 Copy** — copies the link to your clipboard
- **Send** — opens WhatsApp with the link already written to that restaurant
- **↻** — issues a new link; the old one stops working immediately (use it if a
  link gets forwarded to the wrong person)

Two protections worth knowing: prices always come from the server, so a buyer
cannot send a cheaper price from their browser, and hidden items are rejected.

## Online shop (sell to households)

Public storefront at **/shop** — no login, no app:
`https://boda-boda-express.onrender.com/shop`

Customers pick kilos, give name / phone / area, and place the order. It lands in
**Orders** tagged **Online shop**, with their phone number and area on the card, so
you can call, confirm and dispatch to a rider.

Configure it on **Prices & Stock → 🏪 Online shop**: shop name, phone, delivery fee,
minimum order, and the delivery areas (comma separated).

## The sales assistant (optional)

The shop has a chat bubble that answers price questions and can take an order in
conversation. It is **off until you add a key**:

| Env var on Render | Value |
| --- | --- |
| `LLM_API_KEY` | your DeepSeek (or any OpenAI-compatible) key |
| `LLM_BASE_URL` | `https://api.deepseek.com` (default) |
| `LLM_MODEL` | `deepseek-chat` (default) |

How it is kept honest:

- It reads items and prices **only through the `get_catalog` tool** — it cannot
  invent a price, and prices are re-checked again when the order is saved.
- It only creates an order after the customer confirms; the order arrives as
  **Pending** for you to approve — it never confirms, dispatches or promises credit.
- Complaints, refunds, wholesale and missing deliveries are handed to a human.
- Every conversation is stored in the `agent_logs` table for review.

Without a key the chat bubble is hidden and the order form still works normally.

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
