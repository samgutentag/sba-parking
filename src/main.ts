import { config } from './config.ts'
import { SqliteStore } from './sqlite-store.ts'
import { startPoller } from './poller.ts'
import { startFlightsPoller } from './flights-poller.ts'
import { createServer } from './server.ts'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

const db = new SqliteStore(config.dbPath)
const poller = config.pollEnabled ? startPoller(db, log) : undefined
if (!poller) log('polling disabled (POLL=0)')
const flightsPoller = config.flightsPollEnabled ? startFlightsPoller(db, log) : undefined
if (!flightsPoller) log('flights polling disabled (POLL_FLIGHTS=0)')

const server = createServer(db)
server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}  db=${config.dbPath}`)
})

let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} received, shutting down`)
  poller?.stop()
  flightsPoller?.stop()
  server.close(() => {
    void db.close().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
