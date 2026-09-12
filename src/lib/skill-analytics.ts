import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { join } from 'node:path'
import { config } from './config'
import type { SkillAnalyticsSnapshot } from './skill-analytics-types'

const count = z.number().int().nonnegative()
const label = z.string().max(300)
const snapshotSchema = z.object({
  version: z.literal(1),
  workspaceId: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  coverage: z.object({
    status: z.enum(['partial', 'complete', 'unavailable']),
    sources: z.array(label).max(20),
    limitations: z.array(label).max(30),
  }),
  skills: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{16}$/), name: label,
    origins: z.array(label).max(30), status: z.array(label).max(30),
    categories: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), count),
    lastUse: z.string().datetime().nullable(),
    days7: count.nullable(), days30: count.nullable(), days90: count.nullable(), sessions: count.nullable(),
    words: count, bytes: count, flags: z.array(label).max(50), proposal: label,
  })).max(10000),
})

export function parseSkillAnalytics(input: unknown, workspaceId: number): SkillAnalyticsSnapshot | null {
  const parsed = snapshotSchema.safeParse(input)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId) return null
  if (new Set(parsed.data.skills.map(skill => skill.id)).size !== parsed.data.skills.length) return null
  return parsed.data
}

export async function readSkillAnalytics(workspaceId: number): Promise<{ status: 'ready' | 'unavailable'; snapshot: SkillAnalyticsSnapshot | null }> {
  // Private local snapshots require an explicit owner binding; no home-directory discovery.
  if (workspaceId !== 1) return { status: 'unavailable', snapshot: null }
  const path = process.env.MC_SKILL_ANALYTICS_SNAPSHOT || join(config.dataDir, 'skill-analytics.json')
  try {
    if ((await stat(path)).size > 10 * 1024 * 1024) return { status: 'unavailable', snapshot: null }
    const snapshot = parseSkillAnalytics(JSON.parse(await readFile(path, 'utf8')), workspaceId)
    return { status: snapshot ? 'ready' : 'unavailable', snapshot }
  } catch {
    // Missing/invalid snapshots do not expose private paths or parser diagnostics.
    return { status: 'unavailable', snapshot: null }
  }
}
