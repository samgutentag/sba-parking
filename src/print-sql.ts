// Prints the schema plus one named statement from store.ts, for running against D1 with
// `wrangler d1 execute --file`. Used by `pnpm worker:rebuild-rollup`.
import { SCHEMA_STATEMENTS, SQL } from './store.ts'

const name = process.argv[2] as keyof typeof SQL | undefined
if (!name || !(name in SQL)) {
  console.error(`usage: print-sql.ts <${Object.keys(SQL).join('|')}>`)
  process.exit(1)
}
console.log([...SCHEMA_STATEMENTS, SQL[name]].map((s) => `${s.trim()};`).join('\n'))
