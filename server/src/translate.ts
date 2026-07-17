// Translates text using Google's free (unofficial) translate endpoint. Used to
// build translated filename prefixes. No API key; may be rate-limited or blocked
// on some networks, so callers should treat failures as non-fatal.
export async function translateText(text: string, target: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto' +
    `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`)
  // Response shape: [[[translated, original, ...], ...], ...]
  const data = (await res.json()) as unknown
  const segments = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : []
  const out = segments
    .map((s) => (Array.isArray(s) ? String(s[0] ?? '') : ''))
    .join('')
    .trim()
  if (!out) throw new Error('translate returned empty result')
  return out
}
