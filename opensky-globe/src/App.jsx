import { useEffect, useState } from 'react'
import Globe from 'react-globe.gl'
import './App.css'

const REFRESH_INTERVAL_MS = 60_000
const GLOBE_IMAGES = {
  surface: '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  atmosphere: '//unpkg.com/three-globe/example/img/night-sky.png',
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'N/A'
  }

  return new Intl.NumberFormat('en-US').format(value)
}

function formatTimestamp(value) {
  if (!value) {
    return 'N/A'
  }

  return new Date(value).toLocaleString()
}

function formatSnapshotTime(value) {
  if (!value) {
    return 'N/A'
  }

  return new Date(value * 1000).toLocaleString()
}

function formatDuration(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'N/A'
  }

  if (value < 1000) {
    return `${value} ms`
  }

  return `${(value / 1000).toFixed(1)} s`
}

function getPointColor(flight) {
  if (flight.onGround) {
    return '#ff7b72'
  }

  if (flight.velocity >= 250) {
    return '#ffd166'
  }

  return '#5eead4'
}

function getPointAltitude(flight) {
  if (!flight.geoAltitude && !flight.baroAltitude) {
    return 0.01
  }

  const altitude = flight.geoAltitude ?? flight.baroAltitude ?? 0

  return Math.min(Math.max(altitude / 120000, 0.01), 0.18)
}

function useViewportSize() {
  const [viewport, setViewport] = useState({
    width: typeof window === 'undefined' ? 1200 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  })

  useEffect(() => {
    function handleResize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    }

    window.addEventListener('resize', handleResize)

    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return viewport
}

function App() {
  const [snapshot, setSnapshot] = useState([])
  const [summary, setSummary] = useState(null)
  const [usage, setUsage] = useState(null)
  const [cacheInfo, setCacheInfo] = useState(null)
  const [requestStatus, setRequestStatus] = useState('idle')
  const [statusMessage, setStatusMessage] = useState('Waiting for the first OpenSky request.')
  const [lastFetchedAt, setLastFetchedAt] = useState(null)
  const { width, height } = useViewportSize()

  useEffect(() => {
    let isMounted = true

    async function loadStates() {
      setRequestStatus((current) => (current === 'success' ? 'refreshing' : 'loading'))
      setStatusMessage('Requesting the latest world state vectors from OpenSky.')

      try {
        const response = await fetch('/api/states/all')
        const payload = await response.json()

        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || `Request failed with status ${response.status}`)
        }

        if (!isMounted) {
          return
        }

        setSnapshot(payload.states)
        setSummary(payload.summary)
        setUsage(payload.usage)
        setCacheInfo(payload.cache)
        setLastFetchedAt(payload.fetchedAt)
        setRequestStatus('success')
        setStatusMessage(
          `Served ${formatNumber(payload.summary.stateCount)} live state vectors from ${payload.cache?.source || 'the server cache'}.`,
        )
      } catch (error) {
        if (!isMounted) {
          return
        }

        setRequestStatus('error')
        setStatusMessage(error.message)
      }
    }

    loadStates()
    const intervalId = window.setInterval(loadStates, REFRESH_INTERVAL_MS)

    return () => {
      isMounted = false
      window.clearInterval(intervalId)
    }
  }, [])

  const globeWidth = Math.max(Math.min(width - 48, 1200), 320)
  const globeHeight = Math.max(Math.min(height * 0.68, 760), 360)
  const spotlightFlights = snapshot.slice(0, 12)
  const tableFlights = snapshot.slice(0, 12)

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">OpenSky live telemetry</p>
          <h1>Global flights on a live globe.</h1>
          <p className="hero-text">
            This dashboard uses your OpenSky OAuth client through a local Node proxy so the
            browser can visualize worldwide aircraft state vectors without exposing your secret.
          </p>
        </div>

        <div className={`status-banner status-${requestStatus}`}>
          <span className="status-pill">{requestStatus}</span>
          <p>{statusMessage}</p>
          <button
            className="refresh-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload app
          </button>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span className="metric-label">Live flights plotted</span>
          <strong>{formatNumber(summary?.plottedCount ?? snapshot.length)}</strong>
          <small>Aircraft with valid coordinates on the globe.</small>
        </article>

        <article className="metric-card">
          <span className="metric-label">OpenSky states returned</span>
          <strong>{formatNumber(summary?.stateCount)}</strong>
          <small>Full-world `/states/all` calls cost 4 API credits.</small>
        </article>

        <article className="metric-card">
          <span className="metric-label">Credits remaining</span>
          <strong>{usage?.remaining ?? 'N/A'}</strong>
          <small>Read from `X-Rate-Limit-Remaining` when available.</small>
        </article>

        <article className="metric-card">
          <span className="metric-label">Last successful fetch</span>
          <strong>{formatTimestamp(lastFetchedAt)}</strong>
          <small>Snapshot time: {formatSnapshotTime(summary?.time)}</small>
        </article>
      </section>

      <section className="visual-panel">
        <div className="globe-card">
          <div className="globe-header">
            <div>
              <h2>Worldwide flight positions</h2>
              <p>Auto-refreshes every 60 seconds. Color shows motion state.</p>
            </div>
            <div className="legend">
              <span><i className="legend-dot fast" />Fast airborne</span>
              <span><i className="legend-dot cruise" />Airborne</span>
              <span><i className="legend-dot ground" />On ground</span>
            </div>
          </div>

          <div className="globe-frame">
            <Globe
              width={globeWidth}
              height={globeHeight}
              globeImageUrl={GLOBE_IMAGES.surface}
              backgroundImageUrl={GLOBE_IMAGES.atmosphere}
              pointsData={snapshot}
              pointsMerge
              pointLat={(flight) => flight.latitude}
              pointLng={(flight) => flight.longitude}
              pointAltitude={getPointAltitude}
              pointColor={getPointColor}
              pointRadius={0.12}
              pointResolution={5}
              labelsData={spotlightFlights}
              labelLat={(flight) => flight.latitude}
              labelLng={(flight) => flight.longitude}
              labelText={(flight) => flight.callsign || flight.icao24}
              labelSize={1.4}
              labelDotRadius={0.24}
              labelColor={() => '#f8fafc'}
              labelResolution={2}
            />
          </div>
        </div>

        <aside className="sidebar-card">
          <h2>Request diagnostics</h2>
          <dl className="diagnostic-list">
            <div>
              <dt>Backend route</dt>
              <dd>/api/states/all</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>{requestStatus}</dd>
            </div>
            <div>
              <dt>Retry after</dt>
              <dd>{usage?.retryAfterSeconds ? `${usage.retryAfterSeconds}s` : 'N/A'}</dd>
            </div>
            <div>
              <dt>Cache source</dt>
              <dd>{cacheInfo?.source || 'N/A'}</dd>
            </div>
            <div>
              <dt>Cache age</dt>
              <dd>{formatDuration(cacheInfo?.ageMs)}</dd>
            </div>
            <div>
              <dt>Credit cost</dt>
              <dd>{usage?.creditCost ?? 4}</dd>
            </div>
            <div>
              <dt>Server latency</dt>
              <dd>{usage?.durationMs ? `${usage.durationMs} ms` : 'N/A'}</dd>
            </div>
            <div>
              <dt>Next refresh</dt>
              <dd>{cacheInfo?.nextRefreshAt ? formatTimestamp(cacheInfo.nextRefreshAt) : 'N/A'}</dd>
            </div>
          </dl>

          <div className="status-note">
            <h3>Current response</h3>
            <p>{statusMessage}</p>
            {cacheInfo?.isStale ? <p>The app is showing the most recent cached snapshot while the server waits for the next allowed refresh.</p> : null}
          </div>
        </aside>
      </section>

      <section className="table-panel">
        <div className="table-header">
          <div>
            <p className="eyebrow">Top visible aircraft</p>
            <h2>Live state vector details</h2>
          </div>
          <p className="table-meta">Showing the first {tableFlights.length} aircraft from the latest snapshot.</p>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Callsign</th>
                <th>ICAO24</th>
                <th>Country</th>
                <th>Altitude (m)</th>
                <th>Speed (m/s)</th>
                <th>Track</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tableFlights.map((flight) => (
                <tr key={`${flight.icao24}-${flight.lastContact}`}>
                  <td>{flight.callsign || 'N/A'}</td>
                  <td>{flight.icao24}</td>
                  <td>{flight.originCountry}</td>
                  <td>{formatNumber(Math.round(flight.geoAltitude ?? flight.baroAltitude ?? 0))}</td>
                  <td>{formatNumber(Math.round(flight.velocity ?? 0))}</td>
                  <td>{flight.trueTrack ? `${Math.round(flight.trueTrack)}°` : 'N/A'}</td>
                  <td>{flight.onGround ? 'Ground' : 'Airborne'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default App
