import { describe, expect, it } from 'vitest'
import { buildTaskPrompt, classifyDirectModel, resolveDispatchFailureStatus, resolveDispatchResourcePolicy, resolveGatewayAgentIdForReview, resolveTaskDispatchModelOverride } from '@/lib/task-dispatch'

describe('resolveTaskDispatchModelOverride', () => {
  it('returns null when the agent has no explicit dispatch model override', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: null })).toBeNull()
    expect(resolveTaskDispatchModelOverride({ agent_config: '{"openclawId":"main"}' })).toBeNull()
  })

  it('returns the explicit dispatch model override when present', () => {
    expect(
      resolveTaskDispatchModelOverride({
        agent_config: '{"openclawId":"main","dispatchModel":"openai-codex/gpt-5.4"}',
      })
    ).toBe('openai-codex/gpt-5.4')
  })

  it('ignores malformed agent config payloads', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: '{not json' })).toBeNull()
  })
})

describe('resolveGatewayAgentIdForReview', () => {
  it('uses the configured review fallback instead of the coordinator inbox alias', () => {
    const previous = process.env.MC_COORDINATOR_AGENT
    process.env.MC_COORDINATOR_AGENT = 'coordinator'

    try {
      expect(
        resolveGatewayAgentIdForReview({
          agent_config: null,
          assigned_to: null,
        }, 'vera')
      ).toBe('vera')
    } finally {
      if (previous === undefined) {
        delete process.env.MC_COORDINATOR_AGENT
      } else {
        process.env.MC_COORDINATOR_AGENT = previous
      }
    }
  })

  it('falls back to main when the task has no agent config, assignee, or configured review fallback', () => {
    const previous = process.env.MC_COORDINATOR_AGENT
    process.env.MC_COORDINATOR_AGENT = 'coordinator'

    try {
      expect(
        resolveGatewayAgentIdForReview({
          agent_config: null,
          assigned_to: null,
        }, null)
      ).toBe('main')
    } finally {
      if (previous === undefined) {
        delete process.env.MC_COORDINATOR_AGENT
      } else {
        process.env.MC_COORDINATOR_AGENT = previous
      }
    }
  })
})

describe('resolveDispatchResourcePolicy', () => {
  it('uses Kernel v2 resource policy from task metadata', () => {
    expect(resolveDispatchResourcePolicy({
      workflow_contract: {
        resource_policy: {
          lane: 'coding',
          run_timeout_seconds: 1800,
          max_retries: 1,
          stale_after_minutes: 90,
          rate_limit_key: 'coding',
          zombie_reaper: true,
        },
      },
    })).toEqual({
      lane: 'coding',
      timeoutMs: 1_800_000,
      maxRetries: 1,
      staleAfterMinutes: 90,
      rateLimitKey: 'coding',
      zombieReaper: true,
    })
  })

  it('falls back safely when resource policy is invalid', () => {
    const policy = resolveDispatchResourcePolicy({
      workflow_contract: {
        resource_policy: {
          lane: '',
          run_timeout_seconds: 5,
          max_retries: 999,
          stale_after_minutes: 0,
          zombie_reaper: false,
        },
      },
    })

    expect(policy.lane).toBe('default')
    expect(policy.maxRetries).toBe(5)
    expect(policy.staleAfterMinutes).toBe(10)
    expect(policy.zombieReaper).toBe(false)
    expect(policy.timeoutMs).toBeGreaterThanOrEqual(30_000)
  })
})

describe('resolveDispatchFailureStatus', () => {
  it('honors Kernel v2 max_retries instead of hardcoded retry count', () => {
    expect(resolveDispatchFailureStatus(0, { maxRetries: 1 })).toEqual({
      newAttempts: 1,
      terminal: true,
    })

    expect(resolveDispatchFailureStatus(0, { maxRetries: 5 })).toEqual({
      newAttempts: 1,
      terminal: false,
    })
  })
})

describe('classifyDirectModel', () => {
  it('does not automatically choose Haiku for routine delegated fallback work', () => {
    expect(
      classifyDirectModel({
        id: 1,
        title: 'Routine status check',
        description: 'quick health check and summarize result',
        priority: 'low',
        agent_config: null,
      })
    ).toBe('claude-sonnet-4-6')
  })

  it('still respects explicit dispatch model overrides', () => {
    expect(
      classifyDirectModel({
        id: 1,
        title: 'Routine status check',
        description: 'quick health check',
        priority: 'low',
        agent_config: '{"dispatchModel":"anthropic/claude-haiku-4-5"}',
      })
    ).toBe('claude-haiku-4-5')
  })
})

describe('buildTaskPrompt', () => {
  it('includes workflow contract fields when task metadata provides them', () => {
    const prompt = buildTaskPrompt({
      id: 42,
      title: 'Implement Agentic OS',
      description: 'Task body',
      status: 'assigned',
      priority: 'high',
      assigned_to: 'Reidar',
      workspace_id: 1,
      agent_name: 'Reidar',
      agent_id: 2,
      agent_config: null,
      ticket_prefix: 'INFRA',
      project_ticket_no: 7,
      project_id: 5,
      tags: ['code'],
      metadata: {
        workflow_contract: {
          workflow_template: 'code_fix',
          goal: 'Make MC dispatch safer',
          owner_agent: 'Reidar',
          required_skills: ['mission-control', 'approval-gates'],
          allowed_tools: ['read_files', 'run_tests'],
          context_pack_sources: ['task.description', 'vault.memory_search'],
          self_layer_sources: ['memory/today', 'vault/04-resources/learnings'],
          memory_tools: ['memory.recall', 'memory.update'],
          memory_context_types: {
            episodic: ['memory/today'],
            semantic: ['vault/04-resources/learnings'],
            procedural: ['skills/mission-control'],
          },
          capability_scopes: {
            run_tests: { read: ['repo'], write: ['test_artifacts'], approval_required: false },
          },
          resource_policy: {
            lane: 'coding',
            run_timeout_seconds: 1800,
            max_retries: 1,
            stale_after_minutes: 90,
            rate_limit_key: 'coding',
            zombie_reaper: true,
          },
          autonomy_level: 'auto',
          verify_required: true,
          proof_expected: 'vitest and typecheck pass',
          output_location: 'vault/report.md',
        },
      },
    })

    expect(prompt).toContain('## Mission Control Workflow Contract')
    expect(prompt).toContain('Workflow template: code_fix')
    expect(prompt).toContain('Goal: Make MC dispatch safer')
    expect(prompt).toContain('Required skills: mission-control, approval-gates')
    expect(prompt).toContain('Self layer sources: memory/today, vault/04-resources/learnings')
    expect(prompt).toContain('Memory tools: memory.recall, memory.update')
    expect(prompt).toContain('Memory context types: {"episodic":["memory/today"],"semantic":["vault/04-resources/learnings"],"procedural":["skills/mission-control"]}')
    expect(prompt).toContain('Capability scopes: {"run_tests":{"read":["repo"],"write":["test_artifacts"],"approval_required":false}}')
    expect(prompt).toContain('Resource policy: {"lane":"coding","run_timeout_seconds":1800')
    expect(prompt).toContain('Autonomy level: auto')
    expect(prompt).toContain('Proof expected: vitest and typecheck pass')
    expect(prompt).toContain('Stop rule:')
  })
})
