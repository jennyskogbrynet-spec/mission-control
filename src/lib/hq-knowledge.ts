import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HQLink, HQNote, HQProjectKey, HQSearchResponse, HQSnapshot, HQSourceStatus } from './hq-types'

const ROOTS: Array<{ path: string; project: HQProjectKey }> = [
  { path: '02-projects/babyhub', project: 'babyhub' },
  { path: '02-projects/babysential', project: 'babysential' },
  { path: '02-projects/brrrr', project: 'brrrr' },
  { path: '03-areas/concepts', project: 'shared' },
  { path: '04-resources/learnings/deep-learn', project: 'shared' },
]
const LIMIT = 2_000
const LINK_LIMIT = 20_000
const ENTRY_LIMIT = 12_000
const BYTE_LIMIT = 32 * 1024 * 1024
const FILE_LIMIT = 256 * 1024
const CACHE_MS = 30_000
const EXCLUDED_PATH = /(?:^|[\s._/-])(?:assets?|raw|tmp|temp|daily|private|privat|secrets?|credentials?|tokens?|family|familie|cathrine|elia|lily|samtaler|transcripts?)(?:$|[\s._/-])/iu
const EXCLUDED_CONTENT = /(?:^|[^\p{L}])(?:Cathrine|Elia|Lily)(?:s)?(?:$|[^\p{L}])|(?:api[_ -]?key|access[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*["']?[A-Za-z0-9_/-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:privacy|sensitivity|visibility)\s*:\s*["']?(?:private|restricted|confidential)/imu

type Index = { notes: HQNote[]; links: HQLink[]; sources: HQSourceStatus[]; coverage: HQSnapshot['coverage'] }
type Document = { note: HQNote; content: string; aliases: string[]; text: string }
type CachedIndex = { root: string; expires: number; index: Index; documents: Document[] }
let cache: CachedIndex | undefined
let pending: { root: string; promise: Promise<CachedIndex> } | undefined
let generation = 0

export function invalidateHQKnowledgeCache(): void {
  generation++
  cache = undefined
  pending = undefined
}

export function getHQNoteId(relativePath: string): string {
  if (!allowed(relativePath) || !relativePath.toLowerCase().endsWith('.md')) throw new Error('Note path outside HQ source scope')
  return `note-${createHash('sha256').update(relativePath.normalize('NFC')).digest('hex').slice(0, 20)}`
}

function vaultRoot(): string {
  return path.resolve(process.env.HQ_VAULT_ROOT || path.join(os.homedir(), '.openclaw/workspace/vault'))
}

function normalized(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('nb-NO')
}

function allowed(relative: string): boolean {
  return !relative.includes('\\') && !relative.split('/').some(x => x === '..' || x.startsWith('.')) &&
    !EXCLUDED_PATH.test(relative) && ROOTS.some(root => relative.startsWith(`${root.path}/`))
}

/** Check every component: a symlink inside an allowed subtree must not widen access. */
async function safeFile(root: string, relative: string): Promise<string | null> {
  if (!allowed(relative) || !relative.toLowerCase().endsWith('.md')) return null
  let current = root
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null
  const canonical = await realpath(root)
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) return null
  }
  const resolved = await realpath(current)
  return resolved.startsWith(canonical + path.sep) ? resolved : null
}

async function readDocument(root: string, relative: string): Promise<{ content: string; modifiedAt: string; bytes: number } | null> {
  try {
    const filename = await safeFile(root, relative)
    if (!filename) return null
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > FILE_LIMIT) return null
      const raw = await handle.readFile('utf8')
      if (raw.includes('\0') || EXCLUDED_CONTENT.test(raw)) return null
      // Preserve source knowledge exactly. Consumers must use a Markdown renderer
      // without raw HTML execution and disable remote images at the UI boundary.
      return { content: raw, modifiedAt: stat.mtime.toISOString(), bytes: Buffer.byteLength(raw) }
    } finally { await handle.close() }
  } catch { return null }
}

function metadata(content: string): { fields: Record<string, string[]>; body: string } {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const fields: Record<string, string[]> = {}
  if (!match) return { fields, body: content }
  let key = ''
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([\w-]+):\s*(.*)$/)
    if (entry) {
      key = entry[1].toLowerCase()
      const value = entry[2].trim()
      fields[key] = (value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).split(',') : [value])
        .map(x => x.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean)
    } else {
      const item = line.match(/^\s+-\s+(.+)$/)
      if (item && key) fields[key].push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'))
      else if (line.trim()) key = ''
    }
  }
  return { fields, body: content.slice(match[0].length) }
}

function markdownParts(value: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = []
  // Protect inline literals and both common fence styles before handling prose.
  const literals = /(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\1|(`+)([\s\S]*?)\3/g
  let cursor = 0
  for (const match of value.matchAll(literals)) {
    parts.push({ text: value.slice(cursor, match.index), code: false })
    parts.push({ text: match[2] ?? match[4], code: true })
    cursor = match.index! + match[0].length
  }
  parts.push({ text: value.slice(cursor), code: false })
  return parts
}

export function safeMarkdownText(value: string): string {
  return markdownParts(value).map(part => part.code ? part.text : part.text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Recognized HTML markup only, not arbitrary angle-bracket expressions.
    .replace(/<\/?(?:a|b|br|button|div|em|h[1-6]|hr|i|img|li|ol|p|span|strong|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi, ' ')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label: string) => label || target)
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, '')
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
  ).join(' ').replace(/\s+/g, ' ').trim()
}

function toDocument(relative: string, projectKey: HQProjectKey, read: NonNullable<Awaited<ReturnType<typeof readDocument>>>): Document {
  const { fields, body } = metadata(read.content)
  const title = safeMarkdownText(fields.title?.[0] || body.match(/^#\s+(.+)$/m)?.[1] || path.posix.basename(relative, '.md'))
  const explicitDate = (fields.source_date || fields.sourcedate || fields.published || fields.published_at || fields.date)?.[0]
  const sourceDate = explicitDate && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(explicitDate) && Number.isFinite(Date.parse(explicitDate))
    ? new Date(explicitDate).toISOString() : null
  const tags = (fields.tags || []).map(safeMarkdownText).filter(Boolean).slice(0, 30)
  const kind = relative.includes('/deep-learn/') || tags.includes('learning') ? 'learning'
    : /(?:decision|beslutning)/i.test(relative) || tags.includes('decision') ? 'decision'
      : fields.source_url ? 'source' : 'knowledge'
  const text = safeMarkdownText(body)
  return {
    note: {
      id: getHQNoteId(relative),
      path: relative, title, projectKey, kind, summary: text.slice(0, 260), tags,
      modifiedAt: read.modifiedAt, sourceDate, wordCount: text.split(/\s+/).filter(Boolean).length, linkCount: 0,
    },
    content: read.content, aliases: [...(fields.aliases || []), ...(fields.alias || [])].map(safeMarkdownText),
    // Search original body too: source URLs, identifiers and literals are knowledge.
    text: normalized(`${title} ${tags.join(' ')} ${text} ${body}`),
  }
}

function buildLinks(documents: Document[]): { links: HQLink[]; ambiguous: number; unresolved: number; capped: boolean } {
  const paths = new Map<string, Set<string>>()
  const names = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const normalizedKey = normalized(key.replace(/\.md$/i, ''))
    const values = map.get(normalizedKey) || new Set<string>()
    values.add(id); map.set(normalizedKey, values)
  }
  for (const doc of documents) {
    add(paths, doc.note.path, doc.note.id)
    for (const name of [path.posix.basename(doc.note.path, '.md'), doc.note.title, ...doc.aliases]) add(names, name, doc.note.id)
  }
  const links: HQLink[] = []
  const seen = new Set<string>()
  let ambiguous = 0; let unresolved = 0; let capped = false
  for (const doc of documents) {
    // Code examples are not evidence of relationships between actual notes.
    const body = markdownParts(metadata(doc.content).body).filter(part => !part.code).map(part => part.text).join(' ')
      .replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    const candidates: Array<{ target: string; kind: HQLink['kind'] }> = []
    for (const match of body.matchAll(/(?<!!)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) candidates.push({ target: match[1], kind: 'wikilink' })
    for (const match of body.matchAll(/(?<!!)\[[^\[\]]+\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g)) candidates.push({ target: match[1], kind: 'markdown' })
    for (const candidate of candidates) {
      let target: string
      try { target = decodeURIComponent(candidate.target.split('#')[0]).trim().replace(/\.md$/i, '') } catch { unresolved++; continue }
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue
      let matches: Set<string> | undefined
      if (candidate.kind === 'markdown') {
        const relative = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(doc.note.path), target))
        matches = paths.get(normalized(relative))
      } else {
        matches = paths.get(normalized(target.replace(/^\//, '')))
        if (!matches && target.includes('/')) matches = paths.get(normalized(path.posix.normalize(path.posix.join(path.posix.dirname(doc.note.path), target))))
        if (!matches && !target.includes('/')) matches = names.get(normalized(target))
      }
      if (!matches?.size) { unresolved++; continue }
      if (matches.size !== 1) { ambiguous++; continue }
      const destination = [...matches][0]
      if (destination === doc.note.id) continue
      const key = `${doc.note.id}:${destination}:${candidate.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      if (links.length >= LINK_LIMIT) { capped = true; continue }
      links.push({ source: doc.note.id, target: destination, kind: candidate.kind })
    }
  }
  for (const doc of documents) doc.note.linkCount = links.filter(link => link.source === doc.note.id || link.target === doc.note.id).length
  return { links, ambiguous, unresolved, capped }
}

async function buildIndex(root: string): Promise<CachedIndex> {
  const documents: Document[] = []; const sources: HQSourceStatus[] = []
  let excluded = 0; let truncated = false; let entries = 0; let bytes = 0
  const checkedAt = new Date().toISOString()
  for (const source of ROOTS) {
    const before = documents.length; const excludedBefore = excluded
    let unavailable = false
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (documents.length >= LIMIT || entries >= ENTRY_LIMIT || bytes >= BYTE_LIMIT || depth > 12) { truncated = true; return }
      const parts = relative.split('/')
      let current = root
      for (const part of ['', ...parts]) {
        if (part) current = path.join(current, part)
        const info = await lstat(current)
        if (!info.isDirectory() || info.isSymbolicLink()) { excluded++; return }
      }
      const children = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'nb'))
      for (const child of children) {
        if (documents.length >= LIMIT || entries >= ENTRY_LIMIT || bytes >= BYTE_LIMIT) { truncated = true; break }
        entries++
        const rel = `${relative}/${child.name}`
        if (child.name.startsWith('.') || EXCLUDED_PATH.test(rel) || child.isSymbolicLink()) { excluded++; continue }
        if (child.isDirectory()) { try { await walk(rel, depth + 1) } catch { excluded++ }; continue }
        if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) { excluded++; continue }
        const read = await readDocument(root, rel)
        if (!read) { excluded++; continue }
        bytes += read.bytes
        if (bytes > BYTE_LIMIT) { truncated = true; break }
        documents.push(toDocument(rel, source.project, read))
      }
    }
    try { await walk(source.path, 0) } catch { unavailable = true }
    sources.push({ id: `vault:${source.path}`, name: source.path, state: unavailable ? 'unavailable' : truncated || excluded > excludedBefore ? 'partial' : 'available', checkedAt,
      count: documents.length - before,
      detail: unavailable ? 'Kildemappen kunne ikke leses.' : `${documents.length - before} notater. ${excluded - excludedBefore} oppdagede filer/mapper utelatt av avgrensning eller lesefeil. Kun tillatte prosjekt- og kunnskapsmapper.`,
    })
  }
  const graph = buildLinks(documents)
  sources.push({ id: 'vault:graph', name: 'Kunnskapsreferanser', state: graph.capped || graph.ambiguous || graph.unresolved ? 'partial' : 'available', checkedAt, count: graph.links.length,
    detail: `${graph.links.length} bekreftede lenker. ${graph.ambiguous} tvetydige og ${graph.unresolved} uløste referanser er utelatt. Maks ${LINK_LIMIT} lenker.`,
  })
  return { root, expires: Date.now() + CACHE_MS, documents, index: { notes: documents.map(doc => doc.note), links: graph.links, sources,
    coverage: { indexed: documents.length, limit: LIMIT, truncated: truncated || graph.capped, excluded },
  } }
}

async function getCached(): Promise<CachedIndex> {
  const root = vaultRoot()
  if (cache?.root === root && cache.expires > Date.now()) return cache
  if (pending?.root === root) return pending.promise
  const startedGeneration = generation
  const promise = buildIndex(root)
  pending = { root, promise }
  try { const result = await promise; if (generation === startedGeneration) cache = result; return result } finally { if (pending?.promise === promise) pending = undefined }
}

export async function getHQKnowledgeIndex(): Promise<Index> { return (await getCached()).index }

export async function getHQNote(id: string): Promise<{ note: HQNote; content: string } | null> {
  if (!/^note-[a-f0-9]{20}$/.test(id)) return null
  const state = await getCached()
  const doc = state.documents.find(value => value.note.id === id)
  if (!doc) return null
  const fresh = await readDocument(state.root, doc.note.path)
  if (!fresh) return null
  const note = toDocument(doc.note.path, doc.note.projectKey, fresh).note
  note.linkCount = doc.note.linkCount
  return { note, content: fresh.content }
}

function queryQMD(query: string): Promise<unknown> {
  const binary = process.env.HQ_QMD_BIN || path.join(os.homedir(), '.bun/bin/qmd')
  return new Promise((resolve, reject) => {
    execFile(binary, ['search', query, '-c', 'vault', '--format', 'json', '-n', '100'],
      { timeout: 3_000, maxBuffer: 512 * 1024, windowsHide: true,
        env: { ...process.env, PATH: [path.join(os.homedir(), '.bun/bin'), '/opt/homebrew/bin', process.env.PATH || '/usr/bin:/bin'].join(path.delimiter) },
      }, (error, stdout) => {
        if (error) { reject(error); return }
        try { resolve(JSON.parse(stdout)) } catch (parseError) { reject(parseError) }
      })
  })
}

export async function searchHQKnowledge(query: string, projectKey?: HQProjectKey): Promise<HQSearchResponse> {
  const cleaned = query.trim().slice(0, 200)
  const state = await getCached()
  // Match the project workspace: its own notes plus shared reference knowledge.
  // The same documents govern local search and the QMD path allowlist below.
  const documents = state.documents.filter(doc => !projectKey || doc.note.projectKey === projectKey || doc.note.projectKey === 'shared')
  if (!cleaned) return { notes: documents.slice(0, 40).map(doc => doc.note), engine: 'local', detail: 'Avgrenset lokal indeks; velg et søkeord for innholdssøk.' }
  const terms = normalized(cleaned).split(/\s+/).filter(Boolean)
  const local = documents.filter(doc => terms.every(term => doc.text.includes(term)))
    .sort((a, b) => Number(normalized(b.note.title).includes(normalized(cleaned))) - Number(normalized(a.note.title).includes(normalized(cleaned))))
  try {
    const result = await queryQMD(cleaned)
    if (!Array.isArray(result)) throw new Error('Invalid QMD result')
    const allowedPaths = new Map<string, HQNote | null>()
    for (const doc of documents) {
      const key = normalized(doc.note.path)
      allowedPaths.set(key, allowedPaths.has(key) ? null : doc.note)
    }
    const found: HQNote[] = []; const seen = new Set<string>()
    for (const row of result) {
      if (!row || typeof row !== 'object') continue
      const raw = String(row.file || row.path || '')
      let relative = raw.startsWith('qmd://vault/') ? raw.slice('qmd://vault/'.length)
        : raw.startsWith(state.root + '/') ? raw.slice(state.root.length + 1) : ''
      try { relative = decodeURIComponent(relative) } catch { continue }
      const note = allowed(relative) ? allowedPaths.get(normalized(relative)) : undefined
      if (note && !seen.has(note.id)) { found.push(note); seen.add(note.id) }
    }
    if (found.length) {
      for (const doc of local) if (!seen.has(doc.note.id)) { found.push(doc.note); seen.add(doc.note.id) }
      return { notes: found.slice(0, 40), engine: 'qmd', detail: 'QMD BM25 (maks 100 kandidater), filtrert mot tillatt prosjektindeks og supplert med lokalt innholdssøk. Ingen QMD-tekst utenfor utvalget vises.' }
    }
    return { notes: local.slice(0, 40).map(doc => doc.note), engine: 'local', detail: 'QMD ga ingen treff i det tillatte prosjektutvalget. Viser lokalt fulltekstsøk i indekserte notater.' }
  } catch {
    return { notes: local.slice(0, 40).map(doc => doc.note), engine: 'local', detail: 'QMD var utilgjengelig eller overskred 3 sekunder. Viser lokalt fulltekstsøk i indekserte notater.' }
  }
}
