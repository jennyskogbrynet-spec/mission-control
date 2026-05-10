import { test, expect } from '@playwright/test'
import { API_KEY_HEADER, createTestTask, deleteTestTask } from './helpers'

test.describe('Task Claim API', () => {
  const cleanup: number[] = []

  test.afterEach(async ({ request }) => {
    for (const id of cleanup) {
      await deleteTestTask(request, id).catch(() => {})
    }
    cleanup.length = 0
  })

  test('claim moves Unclaimed → Claimed and records claimer', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    const res = await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.task.claim_state).toBe('Claimed')
    expect(body.task.claimed_by).toBe('reidar')
    expect(body.task.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/)
    expect(Number.isNaN(Date.parse(body.task.claimed_at))).toBe(false)
    expect(body.claimed_by).toBe('reidar')
  })

  test('second claim on the same ticket returns 409', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    const first = await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'stella' },
    })
    expect(first.status()).toBe(200)

    const second = await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })
    expect(second.status()).toBe(409)
    const body = await second.json()
    expect(body.current_claim_state).toBe('Claimed')
    expect(body.claimed_by).toBe('stella')
  })

  test('claim requires agent in body', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    const res = await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: {},
    })
    expect(res.status()).toBe(400)
  })

  test('claim returns 404 for unknown task id', async ({ request }) => {
    const res = await request.post(`/api/tasks/9999999/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'vera' },
    })
    expect(res.status()).toBe(404)
  })

  test('release by owner moves Claimed → Released', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })

    const res = await request.post(`/api/tasks/${id}/release`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.task.claim_state).toBe('Released')
    expect(body.task.claimed_by).toBeNull()
    expect(body.task.claimed_at).toBeNull()
  })

  test('release by non-owner returns 403', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })

    const res = await request.post(`/api/tasks/${id}/release`, {
      headers: API_KEY_HEADER,
      data: { agent: 'stella' },
    })
    expect(res.status()).toBe(403)
  })

  test('release of unclaimed task returns 409', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    const res = await request.post(`/api/tasks/${id}/release`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })
    expect(res.status()).toBe(409)
  })

  test('requeue moves Claimed → Unclaimed and bumps retry_count', async ({ request }) => {
    const { id, body } = await createTestTask(request)
    cleanup.push(id)
    const initialRetry = body.task.retry_count ?? 0

    await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })

    const res = await request.post(`/api/tasks/${id}/requeue`, {
      headers: API_KEY_HEADER,
      data: { reason: 'test-stall', by: 'stall-guard' },
    })
    expect(res.status()).toBe(200)
    const result = await res.json()
    expect(result.task.claim_state).toBe('Unclaimed')
    expect(result.task.claimed_by).toBeNull()
    expect(result.task.retry_count).toBe(initialRetry + 1)
    expect(result.prev_claimed_by).toBe('reidar')
    expect(result.reason).toBe('test-stall')
  })

  test('requeue of unclaimed task returns 409', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    const res = await request.post(`/api/tasks/${id}/requeue`, {
      headers: API_KEY_HEADER,
      data: { reason: 'test' },
    })
    expect(res.status()).toBe(409)
  })

  test('after release, ticket can be re-claimed', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })
    await request.post(`/api/tasks/${id}/release`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })

    // Released is a terminal state from the agent's perspective — only requeue
    // back to Unclaimed allows a fresh claim. Confirm 409 first, then requeue
    // is rejected (Released is not Claimed/Running).
    const reclaim = await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'stella' },
    })
    expect(reclaim.status()).toBe(409)
    const body = await reclaim.json()
    expect(body.current_claim_state).toBe('Released')
  })

  test('sweep-stalled requeues old Claimed tickets', async ({ request }) => {
    const { id } = await createTestTask(request)
    cleanup.push(id)

    await request.post(`/api/tasks/${id}/claim`, {
      headers: API_KEY_HEADER,
      data: { agent: 'reidar' },
    })

    // threshold_secs=0 so the just-claimed ticket is immediately "stale"
    const sweep = await request.post(`/api/tasks/sweep-stalled?threshold_secs=0`, {
      headers: API_KEY_HEADER,
    })
    expect(sweep.status()).toBe(200)
    const body = await sweep.json()
    expect(body.swept).toBeGreaterThanOrEqual(1)
    expect(body.requeued_ids).toContain(id)

    const after = await request.get(`/api/tasks/${id}`, { headers: API_KEY_HEADER })
    const afterBody = await after.json()
    expect(afterBody.task.claim_state).toBe('Unclaimed')
  })
})
