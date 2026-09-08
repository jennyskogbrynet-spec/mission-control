'use client'
import { useEffect, useState } from 'react'

interface Resource<T> { url: string | null; data: T | null; loading: boolean; error: string | null }
export function useHQResource<T>(url: string | null, refresh = 0, pollMs = 0) {
  const [state, setState] = useState<Resource<T>>({ url, data: null, loading: Boolean(url), error: null })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    let fetching = false
    const load = async () => {
      if (fetching || controller.signal.aborted) return
      fetching = true
      setState(previous => ({ url, data: previous.url === url ? previous.data : null, loading: true, error: null }))
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || `Datakilden svarte med HTTP ${response.status}`)
        if (!controller.signal.aborted) setState({ url, data: body as T, loading: false, error: null })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ url, data: previous.url === url ? previous.data : null, loading: false, error: error instanceof Error ? error.message : 'Datakilden kunne ikke leses' }))
      } finally { fetching = false }
    }
    void load()
    const timer = pollMs ? window.setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, pollMs) : undefined
    return () => { controller.abort(); if (timer) window.clearInterval(timer) }
  }, [url, refresh, pollMs])
  return state.url === url && url ? state : { url, data: null, loading: Boolean(url), error: null }
}
export function useDebouncedValue<T>(value: T, delay = 350) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), delay); return () => window.clearTimeout(timer) }, [value, delay])
  return debounced
}
