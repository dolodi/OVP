import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = Number(process.env.PORT || 8787)
const tokenUrl = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const openSkyStatesUrl = 'https://opensky-network.org/api/states/all'
const refreshWindowMs = Math.max(Number(process.env.OPENSKY_REFRESH_WINDOW_MS || 72_000), 5_000)
const diskCacheEnabled = process.env.OPENSKY_PERSIST_CACHE !== 'false'
const diskCacheDir = process.env.OPENSKY_CACHE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data')
const latestSnapshotPath = path.join(diskCacheDir, 'opensky-latest.json')

const tokenCache = {
  accessToken: null,
  expiresAtMs: 0,
}

const snapshotCache = {
  entry: null,
  blockedUntilMs: 0,
  inFlightPromise: null,
}

function parseHeaderNumber(value) {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : null
}

function computeNextRefreshMs(fetchedAtMs, usage) {
  const retryAfterMs = usage.retryAfterSeconds ? usage.retryAfterSeconds * 1000 : 0

  return Math.max(fetchedAtMs + refreshWindowMs, fetchedAtMs + retryAfterMs)
}

function decorateSnapshot(entry, source, extra = {}) {
  const ageMs = Math.max(Date.now() - entry.fetchedAtMs, 0)
  const isStale = Date.now() >= entry.nextRefreshMs
  const nextRefreshInMs = Math.max(entry.nextRefreshMs - Date.now(), 0)

  return {
    ...entry.payload,
    cache: {
      source,
      isStale,
      ageMs,
      refreshWindowMs,
      nextRefreshAt: new Date(entry.nextRefreshMs).toISOString(),
      nextRefreshInSeconds: Math.ceil(nextRefreshInMs / 1000),
      blockedUntil: snapshotCache.blockedUntilMs
        ? new Date(snapshotCache.blockedUntilMs).toISOString()
        : null,
    },
    ...extra,
  }
}

async function ensureDiskCacheDir() {
  if (!diskCacheEnabled) {
    return
  }

  await fs.mkdir(diskCacheDir, { recursive: true })
}

async function persistLatestSnapshot(entry) {
  if (!diskCacheEnabled) {
    return
  }

  await ensureDiskCacheDir()
  await fs.writeFile(
    latestSnapshotPath,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        entry,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function loadLatestSnapshot() {
  if (!diskCacheEnabled) {
    return
  }

  try {
    const serialized = await fs.readFile(latestSnapshotPath, 'utf8')
    const parsed = JSON.parse(serialized)

    if (!parsed?.entry?.payload || !parsed?.entry?.fetchedAtMs || !parsed?.entry?.nextRefreshMs) {
      return
    }

    snapshotCache.entry = parsed.entry
    snapshotCache.blockedUntilMs = parsed.entry.nextRefreshMs
    console.log(`Loaded cached OpenSky snapshot from ${latestSnapshotPath}`)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to load cached OpenSky snapshot: ${error.message}`)
    }
  }
}

function mapStateVector(state) {
  return {
    icao24: state[0],
    callsign: state[1]?.trim() || null,
    originCountry: state[2],
    timePosition: state[3],
    lastContact: state[4],
    longitude: state[5],
    latitude: state[6],
    baroAltitude: state[7],
    onGround: state[8],
    velocity: state[9],
    trueTrack: state[10],
    verticalRate: state[11],
    geoAltitude: state[13],
    squawk: state[14],
    spi: state[15],
    positionSource: state[16],
  }
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.accessToken
  }

  const clientId = process.env.OPENSKY_CLIENT_ID
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET in .env')
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`OpenSky token request failed: ${response.status} ${details}`)
  }

  const payload = await response.json()

  tokenCache.accessToken = payload.access_token
  tokenCache.expiresAtMs = Date.now() + Math.max((payload.expires_in ?? 60) - 30, 5) * 1000

  return tokenCache.accessToken
}

async function refreshSnapshotFromOpenSky() {
  const startedAt = Date.now()
  const token = await getAccessToken()
  const upstream = await fetch(openSkyStatesUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const rawText = await upstream.text()
  const usage = {
    remaining: parseHeaderNumber(upstream.headers.get('x-rate-limit-remaining')),
    retryAfterSeconds: parseHeaderNumber(upstream.headers.get('x-rate-limit-retry-after-seconds')),
    creditCost: 4,
    durationMs: Date.now() - startedAt,
  }

  if (!upstream.ok) {
    snapshotCache.blockedUntilMs = computeNextRefreshMs(Date.now(), usage)

    const error = new Error(`OpenSky request failed with status ${upstream.status}`)
    error.statusCode = upstream.status
    error.details = rawText
    error.usage = usage
    throw error
  }

  const payload = JSON.parse(rawText)
  const states = Array.isArray(payload.states)
    ? payload.states
        .map(mapStateVector)
        .filter((flight) => Number.isFinite(flight.latitude) && Number.isFinite(flight.longitude))
    : []
  const fetchedAtMs = Date.now()
  const entry = {
    fetchedAtMs,
    nextRefreshMs: computeNextRefreshMs(fetchedAtMs, usage),
    payload: {
      ok: true,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      summary: {
        time: payload.time,
        stateCount: Array.isArray(payload.states) ? payload.states.length : 0,
        plottedCount: states.length,
      },
      usage,
      states,
    },
  }

  snapshotCache.entry = entry
  snapshotCache.blockedUntilMs = entry.nextRefreshMs
  void persistLatestSnapshot(entry).catch((error) => {
    console.warn(`Unable to persist OpenSky snapshot: ${error.message}`)
  })

  return entry
}

async function getSharedSnapshot() {
  const currentEntry = snapshotCache.entry

  if (currentEntry && Date.now() < currentEntry.nextRefreshMs) {
    return decorateSnapshot(currentEntry, 'shared-cache')
  }

  if (snapshotCache.inFlightPromise) {
    const entry = await snapshotCache.inFlightPromise

    return decorateSnapshot(entry, 'shared-cache')
  }

  if (Date.now() < snapshotCache.blockedUntilMs) {
    if (snapshotCache.entry) {
      return decorateSnapshot(snapshotCache.entry, 'stale-cache', {
        warning: 'Serving the latest cached snapshot until the next allowed OpenSky refresh window.',
      })
    }

    const retryAfterSeconds = Math.ceil((snapshotCache.blockedUntilMs - Date.now()) / 1000)
    const error = new Error(`OpenSky refresh is temporarily blocked. Retry in ${retryAfterSeconds}s.`)
    error.statusCode = 503
    error.retryAfterSeconds = retryAfterSeconds
    throw error
  }

  snapshotCache.inFlightPromise = refreshSnapshotFromOpenSky()

  try {
    const entry = await snapshotCache.inFlightPromise

    return decorateSnapshot(entry, 'upstream')
  } catch (error) {
    if (snapshotCache.entry) {
      return decorateSnapshot(snapshotCache.entry, 'stale-cache', {
        warning: error.message,
      })
    }

    throw error
  } finally {
    snapshotCache.inFlightPromise = null
  }
}

app.get('/api/states/all', async (_request, response) => {
  const startedAt = Date.now()

  try {
    const payload = await getSharedSnapshot()

    response.set('Cache-Control', 'no-store')
    response.json(payload)
  } catch (error) {
    if (error.retryAfterSeconds) {
      response.set('Retry-After', String(error.retryAfterSeconds))
    }

    response.status(error.statusCode || 500).json({
      ok: false,
      error: error.message,
      details: error.details,
      usage: {
        remaining: null,
        retryAfterSeconds: error.retryAfterSeconds ?? null,
        creditCost: 4,
        durationMs: Date.now() - startedAt,
      },
    })
  }
})

app.get('/api/cache/status', (_request, response) => {
  response.json({
    ok: true,
    hasSnapshot: Boolean(snapshotCache.entry),
    inFlightRefresh: Boolean(snapshotCache.inFlightPromise),
    refreshWindowMs,
    blockedUntil: snapshotCache.blockedUntilMs
      ? new Date(snapshotCache.blockedUntilMs).toISOString()
      : null,
    latestSnapshot: snapshotCache.entry
      ? decorateSnapshot(snapshotCache.entry, 'shared-cache')
      : null,
  })
})

const distDir = path.join(__dirname, 'dist')

app.use(express.static(distDir))

app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) {
    next()
    return
  }

  response.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) {
      next()
    }
  })
})

loadLatestSnapshot()
  .catch((error) => {
    console.warn(`OpenSky cache bootstrap failed: ${error.message}`)
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`OpenSky proxy listening on http://localhost:${port}`)
      console.log(`Shared refresh window: ${refreshWindowMs}ms`)
      if (diskCacheEnabled) {
        console.log(`Disk cache path: ${latestSnapshotPath}`)
      }
    })
  })