import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentWake } from '@/lib/use-agent-wake'
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response
beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('agent check-in request ownership', () => {
  it('suppresses synchronous double clicks and shares the pending state across wake buttons', async () => {
    let resolve!: (result: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done }))
    const accepted = vi.fn(), error = vi.fn()
    const { result } = renderHook(() => useAgentWake(accepted, error))
    let first!: Promise<void>
    act(() => { first = result.current.wakeAgent('Ines', 'agent:main:mc'); void result.current.wakeAgent('Ines', 'agent:main:mc') })
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.current.wakingAgents.has('Ines')).toBe(true)
    await act(async () => { resolve(response({ status: 'accepted' })); await first })
    expect(result.current.wakingAgents.has('Ines')).toBe(false)
    expect(accepted).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })
  it.each(['transport', 'unknown-receipt'])('retains the same key and message after %s, then rotates only after acceptance', async failure => {
    const accepted = vi.fn(), error = vi.fn()
    if (failure === 'transport') vi.mocked(fetch).mockRejectedValueOnce(new Error('connection lost'))
    else vi.mocked(fetch).mockResolvedValueOnce(response({ success: true, status: 'unrecognized' }))
    vi.mocked(fetch).mockResolvedValue(response({ status: 'accepted' }))
    const { result } = renderHook(() => useAgentWake(accepted, error))
    await act(async () => { await result.current.wakeAgent('Ines', 'agent:main:mc') })
    expect(accepted).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledOnce()
    await act(async () => { await result.current.wakeAgent('Ines', 'agent:main:mc') })
    const first = vi.mocked(fetch).mock.calls[0][1]!, retry = vi.mocked(fetch).mock.calls[1][1]!
    expect(retry.body).toBe(first.body)
    expect(retry.headers).toEqual(first.headers)
    expect(accepted).toHaveBeenCalledOnce()
    await act(async () => { await result.current.wakeAgent('Ines', 'agent:main:mc') })
    expect(vi.mocked(fetch).mock.calls[2][1]!.headers).not.toEqual(first.headers)
  })
})
