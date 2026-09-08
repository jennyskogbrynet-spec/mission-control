import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HQNote, HQTask } from '@/lib/hq-types'
import { formatDate, graphData, graphWindow, inProject, priorityTasks, safeEvidenceUrl } from './hq-data'
import { useHQResource } from './use-hq-resource'
import { TaskComposer } from './task-composer'
import { EvidenceForm } from './evidence-form'
import { KnowledgeInspector } from './knowledge-inspector'
import { HQMetrics } from './hq-metrics'
import { hqTaskInputSchema } from '@/lib/hq-task-input'
import { hqEvidenceInputSchema } from '@/lib/hq-evidence-input'
import { markdownBody } from './note-presentation'

const note: HQNote = { id: 'source-a', title: 'Kildegrunnlag', path: 'vault/source.md', projectKey: 'babyhub', kind: 'source', summary: 'Et faktisk grunnlag', tags: [], modifiedAt: '2026-09-08T08:00:00Z', sourceDate: null, wordCount: 20, linkCount: 1 }
const task: HQTask = { id: 7, title: 'Et konkret tiltak', description: 'Undersøk kilden', status: 'in_progress', priority: 'high', projectId: 1, projectKey: 'babyhub', assignedTo: 'Ines', ticketRef: 'BH-7', updatedAt: '2026-09-08T09:00:00Z', sourceIds: [note.id], acceptanceCriteria: ['Verifiser resultat'], expectedOutcome: 'Et bedre grunnlag', evidence: [], measurementStatus: 'unmeasured' }
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open') } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('project and evidence relationships', () => {
  it('does not invent a clock time for a date-only source', () => {
    expect(formatDate('2026-09-07')).not.toContain(':')
    expect(formatDate('2026-09-07')).toContain('2026')
  })
  it('keeps shared provenance and excludes other projects', () => {
    expect(inProject({ projectKey: 'shared' }, 'babyhub')).toBe(true)
    expect(inProject({ projectKey: 'babysential' }, 'babyhub')).toBe(false)
    expect(inProject({ projectKey: 'babyhub' }, 'shared')).toBe(false)
  })
  it('ranks actual open work and never reintroduces completed tasks', () => {
    expect(priorityTasks([{ ...task, id: 1, status: 'done', priority: 'urgent' }, { ...task, id: 2, priority: 'low' }, { ...task, id: 3, priority: 'urgent' }]).map(item => item.id)).toEqual([3, 2])
  })
  it('separates original provenance from subsequent learning and drops unresolved edges', () => {
    const learning: HQNote = { ...note, id: 'learning-a', kind: 'learning' }
    const graph = graphData([note, learning], [{ ...task, learningNoteIds: [learning.id] }], [{ source: 'missing', target: note.id, kind: 'wikilink' }])
    expect(graph.links).toEqual([{ source: note.id, target: 'task:7', kind: 'task-source' }, { source: 'task:7', target: learning.id, kind: 'evidence' }])
    expect(graphWindow(graph.items, graph.links, 'task:7', 1).items[0].id).toBe('task:7')
  })
})

describe('request lifecycle', () => {
  it('ignores a stale note response even when its fetch implementation ignores abort', async () => {
    let resolveA!: (value: Response) => void
    let resolveB!: (value: Response) => void
    vi.mocked(fetch).mockImplementation(url => new Promise(resolve => { if (url === '/a') resolveA = resolve; else resolveB = resolve }))
    const { result, rerender } = renderHook(({ url }) => useHQResource<{ title: string }>(url), { initialProps: { url: '/a' } })
    rerender({ url: '/b' })
    await act(async () => { resolveB(json({ title: 'B' })) })
    expect(result.current.data?.title).toBe('B')
    await act(async () => { resolveA(json({ title: 'A' })) })
    expect(result.current.data?.title).toBe('B')
  })
  it('aborts pending work on unmount', () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const { unmount } = renderHook(() => useHQResource('/source'))
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('concrete task creation', () => {
  it('requires a selected source in both the UI and the shared input validator', () => {
    const { container } = render(<TaskComposer notes={[note]} initialProject="babyhub" onClose={vi.fn()} onCreated={vi.fn()} onOpenTask={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Tittel'), { target: { value: 'Et konkret tiltak' } })
    fireEvent.change(screen.getByLabelText(/Godkjenningskrav/), { target: { value: 'Verifiser resultatet' } })
    fireEvent.change(screen.getByLabelText(/Forventet resultat/), { target: { value: 'Et bedre grunnlag' } })
    expect(screen.getByRole('button', { name: 'Opprett MC-oppgave' })).toBeDisabled()
    fireEvent.submit(container.querySelector('form')!)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Velg 1–20 kilder')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Opprett MC-oppgave' })).not.toBeDisabled()
  })
  it('takes native string limits from the same schema as the API and bounds a suggested title', () => {
    render(<TaskComposer notes={[note]} selectedNote={{ ...note, title: 'A'.repeat(250) }} initialProject="babyhub" onClose={vi.fn()} onCreated={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.getByLabelText('Tittel')).toHaveAttribute('maxlength', String(hqTaskInputSchema.shape.title.maxLength))
    expect((screen.getByLabelText('Tittel') as HTMLInputElement).value).toHaveLength(200)
    expect(screen.getByLabelText('Beskrivelse')).toHaveAttribute('maxlength', '10000')
    expect(screen.getByLabelText(/Forventet resultat/)).toHaveAttribute('minlength', '3')
    expect(screen.getByLabelText(/Forventet resultat/)).toHaveAttribute('maxlength', '2000')
  })
  it.each([
    ['Tittel', 'A'.repeat(201)],
    ['Beskrivelse', 'A'.repeat(10001)],
    [/Godkjenningskrav/, 'A'.repeat(501)],
    [/Godkjenningskrav/, Array(11).fill('Gyldig enkeltkrav').join('\n')],
    [/Godkjenningskrav/, 'ab'],
    [/Forventet resultat/, 'A'.repeat(2001)],
    [/Forventet resultat/, 'ab'],
  ])('does not POST an out-of-contract %s even if native browser validation is bypassed', (label, invalid) => {
    const { container } = render(<TaskComposer notes={[note]} selectedNote={note} initialProject="babyhub" onClose={vi.fn()} onCreated={vi.fn()} onOpenTask={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Godkjenningskrav/), { target: { value: 'Et etterprøvbart krav' } })
    fireEvent.change(screen.getByLabelText(/Forventet resultat/), { target: { value: 'Et bedre grunnlag' } })
    fireEvent.change(screen.getByLabelText(label), { target: { value: invalid } })
    fireEvent.submit(container.querySelector('form')!)
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('retains the exact idempotency key and payload after an uncertain network failure', async () => {
    const onCreated = vi.fn()
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Nettverket ble brutt')).mockResolvedValueOnce(json({ task, created: true }))
    render(<TaskComposer notes={[note]} selectedNote={note} initialProject="babyhub" onClose={vi.fn()} onCreated={onCreated} onOpenTask={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Godkjenningskrav/), { target: { value: 'Test at målingen blir registrert' } })
    fireEvent.change(screen.getByLabelText(/Forventet resultat/), { target: { value: 'Et etterprøvbart grunnlag' } })
    fireEvent.click(screen.getByRole('button', { name: 'Opprett MC-oppgave' }))
    await screen.findByRole('button', { name: 'Bekreft samme forespørsel' })
    expect(screen.getByLabelText('Tittel')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft samme forespørsel' }))
    await screen.findByText('Oppgaven er lagret i MC')
    const bodies = vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]?.body)))
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[0].sourceIds).toEqual([note.id])
    expect(bodies[0].acceptanceCriteria).toEqual(['Test at målingen blir registrert'])
    expect(bodies[0].idempotencyKey).toBeTruthy()
    expect(hqTaskInputSchema.safeParse(bodies[0]).success).toBe(true)
    expect(onCreated).toHaveBeenCalledWith(task)
  })
})

describe('source and outcome integrity', () => {
  it('hides only opening metadata from presentation and preserves the original body including code and later rules', () => {
    const body = '# Faktisk innhold\n\n`List<T>` og `2 < 3 > 1`\n\n---\ncreated: dette er innhold\n---\n'
    const original = '---\ncreated: 2026-09-08\ntags:\n  - deep-learn\n  - ai\n---\n' + body
    expect(markdownBody(original)).toBe(body)
    expect(original).toContain('tags:')
    for (const ordinary of ['---\nVanlig innledning\n---\nResten', '---\ncreated: "uavsluttet\n---\nResten', '---\ntags: [uavsluttet\n---\nResten', '```yaml\n---\ncreated: 2026\n---\n```']) expect(markdownBody(ordinary)).toBe(ordinary)
  })

  it('allows only the established run-provenance path or HTTP(S) evidence URLs', () => {
    expect(safeEvidenceUrl('/api/v1/runs/run_123-abc/provenance')).toBe('/api/v1/runs/run_123-abc/provenance')
    expect(safeEvidenceUrl('https://example.com/proof')).toBe('https://example.com/proof')
    for (const value of ['/api/memory?path=secret', '/api/v1/runs/../provenance', '/api/v1/runs/run-1/provenance?download=true', '//evil.example/x', 'javascript:alert(1)']) expect(safeEvidenceUrl(value)).toBeUndefined()
  })
  it('renders a persisted relative run-provenance link as an actionable proof link', () => {
    const withProof = { ...task, evidence: [{ label: 'Kjørt verifikasjon', url: '/api/v1/runs/run_123-abc/provenance' }] }
    render(<KnowledgeInspector selected="task:7" item={{ id: 'task:7', title: task.title, projectKey: task.projectKey, kind: 'task', task: withProof }} items={[]} links={[]} refresh={0} onSelect={vi.fn()} onCreate={vi.fn()} onOpenTask={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Åpne bevis ↗' })).toHaveAttribute('href', '/api/v1/runs/run_123-abc/provenance')
  })

  it('preserves prompt/code text while preventing markdown image loads and raw HTML execution', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ note, content: '`List<T>` and `2 < 3 > 1`\n\n![remote](https://example.com/private-pixel.png)\n\n<script>alert(1)</script>' }))
    const { container } = render(<KnowledgeInspector selected={note.id} item={{ id: note.id, title: note.title, projectKey: note.projectKey, kind: note.kind, note }} items={[]} links={[]} refresh={0} onSelect={vi.fn()} onCreate={vi.fn()} onOpenTask={vi.fn()} onRefresh={vi.fn()} />)
    await screen.findByText('List<T>')
    expect(screen.getByText('2 < 3 > 1')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })
  it('marks a retained live metric as unconfirmed after refresh failure without changing its value or timestamp', () => {
    const original = { generatedAt: '2026-09-08T08:00:00Z', sources: [], metrics: [{ id: 'retained', projectKey: 'babyhub' as const, name: 'Registrerte handlinger', provider: 'Produktdata', value: 120, unit: 'handlinger', status: 'live' as const, checkedAt: '2026-09-08T08:00:00Z', period: 'Siste døgn', definition: 'Antall registrerte hendelser' }] }
    const { rerender } = render(<HQMetrics loading={false} error={null} data={original} />)
    expect(screen.getByText('Oppdatert kilde')).toBeInTheDocument()
    const checkedAt = screen.getByText(/^Kontrollert /).textContent
    rerender(<HQMetrics loading={false} error="Nettverket er utilgjengelig" data={original} />)
    expect(screen.queryByText('Oppdatert kilde')).not.toBeInTheDocument()
    expect(screen.getByText(/Lagret måling · oppdatering ubekreftet/)).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByText(/^Kontrollert /).textContent).toBe(checkedAt)
    expect(original.metrics[0].status).toBe('live')
    rerender(<HQMetrics loading={true} error={null} data={original} />)
    expect(screen.queryByText('Oppdatert kilde')).not.toBeInTheDocument()
    expect(screen.getByText(/Lagret måling · oppdaterer/)).toBeInTheDocument()
  })
  it('shows a real zero as zero and a missing measurement as unmeasured', () => {
    render(<HQMetrics loading={false} error={null} data={{ generatedAt: '2026-09-08T08:00:00Z', sources: [], metrics: [{ id: 'zero', projectKey: 'babyhub', name: 'Registrerte handlinger', provider: 'Testprovider', value: 0, unit: 'handlinger', status: 'live', checkedAt: '2026-09-08T08:00:00Z', period: 'Siste døgn', definition: 'Antall registrerte hendelser' }, { id: 'absent', projectKey: 'babyhub', name: 'Aktivering', provider: 'Testprovider', value: null, unit: '%', status: 'unavailable', checkedAt: '2026-09-08T08:00:00Z', period: '', definition: 'Ingen baseline' }] }} />)
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('Ikke målt')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })
  it('uses the API evidence limits on native inputs', () => {
    render(<EvidenceForm task={task} onSaved={vi.fn()} onOpenNote={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Registrer resultat eller læring' }))
    expect(screen.getByLabelText('Resultatets tittel')).toHaveAttribute('minlength', '3')
    expect(screen.getByLabelText('Resultatets tittel')).toHaveAttribute('maxlength', '160')
    expect(screen.getByLabelText('Observasjon og bevis')).toHaveAttribute('minlength', '3')
    expect(screen.getByLabelText('Observasjon og bevis')).toHaveAttribute('maxlength', '6000')
    expect(screen.getByLabelText(/Bevislenke/)).toHaveAttribute('maxlength', '2048')
  })
  it.each(['result', 'learning'])('validates every evidence boundary before the %s action can POST', action => {
    const { container } = render(<EvidenceForm task={task} onSaved={vi.fn()} onOpenNote={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Registrer resultat eller læring' }))
    const fields = { label: screen.getByLabelText('Resultatets tittel'), detail: screen.getByLabelText('Observasjon og bevis'), url: screen.getByLabelText(/Bevislenke/) }
    const cases: Array<[keyof typeof fields, string]> = [
      ['label', '  ab  '], ['label', 'A'.repeat(161)], ['detail', 'ab'], ['detail', 'A'.repeat(6001)],
      ['url', 'https://example.com/' + 'x'.repeat(2048)], ['url', 'javascript:alert(1)'], ['url', 'ftp://example.com/file'], ['url', 'https://user:secret@example.com/proof'],
    ]
    for (const [field, invalid] of cases) {
      fireEvent.change(fields.label, { target: { value: 'Verifisert resultat' } })
      fireEvent.change(fields.detail, { target: { value: 'Resultatet ble observert i en kontrollert test.' } })
      fireEvent.change(fields.url, { target: { value: '' } })
      fireEvent.change(fields[field], { target: { value: invalid } })
      if (action === 'result') fireEvent.submit(container.querySelector('form')!)
      else fireEvent.click(screen.getByRole('button', { name: 'Lagre læring i vault' }))
      expect(fetch, `${action} must reject ${field}`).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toBeInTheDocument()
    }
  })
  it('submits a valid evidence payload at the maximum string boundaries', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ task, learningNoteId: 'learning-max' }))
    render(<EvidenceForm task={task} onSaved={vi.fn()} onOpenNote={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Registrer resultat eller læring' }))
    fireEvent.change(screen.getByLabelText('Resultatets tittel'), { target: { value: 'A'.repeat(160) } })
    fireEvent.change(screen.getByLabelText('Observasjon og bevis'), { target: { value: 'B'.repeat(6000) } })
    const url = 'https://example.com/' + 'x'.repeat(2048 - 'https://example.com/'.length)
    fireEvent.change(screen.getByLabelText(/Bevislenke/), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: 'Lagre læring i vault' }))
    await screen.findByText('Resultatet er lagret på oppgaven.')
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(hqEvidenceInputSchema.safeParse(body).success).toBe(true)
    expect(body.label).toHaveLength(160)
    expect(body.detail).toHaveLength(6000)
    expect(body.url).toHaveLength(2048)
    expect(body.saveLearning).toBe(true)
  })
  it('persists evidence and opens the returned learning without marking the task done', async () => {
    const onOpenNote = vi.fn(), onSaved = vi.fn()
    vi.mocked(fetch).mockResolvedValue(json({ task, learningNoteId: 'learning-new' }))
    render(<EvidenceForm task={task} onSaved={onSaved} onOpenNote={onOpenNote} />)
    fireEvent.click(screen.getByRole('button', { name: 'Registrer resultat eller læring' }))
    fireEvent.change(screen.getByLabelText('Resultatets tittel'), { target: { value: 'Verifisert hendelse' } })
    fireEvent.change(screen.getByLabelText('Observasjon og bevis'), { target: { value: 'Hendelsen ble observert i en kontrollert test.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lagre læring i vault' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledWith('/api/headquarters/tasks/7/evidence', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.saveLearning).toBe(true)
    expect(hqEvidenceInputSchema.safeParse(body).success).toBe(true)
    expect(body).not.toHaveProperty('status')
    fireEvent.click(screen.getByRole('button', { name: /Åpne læringen i vault/ }))
    expect(onOpenNote).toHaveBeenCalledWith('learning-new')
  })
})
