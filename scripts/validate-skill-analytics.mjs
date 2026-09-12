import { readFileSync } from 'node:fs'
import { z } from 'zod'

try {
  const text = readFileSync(0, 'utf8')
  if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Invalid')
  const schema = JSON.parse(readFileSync(new URL('../src/lib/skill-analytics-schema.json', import.meta.url), 'utf8'))
  const result = z.fromJSONSchema(schema).safeParse(JSON.parse(text))
  if (!result.success || new Set(result.data.skills.map(row => row.id)).size !== result.data.skills.length) throw new Error('Invalid')
  process.stdout.write(JSON.stringify(result.data))
} catch {
  process.stderr.write('Invalid skill analytics snapshot\n')
  process.exitCode = 1
}
