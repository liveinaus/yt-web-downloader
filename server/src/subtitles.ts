// Helpers for building a bilingual subtitle track out of two single-language
// VTT files, plus the language-code lookups used when tagging embedded tracks.

export type Cue = {
  start: number // milliseconds
  end: number
  text: string
}

// Common language codes -> ISO 639-2/B (for the ffmpeg stream "language" tag)
const ISO3: Record<string, string> = {
  en: 'eng', zh: 'zho', 'zh-hans': 'zho', 'zh-hant': 'zho', es: 'spa', fr: 'fra',
  de: 'deu', ja: 'jpn', ko: 'kor', ru: 'rus', pt: 'por', it: 'ita', ar: 'ara',
  hi: 'hin', vi: 'vie', th: 'tha', id: 'ind'
}

// Common language codes -> human-readable names (for the track title)
const NAMES: Record<string, string> = {
  en: 'English', zh: 'Chinese', 'zh-hans': 'Chinese (Simplified)',
  'zh-hant': 'Chinese (Traditional)', es: 'Spanish', fr: 'French', de: 'German',
  ja: 'Japanese', ko: 'Korean', ru: 'Russian', pt: 'Portuguese', it: 'Italian',
  ar: 'Arabic', hi: 'Hindi', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian'
}

export function langIso3(code: string): string {
  const key = code.toLowerCase()
  return ISO3[key] ?? ISO3[key.split('-')[0]!] ?? 'und'
}

export function langName(code: string): string {
  const key = code.toLowerCase()
  return NAMES[key] ?? NAMES[key.split('-')[0]!] ?? code
}

function parseTimestamp(value: string): number {
  // HH:MM:SS.mmm or MM:SS.mmm
  const [hms, ms = '0'] = value.trim().split('.')
  const parts = hms!.split(':').map(Number)
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0]!, parts[1]!]
  return ((h! * 60 + m!) * 60 + s!) * 1000 + Number(ms.padEnd(3, '0').slice(0, 3))
}

function formatTimestamp(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const millis = Math.floor(ms % 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`
}

// Strips inline markup (e.g. <c>, <00:00:01.000>) that YouTube adds to cue text
function cleanText(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function parseVtt(content: string): Cue[] {
  const blocks = content.replace(/\r\n/g, '\n').split('\n\n')
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx === -1) continue // WEBVTT header, NOTE/STYLE blocks
    const [range] = lines[timeIdx]!.split(/\s+/).length ? [lines[timeIdx]!] : []
    const match = range!.match(/([\d:.]+)\s*-->\s*([\d:.]+)/)
    if (!match) continue
    const text = cleanText(lines.slice(timeIdx + 1).join('\n'))
    if (!text) continue
    cues.push({ start: parseTimestamp(match[1]!), end: parseTimestamp(match[2]!), text })
  }
  return cues
}

// Merges two cue lists into one, keyed on the primary track's timeline. Each
// primary cue is paired with the secondary cue it overlaps most, stacking the
// two languages (primary on top). Works whether the tracks share identical cue
// timings (the common auto-translate case) or drift apart.
export function mergeBilingual(primary: Cue[], secondary: Cue[]): Cue[] {
  return primary
    .map((p) => {
      let best: Cue | undefined
      let bestOverlap = 0
      for (const s of secondary) {
        const overlap = Math.min(p.end, s.end) - Math.max(p.start, s.start)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          best = s
        }
      }
      const text = best && best.text !== p.text ? `${p.text}\n${best.text}` : p.text
      return { start: p.start, end: p.end, text }
    })
    .filter((c) => c.text)
}

export function toVtt(cues: Cue[]): string {
  const body = cues
    .map((c) => `${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}
