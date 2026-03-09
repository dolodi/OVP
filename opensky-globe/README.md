# OpenSky Globe Monitor

Vite + React frontend with a Node/Express proxy that now acts as a shared OpenSky cache for every connected user.

## Features

- Live globe of worldwide OpenSky state vectors
- API request status with success and error feedback
- Rate-limit and credit usage details from response headers
- Shared server-side auth and snapshot caching so many browsers reuse one upstream fetch
- Optional disk-backed latest snapshot persistence for Railway or any mounted volume

## Setup

Create `.env` in the project root with:

```bash
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
PORT=8787
OPENSKY_REFRESH_WINDOW_MS=72000
OPENSKY_PERSIST_CACHE=true
# Optional: set this to a mounted Railway volume path or a custom directory
# OPENSKY_CACHE_DIR=/app/data
```

## Scripts

- `npm run dev` starts the Vite client and the Node proxy together
- `npm run build` creates the frontend bundle
- `npm run start` serves the API and built frontend from Node

## Notes

- The browser only talks to your server. The server caches the latest OpenSky snapshot globally and serves it to all users.
- The proxy enforces a minimum upstream refresh window of 72 seconds by default. If 20 users open the app at once, they all receive the same cached snapshot or wait for the same in-flight refresh.
- OAuth tokens are cached on the server until near expiry, so the token endpoint is not called on every client request.
- The latest snapshot can be restored from disk on restart when `OPENSKY_PERSIST_CACHE=true` and a writable directory is available.
- A full-world request costs 4 API credits per request according to the OpenSky documentation.

## Recommended deployment pattern

For your use case, the cleanest setup is:

1. Deploy this Express server to Railway.
2. Put `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in Railway environment variables.
3. Attach a Railway volume and either mount it to `/app/data` or set `OPENSKY_CACHE_DIR` to the mount path.
4. Point your frontend to the Railway server instead of a local proxy.

This works well because Railway gives you a single always-on server process and persistent volumes for the latest cached snapshot. Railway Cron is not a good fit for a 72-second refresh policy because Railway's cron documentation says the shortest interval is 5 minutes.

## How the shared cache behaves

- If a cached snapshot is still inside the refresh window, the server returns it immediately.
- If the cache is stale and no refresh is running, the server fetches OpenSky once.
- If multiple users arrive while that refresh is running, they all reuse the same in-flight request.
- If OpenSky says to wait, the server serves the last cached snapshot until the next allowed refresh time.

## Optional 24-hour history

If you want a full 24-hour flight snapshot history, use a database rather than flat files. Full-world snapshots every 72 seconds become large quickly.

Supabase is the better fit for that part:

- Store each snapshot row in Postgres with a `captured_at` timestamp and a `jsonb` payload.
- Supabase documents `jsonb` as the recommended JSON storage type for unstructured payloads.
- Supabase Cron can schedule cleanup jobs in Postgres, which is useful for deleting rows older than 24 hours.

Suggested table shape:

```sql
create table opensky_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  state_count integer not null,
  plotted_count integer not null,
  payload jsonb not null
);

create index opensky_snapshots_captured_at_idx
  on opensky_snapshots (captured_at desc);

delete from opensky_snapshots
where captured_at < now() - interval '24 hours';
```

Keep the live app on Railway and treat Supabase as optional history storage, not as the main live cache path.

## Important policy note

OpenSky's published terms restrict how data can be shared and used, especially outside approved research, education, government, or separately licensed commercial use. Before exposing one key-backed server to many end users, verify that your OpenSky usage and redistribution model is permitted under your agreement.
