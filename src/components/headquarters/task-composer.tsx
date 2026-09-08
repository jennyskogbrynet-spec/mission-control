'use client'
import { useEffect, useRef, useState } from 'react'
import type { HQNote, HQProjectKey, HQTask, HQTaskCreateInput } from '@/lib/hq-types'
import { projectNames } from './hq-data'
import { hqTaskInputSchema } from '@/lib/hq-task-input'
import styles from './headquarters.module.css'

export function TaskComposer({ notes, selectedNote, initialProject, onClose, onCreated, onOpenTask }: { notes: HQNote[]; selectedNote?: HQNote; initialProject: HQProjectKey; onClose: () => void; onCreated: (task: HQTask) => void; onOpenTask: (task: HQTask) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef<AbortController | null>(null)
  const key = useRef(crypto.randomUUID())
  const [title, setTitle] = useState(selectedNote ? `Følg opp: ${selectedNote.title}`.slice(0, hqTaskInputSchema.shape.title.maxLength ?? 200) : '')
  const [description, setDescription] = useState((selectedNote?.summary || '').slice(0, hqTaskInputSchema.shape.description.maxLength ?? 10000))
  const [project, setProject] = useState(initialProject)
  const [sourceIds, setSourceIds] = useState<string[]>(selectedNote ? [selectedNote.id] : [])
  const [criteria, setCriteria] = useState('')
  const [outcome, setOutcome] = useState('')
  const [priority, setPriority] = useState<HQTaskCreateInput['priority']>('medium')
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ task: HQTask; created: boolean } | null>(null)
  const locked = pending || uncertain
  const sourceOptions = [...new Map([...(selectedNote ? [selectedNote] : []), ...notes].map(note => [note.id, note])).values()].filter(note => note.projectKey === project || note.projectKey === 'shared')
  useEffect(() => { dialog.current?.showModal(); return () => request.current?.abort() }, [])
  const edit = (fn: () => void) => { fn(); key.current = crypto.randomUUID(); setError(null) }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending || result) return
    const input: HQTaskCreateInput = { title: title.trim(), description: description.trim(), projectKey: project, sourceIds, acceptanceCriteria: criteria.split('\n').map(line => line.trim()).filter(Boolean), expectedOutcome: outcome.trim(), priority, idempotencyKey: key.current }
    const parsed = hqTaskInputSchema.safeParse(input)
    if (!parsed.success) {
      const messages: Record<string, string> = { title: 'Tittelen må ha 3–200 tegn.', description: 'Beskrivelsen kan ha maksimalt 10 000 tegn.', sourceIds: 'Velg 1–20 kilder som grunnlag for oppgaven.', acceptanceCriteria: 'Skriv 1–10 godkjenningskrav, hvert på 3–500 tegn.', expectedOutcome: 'Forventet resultat må ha 3–2000 tegn.' }
      setError([...new Set(parsed.error.issues.map(issue => messages[String(issue.path[0])] || 'Kontroller oppgaveforslaget før lagring.'))].join(' '))
      return
    }
    setPending(true); setError(null)
    const controller = new AbortController(); request.current = controller
    let definitiveFailure = false
    try {
      const response = await fetch('/api/headquarters/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), signal: controller.signal })
      definitiveFailure = response.status >= 400 && response.status < 500
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `Oppgaven kunne ikke lagres (HTTP ${response.status})`)
      if (!controller.signal.aborted) { setResult(body); setUncertain(false); onCreated(body.task) }
    } catch (caught) {
      if (!controller.signal.aborted) { setUncertain(!definitiveFailure); setError(caught instanceof Error ? caught.message : 'Vi fikk ikke bekreftet lagringen.') }
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  return <dialog ref={dialog} className={styles.dialog} onCancel={event => { if (pending) event.preventDefault(); else onClose() }} aria-labelledby="hq-task-title">
    <div className={styles.dialogHead}><div><span className={styles.overline}>Fra kunnskap til handling</span><h2 id="hq-task-title">{result ? 'Oppgaven er lagret i MC' : 'Et konkret neste steg'}</h2></div><button type="button" className={styles.iconButton} onClick={onClose} disabled={pending} aria-label="Lukk oppgaveforslag">×</button></div>
    {result ? <div className={styles.success}><strong>{result.task.ticketRef || `MC #${result.task.id}`} · {result.task.title}</strong><p>{result.created ? 'Oppgaven er opprettet med kildegrunnlag og godkjenningskrav.' : 'Denne forespørselen var allerede lagret. Ingen ny oppgave ble opprettet.'}</p><button className={styles.button} onClick={() => onOpenTask(result.task)}>Åpne den lagrede oppgaven ↗</button><button className={styles.textButton} onClick={onClose}>Tilbake til hovedkvarteret</button></div> : <form onSubmit={submit}>
      <p className={styles.muted}>Rediger forslaget før du oppretter en ekte oppgave. Kilder og forventet resultat følger med til Mission Control.</p>
      <fieldset disabled={locked} className={styles.fieldset}><label>Tittel<input value={title} onChange={event => edit(() => setTitle(event.target.value))} required minLength={hqTaskInputSchema.shape.title.minLength ?? undefined} maxLength={hqTaskInputSchema.shape.title.maxLength ?? undefined} autoFocus /></label><label>Beskrivelse<textarea value={description} onChange={event => edit(() => setDescription(event.target.value))} rows={3} maxLength={hqTaskInputSchema.shape.description.maxLength ?? undefined} /></label><div className={styles.formGrid}><label>Prosjekt<select value={project} onChange={event => edit(() => { const next = event.target.value as HQProjectKey; setProject(next); setSourceIds(ids => ids.filter(id => { const note = notes.find(note => note.id === id) || selectedNote; return note?.id === id && (note.projectKey === next || note.projectKey === 'shared') })) })}>{(['babyhub', 'babysential', 'brrrr', 'shared'] as const).map(key => <option key={key} value={key}>{projectNames[key]}</option>)}</select></label><label>Prioritet<select value={priority} onChange={event => edit(() => setPriority(event.target.value as HQTaskCreateInput['priority']))}><option value="low">Lav</option><option value="medium">Normal</option><option value="high">Høy</option><option value="urgent">Haster</option></select></label></div><label>Godkjenningskrav <small>1–10 etterprøvbare krav, ett per linje. Hvert krav må ha 3–500 tegn.</small><textarea value={criteria} onChange={event => edit(() => setCriteria(event.target.value))} rows={3} required maxLength={5009} /></label><label>Forventet resultat <small>Hva skal bli bedre, og hvordan kan det vurderes? 3–2000 tegn.</small><textarea value={outcome} onChange={event => edit(() => setOutcome(event.target.value))} rows={2} required minLength={hqTaskInputSchema.shape.expectedOutcome.minLength ?? undefined} maxLength={hqTaskInputSchema.shape.expectedOutcome.maxLength ?? undefined} /></label><div><span className={styles.formLabel}>Kildegrunnlag · {sourceIds.length} valgt · velg 1–20</span><div className={styles.sourcePicker}>{sourceOptions.length ? sourceOptions.map(note => <label key={note.id}><input type="checkbox" checked={sourceIds.includes(note.id)} disabled={sourceIds.length >= 20 && !sourceIds.includes(note.id)} onChange={event => edit(() => setSourceIds(ids => event.target.checked ? [...ids, note.id] : ids.filter(id => id !== note.id)))} /><span>{note.title}<small>{projectNames[note.projectKey]}</small></span></label>) : <p className={styles.muted}>Ingen kilder i dette prosjektutvalget. Velg et annet prosjekt eller åpne forslaget fra en eksisterende kilde. En HQ-oppgave krever minst én kilde.</p>}</div>{sourceOptions.length > 0 && sourceIds.length === 0 && <p className={styles.warning}>Velg minst én kilde før oppgaven kan opprettes.</p>}</div></fieldset>
      {error && <div className={styles.error} role="alert">{error}{uncertain && <p>Vi vet ikke om serveren rakk å lagre. Prøv den samme forespørselen igjen; den samme nøkkelen hindrer en ekstra oppgave. Feltene er låst til lagringen er avklart.</p>}</div>}
      <div className={styles.dialogActions}><button type="button" className={styles.secondaryButton} onClick={onClose} disabled={pending}>Lukk</button><button type="submit" className={styles.button} disabled={pending || sourceIds.length === 0}>{pending ? 'Lagrer i MC …' : uncertain ? 'Bekreft samme forespørsel' : 'Opprett MC-oppgave'}</button></div>
    </form>}
  </dialog>
}
