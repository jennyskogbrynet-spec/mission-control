// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { getHQKnowledgeIndex, getHQNote, getHQNoteId, invalidateHQKnowledgeCache, searchHQKnowledge } from '../hq-knowledge'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

let root: string
async function note(relative: string, content: string) {
  const full = path.join(root, relative)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
}
function qmdResult(value: unknown) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void
    callback(null, JSON.stringify(value))
    return {} as ReturnType<typeof execFile>
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hq-knowledge-'))
  vi.stubEnv('HQ_VAULT_ROOT', root)
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void
    callback(new Error('QMD timeout'), '')
    return {} as ReturnType<typeof execFile>
  })
})

afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('HQ bounded knowledge adapter', () => {
  it('preserves and retrieves literal technical knowledge instead of treating angle brackets as HTML', async () => {
    const original = '# Teknisk kunnskap\nBruk `<project_id>` og `List<T>`; behold 2 < 3 > 1.\n```html\n<button>Åpne</button>\n```\n~~~ts\nMap<Key, Value>\n~~~\n[Eksempel](https://example.com)\n'
    await note('02-projects/babyhub/teknisk.md', original)
    const index = await getHQKnowledgeIndex()
    const technical = index.notes[0]
    expect((await getHQNote(technical.id))?.content).toBe(original)
    for (const literal of ['<project_id>', 'List<T>', '2 < 3 > 1', '<button>Åpne</button>', 'Map<Key, Value>']) {
      expect(technical.summary).toContain(literal)
      const found = await searchHQKnowledge(literal, 'babyhub')
      expect(found.engine).toBe('local')
      expect(found.notes.map(n => n.id)).toEqual([technical.id])
    }
  })

  it('indexes permitted business sources only, rejects private files, symlinks and traversal', async () => {
    await note('02-projects/babyhub/trygg.md', '# Trygg kunnskap\nDette er et prosjektnotat.')
    await note('01-daily/hidden.md', '# Never expose')
    await note('02-projects/babyhub/private/hidden.md', '# Private')
    await note('02-projects/babyhub/assets/hidden.md', '# Asset')
    await note('02-projects/babyhub/secret.md', '# Secret')
    await note('02-projects/babyhub/innhold.md', '---\nprivacy: private\n---\nSkjermet.')
    await symlink(path.join(root, '01-daily/hidden.md'), path.join(root, '02-projects/babyhub/linked.md'))
    await symlink(path.join(root, '01-daily'), path.join(root, '02-projects/babyhub/linked-dir'))
    const index = await getHQKnowledgeIndex()
    expect(index.notes.map(n => n.title)).toEqual(['Trygg kunnskap'])
    expect(index.coverage.excluded).toBe(6)
    expect(await getHQNote('../01-daily/hidden.md')).toBeNull()
    expect(await getHQNote('note-00000000000000000000')).toBeNull()
    expect(index.sources.find(s => s.id === 'vault:02-projects/babysential')?.state).toBe('unavailable')
  })

  it('preserves Norwegian titles and aliases, distinguishes source date from filesystem modification', async () => {
    await note('03-areas/concepts/øving.md', '---\ntitle: "Ærlig læring – øving"\naliases:\n  - "Kunnskapsfrø"\nsource_date: 2025-02-03\n---\n# Overskrift\nEn **nyttig** [forklaring](https://example.org).\n<script>alert(1)</script>')
    await note('02-projects/babyhub/bruk.md', '# Bruk\n[[Kunnskapsfrø|Les mer]]')
    const first = await getHQKnowledgeIndex()
    const target = first.notes.find(n => n.path.endsWith('øving.md'))!
    expect(target.title).toBe('Ærlig læring – øving')
    expect(target.sourceDate).toBe('2025-02-03T00:00:00.000Z')
    expect(target.modifiedAt).not.toBe(target.sourceDate)
    expect(target.summary).toContain('En nyttig forklaring')
    expect(target.summary).not.toMatch(/script|alert|https:/)
    expect(first.links).toContainEqual({ source: first.notes.find(n => n.title === 'Bruk')!.id, target: target.id, kind: 'wikilink' })
    expect((await getHQKnowledgeIndex()).notes.find(n => n.path === target.path)?.id).toBe(target.id)
    // Raw source is preserved; rendering safety belongs to the ReactMarkdown boundary.
    expect((await getHQNote(target.id))?.content).toContain('<script>alert(1)</script>')
    expect(first.notes.find(n => n.title === 'Bruk')?.sourceDate).toBeNull()
  })

  it('resolves real links while refusing ambiguous names, external URLs and code examples', async () => {
    await note('02-projects/babyhub/a.md', '---\ntitle: Første\naliases: [Felles]\n---\n# Første')
    await note('02-projects/babysential/b.md', '---\ntitle: Andre\naliases: [Felles]\n---\n# Andre')
    await note('02-projects/babyhub/start.md', '# Start\n[[Felles]]\n[[02-projects/babyhub/a#Detalj]]\n[Andre](../babysential/b.md)\n[Utenfor](../../other/file.md)\n[Web](https://example.com/a.md)\n```md\n[[Andre]]\n```')
    const index = await getHQKnowledgeIndex()
    const start = index.notes.find(n => n.title === 'Start')!
    expect(index.links).toHaveLength(2)
    expect(index.links.every(link => link.source === start.id)).toBe(true)
    expect(start.linkCount).toBe(2)
    expect(index.sources.find(s => s.id === 'vault:graph')?.detail).toContain('1 tvetydige og 1 uløste')
  })

  it('searches full note content, beyond summary, and reports QMD failure with strict project filtering', async () => {
    await note('02-projects/babyhub/analyse.md', '# Analyse\n' + 'innledning '.repeat(50) + 'Treffsikker søvnplanlegging er relevant.')
    await note('02-projects/babysential/other.md', '# Other\nTreffsikker søvnplanlegging.')
    const result = await searchHQKnowledge('søvnplanlegging', 'babyhub')
    expect(result.engine).toBe('local')
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0].projectKey).toBe('babyhub')
    expect(result.notes[0].summary).not.toContain('søvnplanlegging')
    expect(result.detail).toContain('3 sekunder')
    expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ timeout: 3000, maxBuffer: 512 * 1024 })
  })

  it.each(['local', 'qmd'] as const)('includes shared knowledge in a selected project using %s search without leaking other projects', async (engine) => {
    await note('03-areas/concepts/kildekritikk.md', '# Kildekritikk\nFelles metode for å vurdere dokumentasjon.')
    await note('02-projects/babyhub/eget.md', '# Eget\nProsjektnotat.')
    await note('02-projects/babysential/kildekritikk.md', '# Kildekritikk for et annet prosjekt\nProsjektspesifikk analyse.')
    if (engine === 'qmd') qmdResult([
      { file: 'qmd://vault/02-projects/babysential/kildekritikk.md' },
      { file: 'qmd://vault/03-areas/concepts/kildekritikk.md' },
    ])
    const visible = (await getHQKnowledgeIndex()).notes.filter(n => n.projectKey === 'babyhub' || n.projectKey === 'shared')
    const shared = visible.find(n => n.title === 'Kildekritikk')!
    expect(shared).toBeDefined()
    const result = await searchHQKnowledge('Kildekritikk', 'babyhub')
    expect(result.engine).toBe(engine)
    expect(result.notes.map(n => n.id)).toEqual([shared.id])
    expect(result.notes.every(n => n.projectKey === 'babyhub' || n.projectKey === 'shared')).toBe(true)
  })

  it('accepts QMD rankings only for indexed project paths, never returned snippets or private sources', async () => {
    await note('02-projects/babyhub/innsikt.md', '# Innsikt\nVekst kommer fra nyttig innhold.')
    await note('02-projects/babysential/other.md', '# Other\nVekst.')
    qmdResult([
      { file: 'qmd://vault/01-daily/private.md', title: 'PRIVATE', snippet: 'DO NOT RETURN' },
      { file: 'qmd://vault/02-projects/babyhub/../../01-daily/private.md' },
      { file: 'qmd://vault/02-projects/babysential/other.md' },
      { file: 'qmd://vault/02-projects/babyhub/innsikt.md', title: 'Untrusted title', snippet: '<script>bad</script>' },
    ])
    const result = await searchHQKnowledge('vekst', 'babyhub')
    expect(result.engine).toBe('qmd')
    expect(result.notes.map(n => n.title)).toEqual(['Innsikt'])
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|DO NOT RETURN|script|Untrusted/)
  })

  it('rechecks paths at note-read time even while its metadata index is cached', async () => {
    await note('02-projects/babyhub/stable.md', '# Stable\nAllowed.')
    await note('01-daily/private.md', '# Private\nNever expose.')
    const id = (await getHQKnowledgeIndex()).notes[0].id
    await rm(path.join(root, '02-projects/babyhub/stable.md'))
    await symlink(path.join(root, '01-daily/private.md'), path.join(root, '02-projects/babyhub/stable.md'))
    expect(await getHQNote(id)).toBeNull()
  })

  it('does not follow a symlinked source root or expose filenames outside its five roots', async () => {
    await note('outside/file.md', '# Outside')
    await mkdir(path.join(root, '02-projects'), { recursive: true })
    await symlink(path.join(root, 'outside'), path.join(root, '02-projects/babyhub'))
    const index = await getHQKnowledgeIndex()
    expect(index.notes).toEqual([])
    expect(index.coverage.excluded).toBe(1)
  })

  it('publishes a newly saved learning after explicit cache invalidation with a stable path identity', async () => {
    const relative = '02-projects/babyhub/decisions/2026-09-08-resultat.md'
    expect((await getHQKnowledgeIndex()).notes).toEqual([])
    await note(relative, '# Resultat\nMålt effekt er dokumentert.')
    expect((await getHQKnowledgeIndex()).notes).toEqual([])
    invalidateHQKnowledgeCache()
    const updated = await getHQKnowledgeIndex()
    expect(updated.notes[0].id).toBe(getHQNoteId(relative))
    expect(updated.notes[0].kind).toBe('decision')
    expect(() => getHQNoteId('01-daily/hidden.md')).toThrow()
  })
})
