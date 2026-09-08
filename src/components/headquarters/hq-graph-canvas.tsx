'use client'
import { GraphCanvas, type Theme } from 'reagraph'
import type { HQLink } from '@/lib/hq-types'
import { type GraphItem, projectColors } from './hq-data'
const theme: Theme = {
  canvas: { background: '#101720', fog: '#101720' },
  node: { fill: '#b4e6cf', activeFill: '#eefbf6', opacity: 1, selectedOpacity: 1, inactiveOpacity: .24, label: { color: '#c7d6df', stroke: '#101720', activeColor: '#ffffff' } },
  ring: { fill: '#53796c', activeFill: '#b4e6cf' },
  edge: { fill: '#506c78', activeFill: '#b4e6cf', opacity: .34, selectedOpacity: .95, inactiveOpacity: .08, label: { color: '#9daebb', activeColor: '#ffffff' } },
  arrow: { fill: '#506c78', activeFill: '#b4e6cf' },
  lasso: { background: 'rgba(180,230,207,.08)', border: 'rgba(180,230,207,.3)' },
}
export default function HQGraphCanvas({ items, links, selected, onSelect }: { items: GraphItem[]; links: HQLink[]; selected: string | null; onSelect: (id: string) => void }) {
  return <GraphCanvas
    nodes={items.map(item => ({ id: item.id, label: item.title, fill: projectColors[item.projectKey], size: item.kind === 'task' ? 5 : 4 }))}
    edges={links.map((link, index) => ({ id: `${link.source}-${link.target}-${index}`, source: link.source, target: link.target }))}
    theme={theme} layoutType="forceDirected3d" labelType="auto" cameraMode="rotate" animated={false} draggable={false}
    edgeArrowPosition="end" selections={selected ? [selected] : []} onNodeClick={node => onSelect(node.id)}
  />
}
