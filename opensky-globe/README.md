# OpenSky Globe Monitor

Vite + React frontend with a small Node/Express proxy for the OpenSky OAuth2 client credentials flow.

## Features

- Live globe of worldwide OpenSky state vectors
- API request status with success and error feedback
- Rate-limit and credit usage details from response headers
- Local server-side auth so the browser never receives the client secret

## Setup

Create `.env` in the project root with:

```bash
OPENSKY_CLIENT_ID=your_client_id
OPENSKY_CLIENT_SECRET=your_client_secret
PORT=8787
```

## Scripts

- `npm run dev` starts the Vite client and the Node proxy together
- `npm run build` creates the frontend bundle
- `npm run start` serves the API and built frontend from Node

## Notes

- The dashboard calls OpenSky `GET /api/states/all` through the local proxy.
- A full-world request costs 4 API credits per request according to the OpenSky documentation.
- The UI refreshes automatically every 60 seconds.
