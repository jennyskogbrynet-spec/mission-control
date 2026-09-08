'use client'
import dynamic from 'next/dynamic'
import { Component, useId, useMemo, useState, type ReactNode } from 'react'
import type { HQLink } from '@/lib/hq-types'
import { graphWindow, kindNames, projectColors, projectNames, type GraphItem } from './hq-data'
import styles from './headquarters.module.css'
const Canvas = dynamic(() => import('./hq-graph-canvas'), { ssr: false, loading: () => <div className={styles.empty}>Laster 3D-visning …</div> })
class CanvasBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
const columns = ['source', 'knowledge', 'decision', 'task', 'learning'] as const
export function HQGraph({ items, links, selected, onSelect }: { items: GraphItem[]; links: HQLink[]; selected: string | null; onSelect: (id: string) => void }) {
  const [mode, setMode] = useState<'map' | '3d' | 'list'>('map')
  const [listLimit, setListLimit] = useState(40)
  const marker = useId().replace(/:/g, '')
  const bounded = useMemo(() => graphWindow(items, links, selected), [items, links, selected])
  const mapHeight = Math.max(430, 110 + Math.max(0, ...columns.map(kind => bounded.items.filter(item => item.kind === kind).length)) * 43)
  const positions = new Map<string, { x: number; y: number }>()
  columns.forEach((kind, col) => {
    const group = bounded.items.filter(item => item.kind === kind)
    group.forEach((item, row) => positions.set(item.id, { x: 88 + col * 178, y: 94 + row * 43 }))
  })
  return <section className={`${styles.card} ${styles.graphCard}`} aria-label="Kildegraf">
    <div className={styles.cardHead}><div><span className={styles.overline}>Kunnskapen vår</span><h2>Kilder som henger sammen</h2></div><div className={styles.segmented} aria-label="Grafvisning">{(['map', '3d', 'list'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'map' ? '2D' : value === '3d' ? '3D' : 'Liste'}</button>)}</div></div>
    <p className={styles.graphHint}>{items.length} dokumenter og oppgaver · {links.length} registrerte forbindelser. {mode === 'map' ? 'Kolonner viser dokumenttype.' : mode === '3d' ? 'Dra for å rotere. Rull for å zoome.' : 'Velg et dokument eller en oppgave for å lese grunnlaget.'} Plassering viser ikke semantisk nærhet eller utvikling over tid.</p>
    {!items.length ? <div className={styles.empty}><strong>Ingen kilder i dette utvalget</strong><p>Velg et annet prosjekt eller et kortere søk. Kildestatus vises nederst på siden.</p></div> : mode === 'list' ? <div className={styles.graphList}>{items.slice(0, listLimit).map(item => <button className={selected === item.id ? styles.selectedRow : ''} key={item.id} onClick={() => onSelect(item.id)} aria-pressed={selected === item.id}><span className={styles.dot} style={{ background: projectColors[item.projectKey] }} /><span><strong>{item.title}</strong><small>{projectNames[item.projectKey]} · {kindNames[item.kind]}</small></span><span aria-hidden="true">↗</span></button>)}{items.length > listLimit && <button onClick={() => setListLimit(value => value + 40)}>Vis flere ({items.length - listLimit} gjenstår)</button>}</div> : mode === '3d' ? <div className={styles.canvas3d}><CanvasBoundary fallback={<div className={styles.empty}><strong>3D er ikke tilgjengelig i denne nettleseren</strong><p>Bruk 2D eller den tastaturvennlige listen for de samme kildene.</p><button className={styles.button} onClick={() => setMode('list')}>Åpne kildelisten</button></div>}><Canvas items={bounded.items} links={bounded.links} selected={selected} onSelect={onSelect} /></CanvasBoundary><button className={styles.canvasAccessible} onClick={() => setMode('list')}>Åpne tastaturvennlig liste</button></div> : <div className={styles.graphScroll} tabIndex={0} role="region" aria-label="Kildegraf i to dimensjoner. Rull vannrett ved behov."><div className={styles.graphMap} style={{ height: mapHeight }}><svg viewBox={`0 0 900 ${mapHeight}`} style={{ height: mapHeight }} aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 1 9 5 0 9" fill="none" stroke="#88a69d" /></marker></defs>{bounded.links.map((link, index) => { const a = positions.get(link.source), b = positions.get(link.target); if (!a || !b) return null; return <path key={index} className={link.source === selected || link.target === selected ? styles.activeEdge : styles.edge} d={`M${a.x} ${a.y} C${(a.x + b.x) / 2} ${a.y},${(a.x + b.x) / 2} ${b.y},${b.x} ${b.y}`} markerEnd={`url(#${marker})`} /> })}</svg>{columns.map((kind, index) => <span key={kind} className={styles.graphColumn} style={{ left: 29 + index * 178 }}><span>0{index + 1}</span>{kindNames[kind]}</span>)}{bounded.items.map(item => { const pos = positions.get(item.id)!; return <button key={item.id} className={`${styles.graphNode} ${selected === item.id ? styles.graphNodeSelected : ''}`} style={{ left: pos.x - 68, top: pos.y - 16, '--node-color': projectColors[item.projectKey] } as React.CSSProperties} onClick={() => onSelect(item.id)} aria-pressed={selected === item.id} aria-label={`${item.title}. ${kindNames[item.kind]}. ${projectNames[item.projectKey]}`} title={item.title}><i /><span>{item.title}</span></button> })}</div></div>}
    <div className={styles.graphFooter}><span>{mode === 'list' ? Math.min(items.length, listLimit) : bounded.items.length} av {items.length} objekter vist{mode !== 'list' && items.length > bounded.items.length ? ' · valgt kilde og nærmeste forbindelser prioriteres' : ''}</span><div>{(['babyhub', 'babysential', 'brrrr', 'shared'] as const).map(project => <span key={project}><i className={styles.dot} style={{ background: projectColors[project] }} />{projectNames[project]}</span>)}</div></div>
  </section>
}
