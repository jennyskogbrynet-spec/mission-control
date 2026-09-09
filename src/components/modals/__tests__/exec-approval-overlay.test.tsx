import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('@/store', () => ({ useMissionControl: () => ({ execApprovals: [{ id: 'test', status: 'pending', command: 'echo test', risk: 'low', toolName: 'exec', sessionId: 'session', toolArgs: {} }], updateExecApproval: update }) }))
import { ExecApprovalOverlay } from '../exec-approval-overlay'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => update.mockReset())
describe('approval receipt UI', () => {
  it('keeps pending status until a successful gateway receipt arrives', async () => {
    let receipt: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { receipt = resolve })))
    render(<ExecApprovalOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(update).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sending...' })).toBeDisabled()
    await act(async () => receipt({ ok: true, json: async () => ({ ok: true }) }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('test', { status: 'approved' }))
  })
  it('shows a failure and leaves status pending when the gateway rejects it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Decision expired' }) }))
    render(<ExecApprovalOverlay />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await screen.findByText('Decision expired')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
})
