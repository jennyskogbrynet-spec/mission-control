import { describe, it, expect } from 'vitest'
import {
  createTaskSchema,
  createAgentSchema,
  createWebhookSchema,
  createAlertSchema,
  spawnAgentSchema,
  createUserSchema,
  qualityReviewSchema,
  createPipelineSchema,
  createWorkflowSchema,
  createMessageSchema,
  updateTaskSchema,
} from '@/lib/validation'

describe('createTaskSchema', () => {
  it('accepts valid input with defaults', () => {
    const result = createTaskSchema.safeParse({ title: 'Fix bug' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('Fix bug')
      expect(result.data.status).toBe('inbox')
      expect(result.data.priority).toBe('medium')
      expect(result.data.tags).toEqual([])
      expect(result.data.metadata).toEqual({})
    }
  })

  it('rejects missing title', () => {
    const result = createTaskSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects invalid status', () => {
    const result = createTaskSchema.safeParse({ title: 'X', status: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('accepts all valid statuses', () => {
    for (const status of ['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review', 'done', 'failed']) {
      const result = createTaskSchema.safeParse({ title: 'T', status })
      expect(result.success).toBe(true)
    }
  })

  it('accepts outcome and feedback fields', () => {
    const result = createTaskSchema.safeParse({
      title: 'Investigate flaky test',
      status: 'done',
      outcome: 'partial',
      feedback_rating: 4,
      feedback_notes: 'Needs follow-up monitoring',
      retry_count: 2,
      completed_at: 1735600000,
    })
    expect(result.success).toBe(true)
  })

  it('accepts implementation target metadata fields', () => {
    const result = createTaskSchema.safeParse({
      title: 'Route this task',
      metadata: {
        implementation_repo: 'builderz-labs/mission-control',
        code_location: '/apps/api',
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid feedback_rating', () => {
    const result = createTaskSchema.safeParse({
      title: 'Invalid rating test',
      feedback_rating: 6,
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-string implementation target metadata fields', () => {
    const result = createTaskSchema.safeParse({
      title: 'Bad metadata',
      metadata: {
        implementation_repo: 123,
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts Agentic OS workflow contract metadata', () => {
    const result = createTaskSchema.safeParse({
      title: 'Agentic OS ticket',
      metadata: {
        workflow_contract: {
          workflow_template: 'qa_review',
          goal: 'Make MC more deterministic',
          owner_agent: 'Vera',
          required_skills: ['mission-control'],
          context_pack_sources: ['task.description', 'vault.memory_search'],
          self_layer_sources: ['memory/today', 'vault/04-resources/learnings'],
          memory_tools: ['memory.recall', 'memory.navigate'],
          memory_context_types: {
            episodic: ['memory/today'],
            semantic: ['vault/04-resources/learnings'],
            procedural: ['skills/mission-control'],
          },
          allowed_tools: ['read_files', 'run_tests'],
          capability_scopes: {
            run_tests: { read: ['repo'], write: ['test_artifacts'] },
          },
          resource_policy: {
            lane: 'qa',
            run_timeout_seconds: 1200,
            max_retries: 1,
            stale_after_minutes: 60,
            rate_limit_key: 'qa',
            zombie_reaper: true,
          },
          tool_permissions: { safe_internal_actions: true },
          autonomy_level: 'soft_approval',
          verify_required: true,
          proof_expected: 'test output',
          output_location: 'vault/04-resources/agent-quality/report.md',
        },
        context_pack: { summary: 'Prior context goes here' },
        agentic_os: {
          evidence: [],
          decisions: [],
          learnings: [],
          action_log: [],
          evals: [],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid workflow autonomy level', () => {
    const result = createTaskSchema.safeParse({
      title: 'Bad autonomy',
      metadata: {
        workflow_contract: {
          autonomy_level: 'maybe',
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid workflow template', () => {
    const result = createTaskSchema.safeParse({
      title: 'Bad template',
      metadata: {
        workflow_contract: {
          workflow_template: 'youtube_os_magic',
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid resource policy timeout', () => {
    const result = createTaskSchema.safeParse({
      title: 'Bad timeout',
      metadata: {
        workflow_contract: {
          resource_policy: {
            run_timeout_seconds: 5,
          },
        },
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('updateTaskSchema', () => {
  it('does not apply create defaults on partial updates', () => {
    const result = updateTaskSchema.safeParse({ outcome: 'success' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ outcome: 'success' })
    }
  })
})

describe('createAgentSchema', () => {
  it('accepts valid input', () => {
    const result = createAgentSchema.safeParse({ name: 'agent-1' })
    expect(result.success).toBe(true)
  })

  it('rejects missing name', () => {
    const result = createAgentSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('createWebhookSchema', () => {
  it('accepts valid input', () => {
    const result = createWebhookSchema.safeParse({
      name: 'My Hook',
      url: 'https://example.com/hook',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid URL', () => {
    const result = createWebhookSchema.safeParse({
      name: 'Hook',
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })
})

describe('createAlertSchema', () => {
  const validAlert = {
    name: 'CPU Alert',
    entity_type: 'agent' as const,
    condition_field: 'cpu',
    condition_operator: 'greater_than' as const,
    condition_value: '90',
  }

  it('accepts valid input', () => {
    const result = createAlertSchema.safeParse(validAlert)
    expect(result.success).toBe(true)
  })

  it('rejects missing name', () => {
    const { name, ...rest } = validAlert
    const result = createAlertSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects missing entity_type', () => {
    const { entity_type, ...rest } = validAlert
    const result = createAlertSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

describe('spawnAgentSchema', () => {
  const validSpawn = {
    task: 'Do something',
    label: 'worker-1',
  }

  it('accepts valid input with default timeout', () => {
    const result = spawnAgentSchema.safeParse(validSpawn)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.timeoutSeconds).toBe(300)
    }
  })

  it('accepts an explicit model when provided', () => {
    const result = spawnAgentSchema.safeParse({ ...validSpawn, model: 'sonnet' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBe('sonnet')
    }
  })

  it('rejects timeout below minimum (10)', () => {
    const result = spawnAgentSchema.safeParse({ ...validSpawn, timeoutSeconds: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects timeout above maximum (3600)', () => {
    const result = spawnAgentSchema.safeParse({ ...validSpawn, timeoutSeconds: 9999 })
    expect(result.success).toBe(false)
  })
})

describe('createUserSchema', () => {
  it('accepts valid input', () => {
    const result = createUserSchema.safeParse({
      username: 'alice',
      password: 'secure-pass-12chars',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.role).toBe('operator')
    }
  })

  it('rejects missing username', () => {
    const result = createUserSchema.safeParse({ password: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects missing password', () => {
    const result = createUserSchema.safeParse({ username: 'x' })
    expect(result.success).toBe(false)
  })
})

describe('qualityReviewSchema', () => {
  it('accepts valid input', () => {
    const result = qualityReviewSchema.safeParse({
      taskId: 1,
      status: 'approved',
      notes: 'Looks good',
    })
    expect(result.success).toBe(true)
  })

  it('accepts in_progress as a wait verdict', () => {
    const result = qualityReviewSchema.safeParse({
      taskId: 1,
      status: 'in_progress',
      notes: 'Agent is still working',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid status', () => {
    const result = qualityReviewSchema.safeParse({
      taskId: 1,
      status: 'pending',
      notes: 'N/A',
    })
    expect(result.success).toBe(false)
  })
})

describe('createPipelineSchema', () => {
  it('accepts valid input with 2+ steps', () => {
    const result = createPipelineSchema.safeParse({
      name: 'Deploy',
      steps: [
        { template_id: 1 },
        { template_id: 2 },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects fewer than 2 steps', () => {
    const result = createPipelineSchema.safeParse({
      name: 'Deploy',
      steps: [{ template_id: 1 }],
    })
    expect(result.success).toBe(false)
  })
})

describe('createWorkflowSchema', () => {
  it('accepts valid input', () => {
    const result = createWorkflowSchema.safeParse({
      name: 'Summarize',
      task_prompt: 'Summarize the document',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBe('sonnet')
    }
  })

  it('rejects missing name', () => {
    const result = createWorkflowSchema.safeParse({ task_prompt: 'Do it' })
    expect(result.success).toBe(false)
  })

  it('rejects missing task_prompt', () => {
    const result = createWorkflowSchema.safeParse({ name: 'W' })
    expect(result.success).toBe(false)
  })
})

describe('createMessageSchema', () => {
  it('accepts valid input', () => {
    const result = createMessageSchema.safeParse({
      to: 'bob',
      message: 'Hello',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.to).toBe('bob')
      expect(result.data.message).toBe('Hello')
    }
  })

  it('rejects missing to', () => {
    const result = createMessageSchema.safeParse({ message: 'Hi' })
    expect(result.success).toBe(false)
  })

  it('rejects missing message', () => {
    const result = createMessageSchema.safeParse({ to: 'bob' })
    expect(result.success).toBe(false)
  })
})
