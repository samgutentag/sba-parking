import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { handleApi } from './api.ts'
import { stampAssetUrls, VERSIONED_ASSETS } from './assets.ts'
import { nodePaths } from './node-paths.ts'
import type { ParkingStore } from './store.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

// Built once per process: a deploy is always a restart. See assets.ts for why the stamp exists.
let indexHtml: Promise<string> | null = null

async function buildIndexHtml(root: string): Promise<string> {
  const html = await readFile(join(root, 'index.html'), 'utf8')
  const hashes: Record<string, string> = {}
  for (const asset of VERSIONED_ASSETS) {
    hashes[asset] = createHash('sha256').update(await readFile(join(root, asset))).digest('hex').slice(0, 10)
  }
  return stampAssetUrls(html, hashes)
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const root = resolve(nodePaths.publicDir)
  if (pathname === '/' || pathname === '/index.html') {
    // Reset on failure so one bad read (say, mid-deploy) doesn't wedge the page until restart.
    indexHtml ??= buildIndexHtml(root).catch((err) => { indexHtml = null; throw err })
    const html = await indexHtml
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-cache',
    })
    res.end(html)
    return
  }
  const rel = normalize(decodeURIComponent(pathname))
  const file = join(root, rel)
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

export function createServer(db: ParkingStore): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end()
        return
      }
      const api = await handleApi(db, url.pathname, url)
      if (api) return sendJson(res, api.status, api.body)
      await serveStatic(url.pathname, res)
    } catch (err) {
      console.error(err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  })
}
