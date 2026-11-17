# Boda Boda Express — Admin Dashboard

Vegetable ordering dashboard for Panther, Wanda, The Bench and Molover.
Orders are saved in a real database, so nothing disappears when you close the app.

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

That single file holds every order and order item. **Back it up** by copying the
`data` folder (e.g. to Google Drive) — that is your whole business history.

## Pages

- **Orders** — build an order, pick the restaurant, add items by weight, submit.
  Recent orders show above with a status chip: click it to move an order
  Pending → Dispatched → Delivered.
- **Analytics** — revenue, order count, kilos moved, average order, revenue per
  day, revenue per restaurant, top vegetables. Switch between 7 / 30 / 90 days.

## API (used by the frontend, handy for phones later)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/orders?limit=100` | Order history |
| POST | `/api/orders` | Save an order `{ restaurant, items:[{name,weight,price}] }` |
| PATCH | `/api/orders/:id/status` | Set `pending` / `dispatched` / `delivered` |
| GET | `/api/analytics?days=30` | Everything the Analytics page needs |
| GET | `/health` | `{ ok, orders, db }` |

Prices and totals are recomputed on the server, so the database stays correct
even if the browser sends odd numbers.

## Rebuilding after a code change

```
cd frontend && bun run build          # rebuild the UI, then copy dist up
cd .. && Copy-Item frontend\dist dist -Recurse -Force
bun build --compile --outfile BodaBodaExpress.exe server.ts
```

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DB_DIR` | `./data` | Folder holding `boda.db` |

## Note on the database choice

SQLite (built into Bun) is used instead of Postgres: no server to start, no
password, nothing to install, and it is plenty for one dashboard. If you later
host this online so restaurants order from their own phones, switch to Render
Postgres — the API and pages stay the same, only the storage layer changes.
