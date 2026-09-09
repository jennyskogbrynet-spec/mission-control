import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

interface StoredUsage { workspaceId?: number; [key: string]: unknown }
let pendingWrite: Promise<void> = Promise.resolve()

/** Serialize updates in the MC process and replace atomically; keep other workspaces intact. */
export function appendTokenRecord(filePath: string, record: StoredUsage, workspaceId: number): Promise<void> {
  const operation = pendingWrite.then(async () => {
    let records: StoredUsage[] = []
    try {
      const data: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid token usage store')
      records = data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const belongsHere = (entry: StoredUsage) => Number(entry.workspaceId ?? 1) === workspaceId
    const retained = records.filter(entry => !belongsHere(entry))
    const ownRecords = [record, ...records.filter(belongsHere)].slice(0, 10000)
    await mkdir(dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify([...retained, ...ownRecords], null, 2), { mode: 0o600 })
    await rename(temporaryPath, filePath)
  })
  pendingWrite = operation.catch(() => undefined)
  return operation
}
