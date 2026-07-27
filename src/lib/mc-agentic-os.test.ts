import { describe, expect, it } from 'vitest'
import { normalizeTaskMetadata } from './mc-agentic-os'

describe('normalizeTaskMetadata', () => {
  it('adds a workflow contract and ontology hooks to new task metadata', () => {
    const metadata = normalizeTaskMetadata({}, {
      title: 'Implement MC workflow contract',
      description: 'Mission: INFRA\nTask: Add contract metadata',
      assigned_to: 'Reidar',
      priority: 'high',
      status: 'inbox',
      tags: ['code'],
    })

    expect(metadata.workflow_contract.goal).toBe('Implement MC workflow contract')
    expect(metadata.workflow_contract.owner_agent).toBe('Reidar')
    expect(metadata.workflow_contract.workflow_template).toBe('code_fix')
    expect(metadata.workflow_contract.autonomy_level).toBe('auto')
    expect(metadata.workflow_contract.required_skills).toEqual(['mission-control', 'approval-gates'])
    expect(metadata.workflow_contract.self_layer_sources).toContain('vault/04-resources/learnings')
    expect(metadata.workflow_contract.memory_tools).toEqual(['memory.recall', 'memory.navigate', 'memory.update'])
    expect(metadata.workflow_contract.memory_context_types.episodic).toContain('memory/today')
    expect(metadata.workflow_contract.capability_scopes.edit_files).toEqual({
      read: ['repo'],
      write: ['implementation_scope'],
      approval_required: false,
    })
    expect(metadata.workflow_contract.resource_policy).toMatchObject({
      lane: 'coding',
      run_timeout_seconds: 1800,
      zombie_reaper: true,
    })
    expect(metadata.workflow_contract.verify_required).toBe(true)
    expect(metadata.agentic_os.ontology).toBe('Mission -> Goal -> Ticket -> Agent Run -> Action -> Outcome -> Learning')
    expect(metadata.agentic_os.action_log).toEqual([])
  })

  it('preserves caller-provided workflow contract fields', () => {
    const metadata = normalizeTaskMetadata({
      workflow_contract: {
        goal: 'Ship approval-safe automation',
        autonomy_level: 'hard_approval',
        required_skills: ['approval-gates'],
        proof_expected: 'explicit go from Martin',
      },
    }, {
      title: 'Deploy automation',
      assigned_to: 'Ines',
      priority: 'medium',
      tags: ['deploy'],
    })

    expect(metadata.workflow_contract.goal).toBe('Ship approval-safe automation')
    expect(metadata.workflow_contract.autonomy_level).toBe('hard_approval')
    expect(metadata.workflow_contract.required_skills).toEqual(['approval-gates'])
    expect(metadata.workflow_contract.proof_expected).toBe('explicit go from Martin')
  })

  it('preserves caller-provided kernel policy overrides', () => {
    const metadata = normalizeTaskMetadata({
      workflow_contract: {
        workflow_template: 'research_to_prd',
        memory_tools: ['memory.recall'],
        memory_context_types: {
          semantic: ['vault/02-projects/custom'],
        },
        capability_scopes: {
          web_research: { read: ['approved_sources'], write: [] },
        },
        resource_policy: {
          lane: 'overnight',
          run_timeout_seconds: 2400,
          stale_after_minutes: 180,
        },
      },
    }, {
      title: 'Research Agent OS',
      tags: ['research'],
    })

    expect(metadata.workflow_contract.memory_tools).toEqual(['memory.recall'])
    expect(metadata.workflow_contract.memory_context_types.semantic).toEqual(['vault/02-projects/custom'])
    expect(metadata.workflow_contract.memory_context_types.episodic).toContain('memory/today')
    expect(metadata.workflow_contract.capability_scopes.web_research).toEqual({ read: ['approved_sources'], write: [] })
    expect(metadata.workflow_contract.resource_policy).toMatchObject({
      lane: 'overnight',
      run_timeout_seconds: 2400,
      stale_after_minutes: 180,
      rate_limit_key: 'research',
    })
  })

  it('infers research and QA workflow templates from task context', () => {
    expect(normalizeTaskMetadata({}, {
      title: 'Deep-learn Agentic OS videos into PRD',
      assigned_to: 'Stella',
      tags: ['research'],
    }).workflow_contract.workflow_template).toBe('research_to_prd')

    expect(normalizeTaskMetadata({}, {
      title: 'Review MC implementation',
      assigned_to: 'Vera',
      tags: ['qa'],
    }).workflow_contract.workflow_template).toBe('qa_review')
  })

  it('infers soft and hard approval from operational tags', () => {
    expect(normalizeTaskMetadata({}, {
      title: 'Schedule new cron',
      tags: ['cron'],
    }).workflow_contract.autonomy_level).toBe('soft_approval')

    expect(normalizeTaskMetadata({}, {
      title: 'Change auth configuration',
      tags: ['auth'],
    }).workflow_contract.autonomy_level).toBe('hard_approval')
  })
})
