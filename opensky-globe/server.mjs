import dotenv from 'dotenv'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = Number(process.env.PORT || 8787)
const tokenUrl = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const openSkyStatesUrl = 'https://opensky-network.org/api/states/all'

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

  return payload.access_token
}

app.get('/api/states/all', async (_request, response) => {
  const startedAt = Date.now()

  try {
    const token = await getAccessToken()
    const upstream = await fetch(openSkyStatesUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const rawText = await upstream.text()
    const usage = {
      remaining: upstream.headers.get('x-rate-limit-remaining'),
      retryAfterSeconds: upstream.headers.get('x-rate-limit-retry-after-seconds'),
      creditCost: 4,
      durationMs: Date.now() - startedAt,
    }

    if (!upstream.ok) {
      response.status(upstream.status).json({
        ok: false,
        error: `OpenSky request failed with status ${upstream.status}`,
        details: rawText,
        usage,
      })
      return
    }

    const payload = JSON.parse(rawText)
    const states = Array.isArray(payload.states)
      ? payload.states
          .map(mapStateVector)
          .filter((flight) => Number.isFinite(flight.latitude) && Number.isFinite(flight.longitude))
      : []

    response.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      summary: {
        time: payload.time,
        stateCount: Array.isArray(payload.states) ? payload.states.length : 0,
        plottedCount: states.length,
      },
      usage,
      states,
    })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error.message,
      usage: {
        remaining: null,
        retryAfterSeconds: null,
        creditCost: 4,
        durationMs: Date.now() - startedAt,
      },
    })
  }
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

app.listen(port, () => {
  console.log(`OpenSky proxy listening on http://localhost:${port}`)
})