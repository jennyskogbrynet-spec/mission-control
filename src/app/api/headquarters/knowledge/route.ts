import { NextRequest, NextResponse } from 'next/server'
import { requireHQAccess } from '@/lib/hq-access'
import { getHQKnowledgeIndex, getHQNote, searchHQKnowledge } from '@/lib/hq-knowledge'
import type { HQProjectKey } from '@/lib/hq-types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const access = requireHQAccess(request)
  if (access instanceof NextResponse) return access
  const params = request.nextUrl.searchParams
  const id = params.get('id')
  const project = params.get('project')
  if (project && !['babyhub', 'babysential', 'brrrr', 'shared'].includes(project)) {
    return NextResponse.json({ error: 'Ugyldig prosjekt.' }, { status: 400 })
  }
  try {
    if (id !== null) {
      const result = await getHQNote(id)
      return result ? NextResponse.json(result) : NextResponse.json({ error: 'Notatet finnes ikke i det tillatte utvalget.' }, { status: 404 })
    }
    const query = params.get('q')
    if (query !== null) {
      if (query.length > 200) return NextResponse.json({ error: 'Søket kan ha maks 200 tegn.' }, { status: 400 })
      return NextResponse.json(await searchHQKnowledge(query, (project || undefined) as HQProjectKey | undefined))
    }
    return NextResponse.json(await getHQKnowledgeIndex())
  } catch {
    return NextResponse.json({ error: 'Kunnskapskildene kunne ikke leses.' }, { status: 503 })
  }
}
