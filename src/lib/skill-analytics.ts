import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { join } from 'node:path'
import { config } from './config'
import type { SkillAnalyticsSnapshot } from './skill-analytics-types'

import publicSchema from './skill-analytics-schema.json'

const snapshotSchema = z.fromJSONSchema(publicSchema as Parameters<typeof z.fromJSONSchema>[0])

export function parseSkillAnalytics(input: unknown, workspaceId: number): SkillAnalyticsSnapshot | null {
  const parsed = snapshotSchema.safeParse(input)
  const data = parsed.success ? parsed.data as SkillAnalyticsSnapshot : null
  if (!data || data.workspaceId !== workspaceId) return null
  if (new Set(data.skills.map(skill => skill.id)).size !== data.skills.length) return null
  return data
}

export async function readSkillAnalytics(workspaceId: number): Promise<{ status: 'ready' | 'unavailable' | 'invalid' | 'error'; snapshot: SkillAnalyticsSnapshot | null }> {
  // Private local snapshots require an explicit owner binding; no home-directory discovery.
  if (workspaceId !== 1) return { status: 'unavailable', snapshot: null }
  const path = process.env.MC_SKILL_ANALYTICS_SNAPSHOT || join(config.dataDir, 'skill-analytics.json')
  try {
    if ((await stat(path)).size > 10 * 1024 * 1024) return { status: 'invalid', snapshot: null }
    const text = await readFile(path, 'utf8')
    let input: unknown
    try { input = JSON.parse(text) } catch { return { status: 'invalid', snapshot: null } }
    const snapshot = parseSkillAnalytics(input, workspaceId)
    return { status: snapshot ? 'ready' : 'invalid', snapshot }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { status: missing ? 'unavailable' : 'error', snapshot: null }
  }
}
