// Cloudflare overrides our no-cache on .js/.css with a 4h browser TTL, so after a deploy
// visitors could run old JS/CSS against the new API. Stamping the asset URLs in index.html
// with a hash of their contents makes every deploy a new URL, which no cache has seen. The
// page itself isn't cached, so it always carries the current stamp.
//
// The page references these relative to itself (no leading slash) so it works both at the
// root and under a path prefix like /sba-parking/.
export const VERSIONED_ASSETS = ['app.js', 'style.css'] as const

export function stampAssetUrls(html: string, hashes: Record<string, string>): string {
  for (const [asset, hash] of Object.entries(hashes)) {
    html = html.replaceAll(`"${asset}"`, `"${asset}?v=${hash}"`)
  }
  return html
}
