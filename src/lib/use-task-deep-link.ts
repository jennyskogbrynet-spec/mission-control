'use client'

import { useEffect, useState } from 'react'
import type { Task } from '@/store'

interface DeepLinkOptions {
  taskId: number | null
  scopeKey: string
  loading: boolean
  setSelectedTask: (task: Task | null) => void
}

/** Resolve a detail link independently of the board's current result page. */
export function useTaskDeepLink({ taskId, scopeKey, loading, setSelectedTask }: DeepLinkOptions) {
  const key = `${scopeKey}:${taskId ?? ''}`
  const [resolution, setResolution] = useState<{ key: string; ready: boolean; error: string | null } | null>(null)

  useEffect(() => {
    setSelectedTask(null)
    if (taskId === null || loading) return

    const controller = new AbortController()
    let current = true
    // The authenticated detail endpoint also prevents a stale board-page match
    // from exposing a task after the user's workspace or access has changed.
    setResolution({ key, ready: false, error: null })
    fetch(`/api/tasks/${taskId}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          throw new Error(response.status === 404
            ? `Task #${taskId} not found in current workspace`
            : response.status === 401 || response.status === 403
              ? `Access denied for task #${taskId}` : `Unable to load task #${taskId}`)
        }
        const data = await response.json()
        const task = data?.task as Task | undefined
        if (!task || task.id !== taskId || typeof task.title !== 'string' || typeof task.status !== 'string') {
          throw new Error(`Unable to load task #${taskId}`)
        }
        if (!current || controller.signal.aborted) return
        setSelectedTask(task)
        setResolution({ key, ready: true, error: null })
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return
        setSelectedTask(null)
        setResolution({ key, ready: false, error: error instanceof Error ? error.message : `Unable to load task #${taskId}` })
      })
    return () => { current = false; controller.abort() }
    // Board refreshes must not retry a denied/missing lookup or cancel its request.
  }, [key, loading, taskId, setSelectedTask])

  return {
    ready: taskId !== null && !loading && resolution?.key === key && resolution.ready,
    error: resolution?.key === key ? resolution.error : null,
  }
}
