// Filesystem locations for the Node runtime only. Kept out of config.ts so the Worker bundle
// never evaluates import.meta.url-relative paths it has no filesystem for.
import { fileURLToPath } from 'node:url'

export const nodePaths = {
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../data/parking.db', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
} as const
