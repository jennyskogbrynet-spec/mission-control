export const AUTONOMY_LEVELS = ['auto', 'soft_approval', 'hard_approval'] as const
export const WORKFLOW_TEMPLATE_IDS = [
  'research_to_prd',
  'code_fix',
  'qa_review',
  'content_pipeline',
  'mc_closure',
  'generic_agent_run',
] as const

export type AutonomyLevel = typeof AUTONOMY_LEVELS[number]
export type WorkflowTemplateId = typeof WORKFLOW_TEMPLATE_IDS[number]

export interface ResourcePolicy {
  lane: string
  run_timeout_seconds: number
  max_retries: number
  stale_after_minutes: number
  rate_limit_key: string | null
  zombie_reaper: boolean
}

export interface MemoryContextTypes {
  episodic: string[]
  semantic: string[]
  procedural: string[]
}

interface WorkflowTemplate {
  name: string
  requiredSkills: string[]
  contextPackSources: string[]
  selfLayerSources: string[]
  memoryTools: string[]
  memoryContextTypes: MemoryContextTypes
  allowedTools: string[]
  capabilityScopes: Record<string, unknown>
  resourcePolicy: ResourcePolicy
  proofExpected: string
  verifyRequired: boolean
}

export const WORKFLOW_TEMPLATES: Record<WorkflowTemplateId, WorkflowTemplate> = {
  research_to_prd: {
    name: 'Research -> PRD',
    requiredSkills: ['deep-learn', 'qmd', 'prd-workflow'],
    contextPackSources: ['task.description', 'task.metadata', 'vault.memory_search', 'vault/02-projects', 'vault/04-resources/learnings'],
    selfLayerSources: ['memory/today', 'memory/yesterday', 'memory/sessions/current/CONTEXT.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'SKILLS-GUIDE.md'],
    memoryTools: ['memory.recall', 'memory.navigate', 'memory.update'],
    memoryContextTypes: {
      episodic: ['memory/today', 'memory/yesterday', 'memory/sessions/current/CONTEXT.md'],
      semantic: ['vault/02-projects', 'vault/04-resources/learnings'],
      procedural: ['skills/deep-learn', 'skills/prd-workflow', 'SKILLS-GUIDE.md'],
    },
    allowedTools: ['read_files', 'write_internal_docs', 'web_research', 'internal_api', 'memory.recall', 'memory.navigate', 'memory.update'],
    capabilityScopes: {
      'memory.recall': { read: ['memory', 'vault', 'skills'], write: [] },
      'memory.update': { read: ['result_summary'], write: ['vault/04-resources/learnings'], approval_required: false },
      web_research: { read: ['public_web'], write: [] },
    },
    resourcePolicy: { lane: 'research', run_timeout_seconds: 1800, max_retries: 1, stale_after_minutes: 120, rate_limit_key: 'research', zombie_reaper: true },
    proofExpected: 'source notes, local-fit synthesis, and PRD or implementation recommendation',
    verifyRequired: true,
  },
  code_fix: {
    name: 'Code / Config Fix',
    requiredSkills: ['mission-control', 'approval-gates'],
    contextPackSources: ['task.description', 'task.metadata', 'repo.AGENTS.md', 'repo.tests', 'vault.memory_search'],
    selfLayerSources: ['memory/today', 'memory/yesterday', 'vault/04-resources/learnings', 'skills/approval-gates', 'skills/mission-control'],
    memoryTools: ['memory.recall', 'memory.navigate', 'memory.update'],
    memoryContextTypes: {
      episodic: ['memory/today', 'memory/yesterday', 'previous_attempts'],
      semantic: ['vault/04-resources/learnings', 'repo.tests'],
      procedural: ['repo.AGENTS.md', 'skills/approval-gates', 'skills/mission-control'],
    },
    allowedTools: ['read_files', 'edit_files', 'run_tests', 'internal_api', 'memory.recall', 'memory.navigate', 'memory.update'],
    capabilityScopes: {
      edit_files: { read: ['repo'], write: ['implementation_scope'], approval_required: false },
      run_tests: { read: ['repo'], write: ['test_artifacts'], approval_required: false },
      'memory.update': { read: ['result_summary'], write: ['vault/04-resources/learnings'], approval_required: false },
    },
    resourcePolicy: { lane: 'coding', run_timeout_seconds: 1800, max_retries: 1, stale_after_minutes: 90, rate_limit_key: 'coding', zombie_reaper: true },
    proofExpected: 'changed files, test command/result, and review notes',
    verifyRequired: true,
  },
  qa_review: {
    name: 'QA / Review',
    requiredSkills: ['qa', 'guardrails', 'approval-gates'],
    contextPackSources: ['task.description', 'task.metadata', 'repo.diff', 'test_results', 'vault.memory_search'],
    selfLayerSources: ['memory/today', 'vault/04-resources/learnings', 'skills/guardrails', 'skills/approval-gates'],
    memoryTools: ['memory.recall', 'memory.navigate'],
    memoryContextTypes: {
      episodic: ['test_results', 'previous_review_notes'],
      semantic: ['vault/04-resources/learnings'],
      procedural: ['skills/guardrails', 'skills/approval-gates', 'skills/qa'],
    },
    allowedTools: ['read_files', 'run_tests', 'browser_verify', 'internal_api', 'memory.recall', 'memory.navigate'],
    capabilityScopes: {
      browser_verify: { read: ['local_or_preview_url'], write: ['screenshots', 'qa_notes'], approval_required: false },
      run_tests: { read: ['repo'], write: ['test_artifacts'], approval_required: false },
    },
    resourcePolicy: { lane: 'qa', run_timeout_seconds: 1200, max_retries: 1, stale_after_minutes: 60, rate_limit_key: 'qa', zombie_reaper: true },
    proofExpected: 'findings, pass/fail verdict, residual risk, and recommended next action',
    verifyRequired: true,
  },
  content_pipeline: {
    name: 'Content Pipeline',
    requiredSkills: ['content-pipeline', 'approval-gates'],
    contextPackSources: ['task.description', 'task.metadata', 'brand_docs', 'vault.memory_search', 'source_material'],
    selfLayerSources: ['memory/today', 'memory/sessions/current/CONTEXT.md', 'vault/02-projects', 'skills/content-pipeline'],
    memoryTools: ['memory.recall', 'memory.navigate', 'memory.update'],
    memoryContextTypes: {
      episodic: ['memory/today', 'memory/sessions/current/CONTEXT.md'],
      semantic: ['vault/02-projects', 'brand_docs', 'source_material'],
      procedural: ['skills/content-pipeline', 'skills/approval-gates'],
    },
    allowedTools: ['read_files', 'write_internal_docs', 'media_generate', 'internal_api', 'memory.recall', 'memory.navigate', 'memory.update'],
    capabilityScopes: {
      media_generate: { read: ['approved_brief', 'brand_docs'], write: ['draft_assets'], approval_required: false },
      publish: { read: ['approved_asset'], write: ['external_channels'], approval_required: true },
    },
    resourcePolicy: { lane: 'content', run_timeout_seconds: 1800, max_retries: 1, stale_after_minutes: 120, rate_limit_key: 'content', zombie_reaper: true },
    proofExpected: 'draft, source/evidence notes, brand check, and approval state',
    verifyRequired: true,
  },
  mc_closure: {
    name: 'MC Ticket Closure',
    requiredSkills: ['mission-control', 'mc-ticket-closure-sprint'],
    contextPackSources: ['task.description', 'task.metadata', 'task.history', 'evidence', 'review_notes'],
    selfLayerSources: ['memory/today', 'vault/04-resources/agent-quality', 'skills/mission-control'],
    memoryTools: ['memory.recall', 'memory.update'],
    memoryContextTypes: {
      episodic: ['task.history', 'evidence', 'review_notes'],
      semantic: ['vault/04-resources/agent-quality'],
      procedural: ['skills/mission-control', 'skills/mc-ticket-closure-sprint'],
    },
    allowedTools: ['read_files', 'write_internal_docs', 'internal_api', 'memory.recall', 'memory.update'],
    capabilityScopes: {
      'memory.update': { read: ['final_report'], write: ['vault/04-resources/agent-quality', 'vault/04-resources/learnings'], approval_required: false },
      internal_api: { read: ['task'], write: ['task.status', 'task.resolution'], approval_required: false },
    },
    resourcePolicy: { lane: 'closure', run_timeout_seconds: 900, max_retries: 1, stale_after_minutes: 45, rate_limit_key: 'internal', zombie_reaper: true },
    proofExpected: 'final outcome, evidence link, learning captured or explicitly skipped',
    verifyRequired: true,
  },
  generic_agent_run: {
    name: 'Generic Agent Run',
    requiredSkills: ['mission-control', 'approval-gates'],
    contextPackSources: ['task.description', 'task.metadata', 'workspace.skills', 'vault.memory_search'],
    selfLayerSources: ['memory/today', 'memory/yesterday', 'memory/sessions/current/CONTEXT.md', 'vault/04-resources/learnings', 'SKILLS-GUIDE.md'],
    memoryTools: ['memory.recall', 'memory.navigate'],
    memoryContextTypes: {
      episodic: ['memory/today', 'memory/yesterday', 'memory/sessions/current/CONTEXT.md'],
      semantic: ['vault/04-resources/learnings'],
      procedural: ['SKILLS-GUIDE.md', 'skills/mission-control', 'skills/approval-gates'],
    },
    allowedTools: ['read_files', 'write_internal_docs', 'run_tests', 'internal_api', 'memory.recall', 'memory.navigate'],
    capabilityScopes: {
      internal_api: { read: ['task'], write: ['task.metadata'], approval_required: false },
    },
    resourcePolicy: { lane: 'default', run_timeout_seconds: 1200, max_retries: 1, stale_after_minutes: 60, rate_limit_key: 'internal', zombie_reaper: true },
    proofExpected: 'short result summary',
    verifyRequired: false,
  },
}

export interface WorkflowContract {
  workflow_template: WorkflowTemplateId
  goal: string
  owner_agent: string | null
  required_skills: string[]
  context_pack_sources: string[]
  self_layer_sources: string[]
  memory_tools: string[]
  memory_context_types: MemoryContextTypes
  allowed_tools: string[]
  capability_scopes: Record<string, unknown>
  resource_policy: ResourcePolicy
  tool_permissions: Record<string, unknown>
  autonomy_level: AutonomyLevel
  verify_required: boolean
  proof_expected: string
  output_location: string | null
}

export interface AgenticOsMetadata {
  workflow_contract: WorkflowContract
  context_pack?: Record<string, unknown>
  agentic_os: {
    ontology: string
    evidence: unknown[]
    decisions: unknown[]
    learnings: unknown[]
    action_log: unknown[]
    evals: unknown[]
  }
}

interface TaskContractContext {
  title: string
  description?: string | null
  assigned_to?: string | null
  priority?: string | null
  status?: string | null
  tags?: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function uniqueStrings(...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter((item) => item.trim().length > 0))]
}

function inferWorkflowTemplate(
  existing: Record<string, unknown>,
  task: TaskContractContext,
): WorkflowTemplateId {
  const provided = asOptionalString(existing.workflow_template)
  if (provided && WORKFLOW_TEMPLATE_IDS.includes(provided as WorkflowTemplateId)) {
    return provided as WorkflowTemplateId
  }

  const text = [
    task.title,
    task.description,
    task.assigned_to,
    ...(task.tags ?? []),
  ].filter(Boolean).join(' ').toLowerCase()

  if (/\b(research|analyse|analysis|deep-learn|prd|sources?|stella)\b/.test(text)) {
    return 'research_to_prd'
  }
  if (/\b(qa|review|eval|verify|vera|kjell|aegis)\b/.test(text)) {
    return 'qa_review'
  }
  if (/\b(code|coding|fix|bug|config|build|test|reidar|implementation)\b/.test(text)) {
    return 'code_fix'
  }
  if (/\b(content|article|reel|tiktok|instagram|jenny|social|caption)\b/.test(text)) {
    return 'content_pipeline'
  }
  if (/\b(close|closure|done|handoff|proof|sprint|resolution)\b/.test(text)) {
    return 'mc_closure'
  }
  return 'generic_agent_run'
}

function inferAutonomyLevel(tags: string[], metadata: Record<string, unknown>): AutonomyLevel {
  const text = [
    ...tags,
    asOptionalString(metadata.approval_level),
    asOptionalString(metadata.autonomy_level),
  ].filter(Boolean).join(' ').toLowerCase()

  if (/\b(hard|hard_approval|delete|deletion|money|spend|email|dns|auth|openclaw\.json)\b/.test(text)) {
    return 'hard_approval'
  }
  if (/\b(soft|soft_approval|publish|deploy|cron|automation|preview)\b/.test(text)) {
    return 'soft_approval'
  }
  return 'auto'
}

function defaultAllowedTools(autonomyLevel: AutonomyLevel): string[] {
  const safeTools = ['read_files', 'write_internal_docs', 'run_tests', 'internal_api']
  if (autonomyLevel === 'auto') return safeTools
  return [...safeTools, 'approval_request']
}

function normalizeWorkflowContract(
  metadata: Record<string, unknown>,
  task: TaskContractContext,
): WorkflowContract {
  const existing = asRecord(metadata.workflow_contract)
  const workflowTemplate = inferWorkflowTemplate(existing, task)
  const template = WORKFLOW_TEMPLATES[workflowTemplate]
  const autonomyLevel = AUTONOMY_LEVELS.includes(existing.autonomy_level as AutonomyLevel)
    ? existing.autonomy_level as AutonomyLevel
    : inferAutonomyLevel(task.tags ?? [], metadata)
  const existingRequiredSkills = asStringArray(existing.required_skills)
  const existingContextSources = asStringArray(existing.context_pack_sources)
  const existingSelfLayerSources = asStringArray(existing.self_layer_sources)
  const existingMemoryTools = asStringArray(existing.memory_tools)
  const existingAllowedTools = asStringArray(existing.allowed_tools)
  const existingMemoryContextTypes = asRecord(existing.memory_context_types)
  const existingResourcePolicy = asRecord(existing.resource_policy)

  return {
    workflow_template: workflowTemplate,
    goal: asOptionalString(existing.goal) ?? task.title,
    owner_agent: asOptionalString(existing.owner_agent) ?? asOptionalString(task.assigned_to),
    required_skills: existingRequiredSkills.length > 0
      ? existingRequiredSkills
      : template.requiredSkills,
    context_pack_sources: existingContextSources.length > 0
      ? existingContextSources
      : template.contextPackSources,
    self_layer_sources: existingSelfLayerSources.length > 0
      ? existingSelfLayerSources
      : template.selfLayerSources,
    memory_tools: existingMemoryTools.length > 0
      ? existingMemoryTools
      : template.memoryTools,
    memory_context_types: {
      episodic: asStringArray(existingMemoryContextTypes.episodic).length > 0
        ? asStringArray(existingMemoryContextTypes.episodic)
        : template.memoryContextTypes.episodic,
      semantic: asStringArray(existingMemoryContextTypes.semantic).length > 0
        ? asStringArray(existingMemoryContextTypes.semantic)
        : template.memoryContextTypes.semantic,
      procedural: asStringArray(existingMemoryContextTypes.procedural).length > 0
        ? asStringArray(existingMemoryContextTypes.procedural)
        : template.memoryContextTypes.procedural,
    },
    allowed_tools: existingAllowedTools.length > 0
      ? existingAllowedTools
      : uniqueStrings(template.allowedTools, defaultAllowedTools(autonomyLevel)),
    capability_scopes: {
      ...template.capabilityScopes,
      ...(asRecord(existing.capability_scopes)),
    },
    resource_policy: {
      lane: asOptionalString(existingResourcePolicy.lane) ?? template.resourcePolicy.lane,
      run_timeout_seconds: typeof existingResourcePolicy.run_timeout_seconds === 'number'
        ? existingResourcePolicy.run_timeout_seconds
        : template.resourcePolicy.run_timeout_seconds,
      max_retries: typeof existingResourcePolicy.max_retries === 'number'
        ? existingResourcePolicy.max_retries
        : template.resourcePolicy.max_retries,
      stale_after_minutes: typeof existingResourcePolicy.stale_after_minutes === 'number'
        ? existingResourcePolicy.stale_after_minutes
        : template.resourcePolicy.stale_after_minutes,
      rate_limit_key: asOptionalString(existingResourcePolicy.rate_limit_key) ?? template.resourcePolicy.rate_limit_key,
      zombie_reaper: typeof existingResourcePolicy.zombie_reaper === 'boolean'
        ? existingResourcePolicy.zombie_reaper
        : template.resourcePolicy.zombie_reaper,
    },
    tool_permissions: {
      safe_internal_actions: true,
      gate_four_requires_approval: true,
      ...(asRecord(existing.tool_permissions)),
    },
    autonomy_level: autonomyLevel,
    verify_required: typeof existing.verify_required === 'boolean'
      ? existing.verify_required
      : template.verifyRequired || ['critical', 'high'].includes(String(task.priority ?? '').toLowerCase()),
    proof_expected: asOptionalString(existing.proof_expected)
      ?? template.proofExpected,
    output_location: asOptionalString(existing.output_location),
  }
}

function normalizeAgenticOs(existing: unknown): AgenticOsMetadata['agentic_os'] {
  const input = asRecord(existing)
  return {
    ontology: asOptionalString(input.ontology) ?? 'Mission -> Goal -> Ticket -> Agent Run -> Action -> Outcome -> Learning',
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    decisions: Array.isArray(input.decisions) ? input.decisions : [],
    learnings: Array.isArray(input.learnings) ? input.learnings : [],
    action_log: Array.isArray(input.action_log) ? input.action_log : [],
    evals: Array.isArray(input.evals) ? input.evals : [],
  }
}

export function normalizeTaskMetadata(
  metadata: Record<string, unknown> | undefined,
  task: TaskContractContext,
): Record<string, unknown> & AgenticOsMetadata {
  const base = asRecord(metadata)
  return {
    ...base,
    workflow_contract: normalizeWorkflowContract(base, task),
    agentic_os: normalizeAgenticOs(base.agentic_os),
  }
}
