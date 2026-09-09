import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'

const GATEWAY_TIMEOUT = 10000

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local gateway devices belong to the primary workspace only' }, { status: 403 })
  }
  const action = request.nextUrl.searchParams.get('action') || 'list'
  if (action !== 'list' && action !== 'devices') {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }
  try {
    if (action === 'list') {
      const data = await callOpenClawGateway<{ nodes?: unknown[] }>('node.list', {}, GATEWAY_TIMEOUT)
      if (!Array.isArray(data?.nodes)) throw new Error('Invalid node list')
      return NextResponse.json({ nodes: data.nodes, connected: true })
    }
    const data = await callOpenClawGateway<{ devices?: unknown[]; paired?: unknown[]; pending?: unknown[] }>('device.pair.list', {}, GATEWAY_TIMEOUT)
    const paired = data?.paired ?? data?.devices
    if (!Array.isArray(paired)) throw new Error('Invalid device list')
    return NextResponse.json({ devices: paired, paired, pending: data.pending ?? [], connected: true })
  } catch {
    logger.warn({ action }, 'Gateway node/device list unavailable')
    return NextResponse.json({ connected: false, error: 'Gateway node/device data is unavailable. Retry after checking the gateway connection.' }, { status: 502 })
  }
}

const VALID_DEVICE_ACTIONS = ['approve', 'reject', 'rotate-token', 'revoke-token'] as const
type DeviceAction = (typeof VALID_DEVICE_ACTIONS)[number]

/** Map UI action names to gateway RPC method names and their required param keys. */
const ACTION_RPC_MAP: Record<DeviceAction, { method: string; paramKey: 'requestId' | 'deviceId' }> = {
  'approve':      { method: 'device.pair.approve', paramKey: 'requestId' },
  'reject':       { method: 'device.pair.reject',  paramKey: 'requestId' },
  'rotate-token': { method: 'device.token.rotate',  paramKey: 'deviceId' },
  'revoke-token': { method: 'device.token.revoke',  paramKey: 'deviceId' },
}

/**
 * POST /api/nodes - Device management actions
 * Body: { action: DeviceAction, requestId?: string, deviceId?: string, role?: string, scopes?: string[] }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (auth.user.workspace_id !== 1 || auth.user.tenant_id !== 1) {
    return NextResponse.json({ error: 'Local gateway devices belong to the primary workspace only' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = body.action as string
  if (!action || !VALID_DEVICE_ACTIONS.includes(action as DeviceAction)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${VALID_DEVICE_ACTIONS.join(', ')}` },
      { status: 400 },
    )
  }

  const spec = ACTION_RPC_MAP[action as DeviceAction]

  // Validate required param
  const id = body[spec.paramKey] as string | undefined
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: `Missing required field: ${spec.paramKey}` }, { status: 400 })
  }

  // Build RPC params
  const params: Record<string, unknown> = { [spec.paramKey]: id }
  if ((action === 'rotate-token' || action === 'revoke-token') && body.role) {
    params.role = body.role
  }
  if (action === 'rotate-token' && Array.isArray(body.scopes)) {
    params.scopes = body.scopes
  }

  try {
    const result = await callOpenClawGateway(spec.method, params, GATEWAY_TIMEOUT)
    return NextResponse.json(result)
  } catch (err: unknown) {
    logger.error({ err }, 'Gateway device action failed')
    return NextResponse.json({ error: 'Gateway device action failed' }, { status: 502 })
  }
}
