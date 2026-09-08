'use client'
import { useEffect, useRef, useState } from 'react'
import type { HQTask } from '@/lib/hq-types'
import { hqEvidenceInputSchema } from '@/lib/hq-evidence-input'
import styles from './headquarters.module.css'
export function EvidenceForm({ task, onSaved, onOpenNote }: { task: HQTask; onSaved: () => void; onOpenNote: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [label, setLabel] = useState('')
  const [detail, setDetail] = useState('')
  const [url, setUrl] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submissionError, setSubmissionError] = useState(false)
  const [saved, setSaved] = useState<{ learningNoteId?: string; saveLearning: boolean } | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const save = async (saveLearning: boolean) => {
    if (pending) return
    setSubmissionError(false)
    const parsed = hqEvidenceInputSchema.safeParse({ label, detail, ...(url.trim() ? { url } : {}), saveLearning })
    if (!parsed.success) {
      const messages: Record<string, string> = { label: 'Resultatets tittel må ha 3–160 tegn.', detail: 'Observasjon og bevis må ha 3–6000 tegn.', url: 'Bevislenken kan ha maksimalt 2048 tegn.' }
      setError([...new Set(parsed.error.issues.map(issue => messages[String(issue.path[0])] || 'Kontroller resultatnotatet før lagring.'))].join(' '))
      return
    }
    if (parsed.data.url) {
      try {
        const evidenceUrl = new URL(parsed.data.url)
        if (!['http:', 'https:'].includes(evidenceUrl.protocol) || evidenceUrl.username || evidenceUrl.password) throw new Error()
      } catch { setError('Bevislenken må være en gyldig http- eller https-lenke uten innloggingsinformasjon.'); return }
    }
    setPending(true); setError(null)
    const controller = new AbortController(); request.current = controller
    try {
      const response = await fetch(`/api/headquarters/tasks/${task.id}/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(parsed.data) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `Resultatet kunne ikke lagres (HTTP ${response.status})`)
      if (!controller.signal.aborted) { setSaved({ learningNoteId: body.learningNoteId, saveLearning }); onSaved() }
    } catch (caught) { if (!controller.signal.aborted) { setSubmissionError(true); setError(caught instanceof Error ? caught.message : 'Lagringen ble ikke bekreftet. Oppdater oppgaven før du prøver igjen.') } }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  if (!expanded) return <button type="button" className={styles.secondaryButton} onClick={() => setExpanded(true)}>Registrer resultat eller læring</button>
  return <div className={styles.evidenceForm}><h3>Hva ble resultatet?</h3><p className={styles.muted}>Registrer bevis uten å endre oppgavens ferdigstatus.</p>{saved ? <div className={styles.success}><strong>Resultatet er lagret på oppgaven.</strong>{saved.learningNoteId ? <button className={styles.textButton} onClick={() => onOpenNote(saved.learningNoteId!)}>Åpne læringen i vault ↗</button> : saved.saveLearning ? <p>Serveren returnerte ingen kunnskaps-ID. Kontroller vault før du forsøker å lagre læringen på nytt.</p> : <p>Det er ikke opprettet en ny vault-side.</p>}</div> : <form onSubmit={event => { event.preventDefault(); void save(false) }}><fieldset disabled={pending} className={styles.fieldset}><label>Resultatets tittel<input value={label} onChange={event => setLabel(event.target.value)} required minLength={hqEvidenceInputSchema.shape.label.minLength ?? undefined} maxLength={hqEvidenceInputSchema.shape.label.maxLength ?? undefined} /></label><label>Observasjon og bevis<textarea value={detail} onChange={event => setDetail(event.target.value)} required rows={4} minLength={hqEvidenceInputSchema.shape.detail.minLength ?? undefined} maxLength={hqEvidenceInputSchema.shape.detail.maxLength ?? undefined} /></label><label>Bevislenke <small>Valgfri http-/https-lenke.</small><input type="url" maxLength={hqEvidenceInputSchema.shape.url.unwrap().maxLength ?? undefined} value={url} onChange={event => setUrl(event.target.value)} /></label></fieldset>{error && <div className={styles.error} role="alert">{error}{submissionError && <p>Ved usikkert nettverkssvar: oppdater oppgaven og se etter beviset før du sender på nytt.</p>}</div>}<div className={styles.evidenceActions}><button className={styles.button} disabled={pending || !label.trim() || !detail.trim()} type="submit">{pending ? 'Lagrer …' : 'Registrer resultat'}</button><button className={styles.secondaryButton} disabled={pending || !label.trim() || !detail.trim()} type="button" onClick={() => void save(true)}>Lagre læring i vault</button></div></form>}</div>
}
