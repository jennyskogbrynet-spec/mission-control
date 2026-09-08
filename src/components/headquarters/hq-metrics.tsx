'use client'
import { useId } from 'react'
import type { HQMetric, HQMetricsResponse } from '@/lib/hq-types'
import { formatDate, projectNames, safeExternalUrl } from './hq-data'
import styles from './headquarters.module.css'
function Sparkline({ metric }: { metric: HQMetric }) {
  const titleId = useId()
  const points = (metric.series || []).filter(point => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date))).slice().sort((a, b) => a.date.localeCompare(b.date))
  if (points.length < 2) return null
  const min = Math.min(...points.map(point => point.value)), max = Math.max(...points.map(point => point.value)), start = Date.parse(points[0].date), end = Date.parse(points[points.length - 1].date)
  if (start === end) return null
  const line = points.map(point => `${12 + (Date.parse(point.date) - start) / (end - start) * 276},${65 - (point.value - min) / (max - min || 1) * 50}`).join(' ')
  return <figure className={styles.sparkline}><svg viewBox="0 0 300 82" role="img" aria-labelledby={titleId}><title id={titleId}>{metric.name}: {points.length} datopunkter fra {points[0].date} til {points[points.length - 1].date}. Laveste verdi {min}, høyeste {max}.</title><path d="M12 65H288" stroke="#34423e" /><polyline points={line} fill="none" stroke="#b4e6cf" strokeWidth="2" /></svg><figcaption><span>{points[0].date}</span><span>{points[points.length - 1].date}</span></figcaption></figure>
}
function displayStatus(metric: HQMetric, error: string | null, loading: boolean) {
  const stored = metric.status === 'unavailable' ? 'Utilgjengelig' : metric.status === 'needs_review' ? 'Må kontrolleres' : 'Lagret måling'
  if (error) return `${stored} · oppdatering ubekreftet`
  if (loading) return `${stored} · oppdaterer …`
  return { live: 'Oppdatert kilde', snapshot: 'Lagret måling', unavailable: 'Utilgjengelig', needs_review: 'Må kontrolleres' }[metric.status]
}
export function HQMetrics({ data, loading, error }: { data: HQMetricsResponse | null; loading: boolean; error: string | null }) {
  return <section aria-label="Produktmålinger"><div className={styles.sectionHeading}><div><span className={styles.overline}>Produkt og forretning</span><h2>Ble det faktisk bedre?</h2></div>{data && <small>Hentet {formatDate(data.generatedAt, true)}</small>}</div><p className={styles.muted}>Oppgaver viser arbeidet som er gjort. Produktmålinger viser hva som skjedde. Ingen effekt beregnes uten et datagrunnlag.</p>{error && <div className={styles.error} role="alert">Målinger kunne ikke oppdateres: {error}{data && <p>Verdiene under kommer fra forrige vellykkede henting.</p>}</div>}{loading && !data && <div className={styles.empty} role="status">Henter tilgjengelige målinger …</div>}{!loading && !data?.metrics.length && <div className={`${styles.card} ${styles.empty}`}><strong>Ikke målt</strong><p>Ingen tilgjengelige produktmålinger for dette prosjektet. Kildestatus nedenfor viser hvilke koblinger som kan leses.</p></div>}<div className={styles.metricsGrid}>{data?.metrics.map(metric => <article className={`${styles.card} ${styles.metric}`} key={metric.id}><div className={styles.metaLine}><span>{projectNames[metric.projectKey]} · {metric.provider}</span><span className={!error && !loading && metric.status === 'live' ? styles.good : styles.warning}>{displayStatus(metric, error, loading)}</span></div><h3>{metric.name}</h3><strong className={styles.metricValue}>{metric.value !== null && Number.isFinite(metric.value) ? new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 }).format(metric.value) : 'Ikke målt'}{metric.value !== null && Number.isFinite(metric.value) && <small>{metric.unit}</small>}</strong><p>{metric.definition}</p><div className={styles.metricPeriod}>{metric.period || 'Måleperiode ikke oppgitt'}</div>{metric.warning && <p className={styles.warning}>{metric.warning}</p>}<Sparkline metric={metric} />{metric.steps?.length ? <ol className={styles.funnelSteps}>{metric.steps.map((step, index) => <li key={index}><span>{step.name}</span><strong>{Number.isFinite(step.count) ? new Intl.NumberFormat('nb-NO').format(step.count) : 'Ukjent'}</strong></li>)}</ol> : null}<div className={styles.metricFooter}><span>Kontrollert {formatDate(metric.checkedAt, true)}</span>{safeExternalUrl(metric.sourceUrl) && <a href={safeExternalUrl(metric.sourceUrl)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Kilde ↗</a>}</div></article>)}</div></section>
}
