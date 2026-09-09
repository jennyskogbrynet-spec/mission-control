import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { mutationLimiter } from '@/lib/rate-limit'
import { cancelSubscriptionRun, getSubscriptionRun, listSubscriptionRuns, reconcileSubscriptionRun, startSubscriptionRun, subscriptionRunSchema, SubscriptionRunError } from '@/lib/subscription-runs'

const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
function guard(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return json({ error: auth.error }, auth.status)
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) return json({ error: 'Local subscription analysis is available in the primary workspace only' }, 403)
  return auth
}
async function body(request: NextRequest) {
  if (Number(request.headers.get('content-length')) > 32_768) throw new SubscriptionRunError('Analysis request is too large', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new SubscriptionRunError('A JSON request is required', 400)
  let size = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > 32_768) { await reader.cancel(); throw new SubscriptionRunError('Analysis request is too large', 413) }
    chunks.push(part.value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new SubscriptionRunError('Invalid JSON request', 400) }
}
const failure = (error: unknown) => json({ error: error instanceof SubscriptionRunError ? error.message : 'Could not process subscription analysis' }, error instanceof SubscriptionRunError ? error.status : 500)

export async function GET(request: NextRequest) {
  const auth = guard(request)
  if (auth instanceof NextResponse) return auth
  try {
    const id = request.nextUrl.searchParams.get('id')
    if (!id) return json({ runs: listSubscriptionRuns(1) })
    const run = getSubscriptionRun(id, 1)
    return run ? json({ run }) : json({ error: 'Run not found' }, 404)
  } catch (error) { return failure(error) }
}
export async function POST(request: NextRequest) {
  const auth = guard(request)
  if (auth instanceof NextResponse) return auth
  const limited = mutationLimiter(request)
  if (limited) return limited
  try {
    const parsed = subscriptionRunSchema.safeParse(await body(request))
    if (!parsed.success) return json({ error: 'Invalid analysis request' }, 400)
    const input = parsed.data
    const db = getDatabase()
    if (!db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(input.projectId, 1)) return json({ error: 'Project not found' }, 404)
    if (input.taskId && !db.prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ? AND workspace_id = ?').get(input.taskId, input.projectId, 1)) return json({ error: 'Task not found in this project' }, 404)
    const run = startSubscriptionRun(input, 1)
    return json({ run }, ['preflight', 'running'].includes(run.status) ? 202 : 200)
  } catch (error) { return failure(error) }
}
export async function DELETE(request: NextRequest) {
  const auth = guard(request)
  if (auth instanceof NextResponse) return auth
  const limited = mutationLimiter(request)
  if (limited) return limited
  return cancelSubscriptionRun(request.nextUrl.searchParams.get('id') || '', 1)
    ? json({ status: 'stopping' }, 202) : json({ error: 'No active child is owned by this process' }, 409)
}
export async function PATCH(request: NextRequest) {
  const auth = guard(request)
  if (auth instanceof NextResponse) return auth
  const limited = mutationLimiter(request)
  if (limited) return limited
  try {
    const parsed = z.object({ action: z.literal('reconcile'), id: z.string().uuid() }).strict().safeParse(await body(request))
    if (!parsed.success) return json({ error: 'Invalid reconciliation request' }, 400)
    return json({ run: reconcileSubscriptionRun(parsed.data.id, 1) })
  } catch (error) { return failure(error) }
}
export const dynamic = 'force-dynamic'
