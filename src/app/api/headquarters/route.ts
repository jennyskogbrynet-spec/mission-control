import { NextRequest, NextResponse } from 'next/server'
import { requireHQAccess } from '@/lib/hq-access'
import { getHQKnowledgeIndex } from '@/lib/hq-knowledge'
import { readHQOperations } from '@/lib/hq-operations'
import { logger } from '@/lib/logger'
import type { HQSnapshot } from '@/lib/hq-types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const access = requireHQAccess(request)
  if (access instanceof NextResponse) return access
  try {
    const knowledge = await getHQKnowledgeIndex()
    const operations = readHQOperations(access.workspaceId, knowledge.notes)
    const generatedAt = new Date().toISOString()
    const snapshot: HQSnapshot = {
      ...knowledge, ...operations, generatedAt,
      sources: [...knowledge.sources, { id:'mission-control',name:'Mission Control',state:'available',checkedAt:generatedAt,count:operations.tasks.length,detail:'Oppgaver, registrerte agenter og aktivitet fra dette arbeidsområdet. Inntil 200 prioriterte oppgaver.' }],
    }
    return NextResponse.json(snapshot,{headers:{'Cache-Control':'private, no-store'}})
  } catch(error) {
    logger.error({err:error},'HQ snapshot failed')
    return NextResponse.json({error:'Hovedkvarteret kunne ikke hente data. Prøv igjen.'},{status:500})
  }
}
