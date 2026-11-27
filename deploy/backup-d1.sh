#!/usr/bin/env bash
# Nightly copy of the live D1 database onto the Pi, for the home-network viewer and as an
# offline backup. Uses D1's export API, so the Pi never polls the airport itself.
#
# Needs CLOUDFLARE_API_TOKEN (Account > D1 > Edit), CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID,
# read from /etc/sba-parking-backup.env by the systemd unit. Keeps KEEP_NIGHTS dated copies in
# BACKUP_DIR and swaps the newest into DB_PATH for the viewer.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/opt/sba-parking/data/backups}
DB_PATH=${DB_PATH:-/opt/sba-parking/data/parking.db}
KEEP_NIGHTS=${KEEP_NIGHTS:-14}
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/export"

mkdir -p "$BACKUP_DIR"
stamp=$(date +%Y%m%d)
db="$BACKUP_DIR/parking-$stamp.db"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export_call() {
  curl -fsS -X POST "$API" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

json_get() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))})' "$1"
}

# The export runs asynchronously: keep asking with the bookmark until it reports complete.
body='{"output_format":"polling"}'
url=''
for _ in $(seq 1 60); do
  res=$(export_call "$body")
  status=$(json_get result.status <<<"$res")
  case "$status" in
    complete)
      url=$(json_get result.result.signed_url <<<"$res")
      break
      ;;
    error)
      echo "export failed: $(json_get result.error <<<"$res")" >&2
      exit 1
      ;;
  esac
  bookmark=$(json_get result.at_bookmark <<<"$res")
  body="{\"output_format\":\"polling\",\"current_bookmark\":\"$bookmark\"}"
  sleep 5
done
if [[ -z "$url" ]]; then
  echo 'export did not complete within 5 minutes' >&2
  exit 1
fi

curl -fsS -o "$work/dump.sql" "$url"
node --disable-warning=ExperimentalWarning -e '
  const { readFileSync } = require("node:fs")
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.argv[2])
  db.exec(readFileSync(process.argv[1], "utf8"))
  const n = db.prepare("SELECT COUNT(*) AS n FROM readings").get().n
  if (!n) throw new Error("export has no readings")
  console.log(`restored ${n} readings`)
  db.close()
' "$work/dump.sql" "$work/parking.db"

cp "$work/parking.db" "$db"
# Same-filesystem rename, so the viewer never sees a half-written file.
cp "$work/parking.db" "$DB_PATH.new"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"
mv "$DB_PATH.new" "$DB_PATH"

find "$BACKUP_DIR" -name 'parking-*' -mtime +"$KEEP_NIGHTS" -delete
echo "backup ok: $db"
