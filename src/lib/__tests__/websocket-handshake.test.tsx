import { act, renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const identity = vi.hoisted(() => ({
  getOrCreateDeviceIdentity: vi.fn().mockResolvedValue({ deviceId: 'fixture-device', publicKeyBase64: 'fixture-public-key', privateKey: {} }),
  signPayload: vi.fn().mockResolvedValue({ signature: 'fixture-signature' }),
  getCachedDeviceToken: vi.fn().mockReturnValue(null),
  cacheDeviceToken: vi.fn(), clearDeviceIdentity: vi.fn(),
}))
vi.mock('@/lib/device-identity', () => identity)
vi.mock('@/lib/client-logger', () => ({ createClientLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  send = vi.fn()
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  close() { this.readyState = FakeWebSocket.CLOSED }
}

let useWebSocket: typeof import('../websocket')['useWebSocket']
beforeAll(async () => {
  // Reproduce the locally configured legacy value before the client module loads.
  vi.stubEnv('NEXT_PUBLIC_GATEWAY_CLIENT_ID', 'control-ui')
  useWebSocket = (await import('../websocket')).useWebSocket
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); identity.getCachedDeviceToken.mockReturnValue(null) })
afterAll(() => vi.unstubAllEnvs())

async function handshake() {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const hook = renderHook(() => useWebSocket())
  act(() => hook.result.current.connect('ws://localhost:18789', 'fixture-shared-token'))
  const socket = FakeWebSocket.instances.at(-1)!
  await act(async () => { socket.onmessage?.({ data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-nonce' } }) }) })
  await waitFor(() => expect(socket.send).toHaveBeenCalled())
  const frame = JSON.parse(socket.send.mock.calls[0][0])
  act(() => hook.result.current.disconnect())
  hook.unmount()
  return frame
}

describe('OpenClaw connect protocol compatibility', () => {
  it('offers current protocol v4 required by operator and UI clients', async () => {
    const frame = await handshake()
    // OpenClaw gateway/protocol.md: current operator/UI ranges must include 4;
    // the installed handler rejects a v3-only operator client before auth.
    expect(frame.params.minProtocol).toBe(4)
    expect(frame.params.maxProtocol).toBe(4)
    expect(frame.params.role).toBe('operator')
  })

  it('uses the accepted browser identity in both the wire frame and device signature for legacy control-ui configuration', async () => {
    const frame = await handshake()
    // Primary contract: installed OpenClaw client-info defines openclaw-control-ui;
    // its ConnectParams schema uses this closed client-ID enum, not display names.
    expect(frame.params.client.id).toBe('openclaw-control-ui')
    const signed = identity.signPayload.mock.calls[0][1] as string
    expect(signed.split('|')[2]).toBe(frame.params.client.id)
    expect(frame.params.client.displayName).toBe('Mission Control')
    expect(frame.params.auth.token).toBe('fixture-shared-token')
  })

  it('places a cached device token inside auth, as required by the closed ConnectParams schema', async () => {
    identity.getCachedDeviceToken.mockReturnValue('fixture-device-token')
    const frame = await handshake()
    expect(frame.params).not.toHaveProperty('deviceToken')
    expect(frame.params.auth).toEqual({ token: 'fixture-shared-token', deviceToken: 'fixture-device-token' })
    expect(frame.params.device.signature).toBe('fixture-signature')
  })
})
