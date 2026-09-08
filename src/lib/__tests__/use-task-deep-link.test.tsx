import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/store'
import { useTaskDeepLink } from '../use-task-deep-link'

function task(id: number): Task {
  return { id, title: `Task ${id}`, status: 'review', priority: 'high', created_by: 'tester', created_at: 1, updated_at: 2 }
}
function response(value: Task, status = 200): Response {
  return { ok: status === 200, status, json: async () => ({ task: value }) } as Response
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => vi.unstubAllGlobals())

describe('task detail links independent of board pagination', () => {
  it('loads an older task directly and keeps its full store Task payload', async () => {
    const linked = { ...task(17), tags: ['research'], metadata: { evidence: ['source'] }, ticket_ref: 'BABYH-017' }
    const fetcher = vi.fn().mockResolvedValue(response(linked))
    vi.stubGlobal('fetch', fetcher)
    const select = vi.fn()
    const { result, rerender } = renderHook(() => useTaskDeepLink({ taskId: 17, scopeKey: 'user:workspace-1', loading: false, setSelectedTask: select }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(fetcher).toHaveBeenCalledWith('/api/tasks/17', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(select).toHaveBeenLastCalledWith(linked)
    rerender()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('aborts an old ID lookup and ignores its late response after another task opens', async () => {
    const first = deferred<Response>(); const second = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const select = vi.fn()
    const { result, rerender } = renderHook(({ id }) => useTaskDeepLink({ taskId: id, scopeKey: 'workspace-1', loading: false, setSelectedTask: select }), { initialProps: { id: 17 } })
    rerender({ id: 18 })
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(result.current.ready).toBe(false)
    await act(async () => { second.resolve(response(task(18))) })
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { first.resolve(response(task(17))) })
    expect(select).toHaveBeenLastCalledWith(task(18))
    expect(select).not.toHaveBeenCalledWith(task(17))
  })

  it.each([401, 403, 404])('clears selection after HTTP %s and does not retry on unrelated rerenders', async status => {
    const fetcher = vi.fn().mockResolvedValue(response(task(17), status))
    vi.stubGlobal('fetch', fetcher)
    const select = vi.fn()
    const { result, rerender } = renderHook(() => useTaskDeepLink({ taskId: 17, scopeKey: 'workspace-1', loading: false, setSelectedTask: select }))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.ready).toBe(false)
    expect(select).toHaveBeenLastCalledWith(null)
    rerender(); rerender()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalledWith(task(17))
  })

  it('hides an earlier workspace result while revalidating the same ID after a scope change', async () => {
    const second = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(response(task(17))).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const select = vi.fn()
    const { result, rerender } = renderHook(({ scope }) => useTaskDeepLink({ taskId: 17, scopeKey: scope, loading: false, setSelectedTask: select }), { initialProps: { scope: 'workspace-1' } })
    await waitFor(() => expect(result.current.ready).toBe(true))
    rerender({ scope: 'workspace-2' })
    expect(result.current.ready).toBe(false)
    expect(select).toHaveBeenLastCalledWith(null)
    await act(async () => { second.resolve(response(task(17), 403)) })
    expect(result.current.ready).toBe(false)
  })

  it('does not open a mismatched API task and aborts when the URL closes', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetcher)
    const select = vi.fn()
    const { result, rerender } = renderHook(({ id }: { id: number | null }) => useTaskDeepLink({ taskId: id, scopeKey: 'workspace-1', loading: false, setSelectedTask: select }), { initialProps: { id: 17 as number | null } })
    await act(async () => { pending.resolve(response(task(18))) })
    expect(result.current.ready).toBe(false)
    expect(select).not.toHaveBeenCalledWith(task(18))
    rerender({ id: null })
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(result.current.error).toBeNull()
    expect(select).toHaveBeenLastCalledWith(null)
  })
})
