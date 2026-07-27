import { NextResponse } from 'next/server'
import { ZodSchema, ZodError } from 'zod'
import { z } from 'zod'

export async function validateBody<T>(
  request: Request,
  schema: ZodSchema<T>
): Promise<{ data: T } | { error: NextResponse }> {
  try {
    const body = await request.json()
    const data = schema.parse(body)
    return { data }
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`)
      return {
        error: NextResponse.json(
          { error: 'Validation failed', details: messages },
          { status: 400 }
        ),
      }
    }
    return {
      error: NextResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    }
  }
}

const workflowContractSchema = z.object({
  workflow_template: z.enum(['research_to_prd', 'code_fix', 'qa_review', 'content_pipeline', 'mc_closure', 'generic_agent_run']).optional(),
  goal: z.string().min(1).max(1000).optional(),
  owner_agent: z.string().min(1).max(100).nullable().optional(),
  required_skills: z.array(z.string().min(1).max(100)).max(50).optional(),
  context_pack_sources: z.array(z.string().min(1).max(200)).max(50).optional(),
  self_layer_sources: z.array(z.string().min(1).max(200)).max(50).optional(),
  memory_tools: z.array(z.string().min(1).max(100)).max(50).optional(),
  memory_context_types: z.object({
    episodic: z.array(z.string().min(1).max(200)).max(50).optional(),
    semantic: z.array(z.string().min(1).max(200)).max(50).optional(),
    procedural: z.array(z.string().min(1).max(200)).max(50).optional(),
  }).catchall(z.unknown()).optional(),
  allowed_tools: z.array(z.string().min(1).max(100)).max(100).optional(),
  capability_scopes: z.record(z.string(), z.unknown()).optional(),
  resource_policy: z.object({
    lane: z.string().min(1).max(100).optional(),
    run_timeout_seconds: z.number().int().min(30).max(7200).optional(),
    max_retries: z.number().int().min(0).max(10).optional(),
    stale_after_minutes: z.number().int().min(1).max(1440).optional(),
    rate_limit_key: z.string().min(1).max(100).nullable().optional(),
    zombie_reaper: z.boolean().optional(),
  }).catchall(z.unknown()).optional(),
  tool_permissions: z.record(z.string(), z.unknown()).optional(),
  autonomy_level: z.enum(['auto', 'soft_approval', 'hard_approval']).optional(),
  verify_required: z.boolean().optional(),
  proof_expected: z.string().min(1).max(1000).optional(),
  output_location: z.string().min(1).max(500).nullable().optional(),
}).catchall(z.unknown())

const agenticOsSchema = z.object({
  ontology: z.string().min(1).max(500).optional(),
  evidence: z.array(z.unknown()).max(200).optional(),
  decisions: z.array(z.unknown()).max(200).optional(),
  learnings: z.array(z.unknown()).max(200).optional(),
  action_log: z.array(z.unknown()).max(1000).optional(),
  evals: z.array(z.unknown()).max(200).optional(),
}).catchall(z.unknown())

const taskMetadataSchema = z.object({
  implementation_repo: z.string().min(1, 'implementation_repo cannot be empty').max(200).optional(),
  code_location: z.string().min(1, 'code_location cannot be empty').max(500).optional(),
  workflow_contract: workflowContractSchema.optional(),
  context_pack: z.record(z.string(), z.unknown()).optional(),
  agentic_os: agenticOsSchema.optional(),
}).catchall(z.unknown())

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(5000).optional(),
  status: z.enum(['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review', 'done', 'failed']).default('inbox'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  project_id: z.number().int().positive().optional(),
  assigned_to: z.string().max(100).optional(),
  created_by: z.string().max(100).optional(),
  due_date: z.number().int().min(0).max(4102444800).optional(), // max ~2100-01-01
  estimated_hours: z.number().min(0).max(10000).optional(),
  actual_hours: z.number().min(0).max(10000).optional(),
  outcome: z.enum(['success', 'failed', 'partial', 'abandoned']).optional(),
  error_message: z.string().max(5000).optional(),
  resolution: z.string().max(5000).optional(),
  feedback_rating: z.number().int().min(1).max(5).optional(),
  feedback_notes: z.string().max(5000).optional(),
  retry_count: z.number().int().min(0).optional(),
  completed_at: z.number().int().min(0).max(4102444800).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).default([] as string[]),
  metadata: taskMetadataSchema.default({} as Record<string, unknown>),
})

export const updateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500).optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review', 'done', 'failed']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  project_id: z.number().int().positive().optional(),
  assigned_to: z.string().max(100).optional(),
  created_by: z.string().max(100).optional(),
  due_date: z.number().int().min(0).max(4102444800).optional(),
  estimated_hours: z.number().min(0).max(10000).optional(),
  actual_hours: z.number().min(0).max(10000).optional(),
  outcome: z.enum(['success', 'failed', 'partial', 'abandoned']).optional(),
  error_message: z.string().max(5000).optional(),
  resolution: z.string().max(5000).optional(),
  feedback_rating: z.number().int().min(1).max(5).optional(),
  feedback_notes: z.string().max(5000).optional(),
  retry_count: z.number().int().min(0).optional(),
  completed_at: z.number().int().min(0).max(4102444800).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  metadata: taskMetadataSchema.optional(),
})

export const createAgentSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  openclaw_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'openclaw_id must be kebab-case').max(100).optional(),
  role: z.string().min(1, 'Role is required').max(100).optional(),
  session_key: z.string().max(200).optional(),
  soul_content: z.string().max(50000).optional(),
  status: z.enum(['online', 'offline', 'busy', 'idle', 'error']).default('offline'),
  config: z.record(z.string(), z.unknown()).default({} as Record<string, unknown>),
  template: z.string().max(100).optional(),
  gateway_config: z.record(z.string(), z.unknown()).optional(),
  write_to_gateway: z.boolean().optional(),
  provision_openclaw_workspace: z.boolean().optional(),
  openclaw_workspace_path: z.string().min(1).max(500).optional(),
  runtime_type: z.enum(['hermes', 'openclaw', 'claude', 'codex', 'custom']).optional(),
})

export const bulkUpdateTaskStatusSchema = z.object({
  tasks: z.array(z.object({
    id: z.number().int().positive(),
    status: z.enum(['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review', 'done', 'failed']),
  })).min(1, 'At least one task is required').max(100),
})

export const createWebhookSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  url: z.string().url('Invalid URL'),
  events: z.array(z.string().min(1).max(200)).max(50).optional(),
  generate_secret: z.boolean().optional(),
})

export const createAlertSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(1000).optional(),
  entity_type: z.enum(['agent', 'task', 'session', 'activity']),
  condition_field: z.string().min(1).max(100),
  condition_operator: z.enum(['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'count_above', 'count_below', 'age_minutes_above']),
  condition_value: z.string().min(1).max(500),
  action_type: z.string().max(100).optional(),
  action_config: z.record(z.string(), z.unknown()).optional(),
  cooldown_minutes: z.number().min(1).max(10080).optional(),
})

export const notificationActionSchema = z.object({
  action: z.literal('mark-delivered'),
  agent: z.string().min(1, 'Agent name is required'),
})

export const integrationActionSchema = z.object({
  action: z.enum(['test', 'pull', 'pull-all']),
  integrationId: z.string().optional(),
  category: z.string().optional(),
})

export const createPipelineSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(5000).optional(),
  steps: z.array(z.object({
    template_id: z.number().int().positive(),
    on_failure: z.enum(['stop', 'continue']).default('stop'),
  })).min(2, 'Pipeline needs at least 2 steps').max(50),
})

export const createWorkflowSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  task_prompt: z.string().min(1, 'Task prompt is required').max(10000),
  description: z.string().max(5000).optional(),
  model: z.string().max(100).default('sonnet'),
  timeout_seconds: z.number().int().min(10).max(3600).default(300),
  agent_role: z.string().max(100).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).default([]),
})

export const createCommentSchema = z.object({
  task_id: z.number().optional(),
  content: z.string().min(1, 'Comment content is required'),
  author: z.string().optional(),
  parent_id: z.number().optional(),
})

export const createMessageSchema = z.object({
  to: z.string().min(1, 'Recipient is required'),
  message: z.string().min(1, 'Message is required'),
  from: z.string().optional().default('system'),
})

export const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
})

export const gatewayConfigUpdateSchema = z.object({
  updates: z.record(z.string(), z.unknown()),
  hash: z.string().optional(),
})

export const qualityReviewSchema = z.object({
  taskId: z.number(),
  reviewer: z.string().default('aegis'),
  status: z.enum(['approved', 'rejected', 'in_progress']),
  notes: z.string().min(1, 'Notes are required for quality reviews'),
  // Revision binding: when provided, the review only applies if the task's
  // updated_at still matches — otherwise the API returns 409 stale_review.
  expected_updated_at: z.number().int().optional(),
})

export const spawnAgentSchema = z.object({
  task: z.string().min(1, 'Task is required'),
  model: z.string().min(1, 'Model is required').optional(),
  label: z.string().min(1, 'Label is required'),
  timeoutSeconds: z.number().min(10).max(3600).default(300),
})

export const createUserSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  display_name: z.string().optional(),
  role: z.enum(['admin', 'operator', 'viewer']).default('operator'),
  provider: z.enum(['local', 'google']).default('local'),
  email: z.string().optional(),
})

export const accessRequestActionSchema = z.object({
  request_id: z.number(),
  action: z.enum(['approve', 'reject']),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
  note: z.string().optional(),
})

export const connectSchema = z.object({
  tool_name: z.string().min(1, 'Tool name is required').max(100),
  tool_version: z.string().max(50).optional(),
  agent_name: z.string().min(1, 'Agent name is required').max(100),
  agent_role: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const githubSyncSchema = z.object({
  action: z.enum(['sync', 'comment', 'close', 'status', 'init-labels', 'sync-project']),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Repo must be owner/repo format').optional(),
  labels: z.string().optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
  assignAgent: z.string().optional(),
  issueNumber: z.number().optional(),
  body: z.string().optional(),
  comment: z.string().optional(),
  project_id: z.number().optional(),
})
