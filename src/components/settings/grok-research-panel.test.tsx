import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrokResearchPanel } from './grok-research-panel'
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('Grok research receipts', () => {
  it('renders structured reports with safe clickable source links', async () => {
    const run = { id: 'report', status: 'completed', prompt: 'Public research', startedAt: Date.now(), model: 'grok-4.6', costUsd: null,
      reply: '## Findings\n\nA **verified result** with [official docs](https://example.com/docs).\n\nA second paragraph.\n\n- First finding\n- Second finding\n\nSources: http://example.org/reference' }
    vi.mocked(fetch).mockResolvedValue(json({ runs: [run] }))
    const { container } = render(<GrokResearchPanel />)
    fireEvent.click(await screen.findByText('completed · Public research'))
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('verified result')
    expect(screen.getByText('A second paragraph.').tagName).toBe('P')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    const links = screen.getAllByRole('link')
    expect(links.map(link => link.getAttribute('href'))).toEqual(['https://example.com/docs', 'http://example.org/reference'])
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link).toHaveAttribute('referrerPolicy', 'no-referrer')
    }
  })
  it('disables raw HTML, remote images and links outside HTTP(S), preserving code literals', async () => {
    const run = { id: 'unsafe-report', status: 'completed', prompt: 'Safety fixture', startedAt: Date.now(), model: 'grok-4.6', costUsd: null,
      reply: '[script](javascript:alert%281%29) [data](data:text/html,hello) [email](mailto:user@example.com) [file](file:///private/test) [relative](/api/private) [protocol-relative](//example.com)\n\n<script>alert("never")</script>\n\n<img src="https://example.com/raw-image" onerror="alert(1)">\n\n![Source figure](https://example.com/image.png)\n\n`<example>`\n\n```html\n<script>this is a code example</script>\n```' }
    vi.mocked(fetch).mockResolvedValue(json({ runs: [run] }))
    const { container } = render(<GrokResearchPanel />)
    fireEvent.click(await screen.findByText('completed · Safety fixture'))
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(container.querySelector('script, img, iframe')).toBeNull()
    expect(screen.getByText('[Image in source: Source figure]')).toBeInTheDocument()
    expect(screen.getByText('<example>').tagName).toBe('CODE')
    expect(container.querySelector('pre code')).toHaveTextContent('<script>this is a code example</script>')
  })
  it('keeps the accepted run cancellable and polls after a failed list refresh', async () => {
    const run = { id: 'run-one', status: 'running', prompt: 'Find public docs', startedAt: Date.now(), model: 'grok-4.6', costUsd: null }
    let reads = 0
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') return json({ run }, 202)
      reads++
      if (reads === 1) return json({ runs: [] })
      if (reads === 2) throw new Error('GET disconnected')
      return json({ runs: [{ ...run, status: 'completed', reply: 'Official result' }] })
    })
    render(<GrokResearchPanel />)
    await waitFor(() => expect(reads).toBe(1))
    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText('Grok research task'), { target: { value: run.prompt } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start research' })) })
    expect(screen.getByRole('button', { name: 'Stop research' })).toBeInTheDocument()
    expect(screen.getByText(/Research status could not refresh/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Research running…' })).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(reads).toBe(3)
    expect(screen.getByText('Official result')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop research' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  })
})
