import { NextRequest, NextResponse } from 'next/server'
import { hqTaskInputSchema } from '@/lib/hq-task-input'
import { requireHQAccess } from '@/lib/hq-access'
import { getHQKnowledgeIndex } from '@/lib/hq-knowledge'
import { createHQTask, HQInputError } from '@/lib/hq-operations'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'



export async function POST(request:NextRequest) {
  const access=requireHQAccess(request,'operator')
  if(access instanceof NextResponse) return access
  const limited=mutationLimiter(request)
  if(limited) return limited
  try {
    const raw=await request.text()
    if(raw.length>25000) return NextResponse.json({error:'Forslaget er for stort.'},{status:413})
    let json:unknown
    try {json=JSON.parse(raw)} catch {return NextResponse.json({error:'Ugyldig JSON.'},{status:400})}
    const parsed=hqTaskInputSchema.safeParse(json)
    if(!parsed.success) return NextResponse.json({error:'Fyll ut tittel, kilder, ønsket resultat og minst ett akseptansekriterium.'},{status:400})
    const {notes}=await getHQKnowledgeIndex()
    const result=createHQTask(parsed.data,access.workspaceId,access.user.display_name||access.user.username,notes)
    return NextResponse.json(result,{status:result.created?201:200,headers:{'Cache-Control':'no-store'}})
  }catch(error){
    if(error instanceof HQInputError)return NextResponse.json({error:error.message},{status:error.status})
    logger.error({err:error},'HQ task creation failed')
    return NextResponse.json({error:'Oppgaven kunne ikke lagres. Det er trygt å prøve samme forespørsel igjen.'},{status:500})
  }
}
