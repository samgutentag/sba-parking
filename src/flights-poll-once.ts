// One flights poll, then exit. Mirrors poll-once.ts, for cron-style deployments that run the
// parking and flights polls as two separate scheduled jobs instead of one long-running process.
import { nodePaths } from './node-paths.ts'
import { SqliteStore } from './sqlite-store.ts'
import { pollFlightsOnce } from './flights-poller.ts'

const db = new SqliteStore(nodePaths.dbPath)
try {
  const outcome = await pollFlightsOnce(db)
  if (outcome.ok) {
    console.log(`flights poll ok: ${outcome.inserted} new of ${outcome.seen} flights`)
  } else {
    console.error(`flights poll failed: ${outcome.error}`)
    process.exitCode = 1
  }
} finally {
  await db.close()
}
