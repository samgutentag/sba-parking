// One poll, then exit. For cron-style deployments that do not want a long-running process.
import { nodePaths } from './node-paths.ts'
import { SqliteStore } from './sqlite-store.ts'
import { pollOnce } from './poller.ts'

const db = new SqliteStore(nodePaths.dbPath)
try {
  const outcome = await pollOnce(db)
  if (outcome.ok) {
    console.log(`poll ok: ${outcome.inserted} new of ${outcome.seen} lots`)
  } else {
    console.error(`poll failed: ${outcome.error}`)
    process.exitCode = 1
  }
} finally {
  await db.close()
}
