export type HQProjectKey = 'babyhub' | 'babysential' | 'brrrr' | 'shared'
export type HQView = 'overview' | 'knowledge' | 'decisions' | 'analysis'
export interface HQProject {
  id: number | null
  key: HQProjectKey
  name: string
  description: string
  color: string
  noteCount: number
}
export interface HQNote {
  id: string
  path: string
  title: string
  projectKey: HQProjectKey
  kind: 'source' | 'knowledge' | 'decision' | 'learning'
  summary: string
  tags: string[]
  modifiedAt: string
  sourceDate: string | null
  wordCount: number
  linkCount: number
}
export interface HQLink {
  source: string
  target: string
  kind: 'wikilink' | 'markdown' | 'task-source' | 'evidence'
}
export interface HQEvidence {
  label: string
  url?: string
  detail?: string
  createdAt?: string
}
export interface HQTask {
  id: number
  title: string
  description: string
  status: string
  priority: string
  projectId: number | null
  projectKey: HQProjectKey
  assignedTo: string | null
  ticketRef: string | null
  updatedAt: string
  sourceIds: string[]
  learningNoteIds?: string[]
  acceptanceCriteria: string[]
  expectedOutcome: string | null
  evidence: HQEvidence[]
  measurementStatus: 'unmeasured' | 'observed'
}
export interface HQSourceStatus {
  id: string
  name: string
  state: 'available' | 'partial' | 'unavailable'
  checkedAt: string
  detail: string
  count?: number
}
export interface HQAgent {
  name: string
  role: string
  status: string
  updatedAt: string | null
}
export interface HQActivity {
  id: number
  description: string
  actor: string
  createdAt: string
  taskId?: number
}
export interface HQSnapshot {
  generatedAt: string
  projects: HQProject[]
  notes: HQNote[]
  links: HQLink[]
  tasks: HQTask[]
  sources: HQSourceStatus[]
  agents: HQAgent[]
  activity: HQActivity[]
  coverage: { indexed: number; limit: number; truncated: boolean; excluded: number }
}
export interface HQMetric {
  id: string
  projectKey: HQProjectKey
  name: string
  provider: string
  value: number | null
  unit: string
  status: 'live' | 'snapshot' | 'unavailable' | 'needs_review'
  checkedAt: string
  period: string
  definition: string
  sourceUrl?: string
  warning?: string
  steps?: { name: string; count: number }[]
  series?: { date: string; value: number }[]
}
export interface HQMetricsResponse {
  generatedAt: string
  metrics: HQMetric[]
  sources: HQSourceStatus[]
}
export interface HQSearchResponse {
  notes: HQNote[]
  engine: 'qmd' | 'local'
  detail?: string
}
export interface HQTaskCreateInput {
  title: string
  description: string
  projectKey: HQProjectKey
  sourceIds: string[]
  acceptanceCriteria: string[]
  expectedOutcome: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  idempotencyKey: string
}
