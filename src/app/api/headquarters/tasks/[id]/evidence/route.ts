import { NextRequest, NextResponse } from 'next/server'
import { hqEvidenceInputSchema } from '@/lib/hq-evidence-input'
import { requireHQAccess } from '@/lib/hq-access'
import { recordHQEvidence } from '@/lib/hq-evidence'
import { HQInputError } from '@/lib/hq-operations'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}) {
  const access=requireHQAccess(request,'operator')
  if(access instanceof NextResponse)return access
  const limited=mutationLimiter(request)
  if(limited)return limited
  const {id}=await context.params
  const taskId=Number(id)
  if(!Number.isSafeInteger(taskId)||taskId<=0)return NextResponse.json({error:'Ugyldig oppgave.'},{status:400})
  try{
    const raw=await request.text()
    if(raw.length>15000)return NextResponse.json({error:'Resultatnotatet er for stort.'},{status:413})
    let json:unknown
    try{json=JSON.parse(raw)}catch{return NextResponse.json({error:'Ugyldig JSON.'},{status:400})}
    const input=hqEvidenceInputSchema.safeParse(json)
    if(!input.success)return NextResponse.json({error:'Fyll ut navn og beskrivelse av resultatet.'},{status:400})
    const result=await recordHQEvidence(taskId,access.workspaceId,access.user.display_name||access.user.username,input.data)
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
  }catch(error){
    if(error instanceof HQInputError)return NextResponse.json({error:error.message},{status:error.status})
    logger.error({err:error},'HQ evidence recording failed')
    return NextResponse.json({error:'Resultatet kunne ikke fullføres. Eksisterende bevis og notater er bevart; prøv igjen.'},{status:500})
  }
}
