// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTokenRecord } from '../token-storage'
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function store() { const folder = await mkdtemp(join(tmpdir(), 'mc-token-test-')); folders.push(folder); return join(folder, 'usage.json') }
describe('workspace token storage', () => {
  it('preserves both legacy primary and other workspace records', async () => {
    const file = await store()
    await writeFile(file, JSON.stringify([{ id: 'legacy' }, { id: 'other', workspaceId: 2 }]))
    await appendTokenRecord(file, { id: 'new', workspaceId: 1 }, 1)
    expect((JSON.parse(await readFile(file, 'utf8')) as Array<{ id: string }>).map(r => r.id)).toEqual(['other', 'new', 'legacy'])
  })
  it('does not lose simultaneous posts', async () => {
    const file = await store()
    await Promise.all(Array.from({ length: 5 }, (_, i) => appendTokenRecord(file, { id: i, workspaceId: i % 2 + 1 }, i % 2 + 1)))
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(5)
  })
  it('does not destroy an unreadable existing store', async () => {
    const file = await store()
    await writeFile(file, 'broken-json')
    await expect(appendTokenRecord(file, { workspaceId: 1 }, 1)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('broken-json')
  })
})
