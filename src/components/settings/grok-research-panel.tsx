'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GrokResearchRun } from '@/lib/grok-research'
import { Button } from '@/components/ui/button'
import { safeExternalUrl } from '@/components/headquarters/hq-data'

export function GrokResearchPanel() {
  const [prompt, setPrompt] = useState('')
  const [runs, setRuns] = useState<GrokResearchRun[]>([])
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [starting, setStarting] = useState(false)
  const requestKey = useRef<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/agent-runtimes/grok/research')
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.runs)) throw new Error('Research status could not refresh. The last confirmed state is shown.')
      setRuns(previous => {
        const ids = new Set(data.runs.map((run: GrokResearchRun) => run.id))
        return [...data.runs, ...previous.filter(run => run.status === 'running' && !ids.has(run.id))]
          .sort((a, b) => b.startedAt - a.startedAt)
      })
      setRefreshError('')
    } catch { setRefreshError('Research status could not refresh. The last confirmed state is shown.') }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const running = runs.some(run => run.status === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(refresh, 2500)
    return () => clearInterval(timer)
  }, [running, refresh])

  const start = async () => {
    setStarting(true)
    setError('')
    requestKey.current ||= crypto.randomUUID()
    try {
      const response = await fetch('/api/agent-runtimes/grok/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, idempotencyKey: requestKey.current }),
      })
      const data = await response.json()
      if (!response.ok) { setError(data.error || 'Research could not start'); return }
      if (!data.run?.id || !data.run?.status) throw new Error('The server returned no run receipt')
      // A saved POST receipt is authoritative even if the subsequent list refresh fails.
      setRuns(previous => [data.run, ...previous.filter(run => run.id !== data.run.id)])
      requestKey.current = null
      setPrompt('')
      await refresh()
    } catch { setError('Connection lost. Retry keeps the same run identifier to avoid duplicates.') }
    finally { setStarting(false) }
  }

  const stop = async (id: string) => {
    try {
      const response = await fetch(`/api/agent-runtimes/grok/research?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) setError((await response.json()).error || 'Could not stop research')
      await refresh()
    } catch { setError('Could not confirm cancellation; refresh the run status.') }
  }

  return <div className="mt-3 border-t border-border/30 pt-3 space-y-2">
    <p className="text-xs text-muted-foreground">Give Grok a small public-web research task. Each run uses only your prompt, up to 6 turns and 3 minutes. Results stay here.</p>
    <textarea aria-label="Grok research task" maxLength={6000} value={prompt}
      onChange={event => { setPrompt(event.target.value); requestKey.current = null }}
      placeholder="Find the official documentation for…" className="w-full min-h-20 rounded border border-border bg-background p-2 text-sm" />
    <Button size="sm" disabled={starting || running || !prompt.trim()} onClick={start}>{starting ? 'Starting…' : running ? 'Research running…' : 'Start research'}</Button>
    {refreshError && <p role="status" className="text-xs text-amber-400">{refreshError} <button type="button" className="underline" onClick={refresh}>Refresh status</button></p>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    <div aria-live="polite" className="space-y-2">
      {runs.slice(0, 5).map(run => <details key={run.id} className="rounded border border-border/30 p-2" open={run.status === 'running'}>
        <summary className="cursor-pointer text-xs">{run.status} · {run.prompt.slice(0, 90)}</summary>
        {run.status === 'running' && <Button size="sm" variant="ghost" onClick={() => stop(run.id)}>Stop research</Button>}
        <p className="text-2xs text-muted-foreground mt-1">{run.model} · {new Date(run.startedAt).toLocaleString()} · {run.costUsd == null ? 'Cost unreported' : `$${run.costUsd.toFixed(4)}`}</p>
        {run.error && <p className="text-xs text-amber-400 mt-2">{run.error}</p>}
        {run.reply && <div className="text-sm leading-relaxed break-words mt-3 max-h-96 overflow-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeExternalUrl} components={{
            h1: ({ children }) => <h1 className="text-lg font-semibold mt-4 mb-2">{children}</h1>,
            h2: ({ children }) => <h2 className="text-base font-semibold mt-4 mb-2">{children}</h2>,
            h3: ({ children }) => <h3 className="font-semibold mt-3 mb-2">{children}</h3>,
            p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
            blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground mb-3">{children}</blockquote>,
            pre: ({ children }) => <pre className="whitespace-pre overflow-x-auto rounded bg-secondary p-3 mb-3 text-xs">{children}</pre>,
            table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-left border-collapse [&_th]:border-b [&_th]:border-border [&_th]:p-2 [&_td]:p-2">{children}</table></div>,
            img: ({ alt }) => <span className="text-muted-foreground">[Image in source{alt ? `: ${alt}` : ''}]</span>,
            a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-primary underline underline-offset-2 hover:opacity-80">{children}</a> : <span>{children}</span>,
          }}>{run.reply}</ReactMarkdown>
        </div>}
      </details>)}
    </div>
  </div>
}
