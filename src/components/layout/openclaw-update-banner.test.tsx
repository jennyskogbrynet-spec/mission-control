import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ info: {} as Record<string, unknown> }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/store', () => ({ useMissionControl: () => ({ openclawUpdate: state.info, dismissOpenclawUpdate: vi.fn(), setOpenclawUpdate: vi.fn() }) }))
import { OpenClawUpdateBanner } from './openclaw-update-banner'
afterEach(cleanup)

describe('OpenClaw update hold banner', () => {
  it('explains the hold and hides update/copy actions even if a stale canUpdate flag is true', () => {
    state.info = { installed: '2026.7.1-2', latest: '2026.9.2', releaseUrl: 'https://example.com', updateBlocked: true, updateBlockedReason: 'Scheduler regression #141633', canUpdate: true, updateCommand: 'old unsafe command' }
    render(<OpenClawUpdateBanner />)
    expect(screen.getByText('This release still needs compatibility checks. Your current version remains active.')).toBeTruthy()
    expect(screen.queryByText('Scheduler regression #141633')).toBeNull()
    expect(screen.queryByText('updateNow')).toBeNull()
    expect(screen.queryByText('copyCommand')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Scheduler regression #141633')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText('Scheduler regression #141633')).toBeNull()
  })
  it('shows update only when the server explicitly grants it', () => {
    state.info = { installed: '2026.7.1-2', latest: '2026.9.2', releaseUrl: 'https://example.com', updateBlocked: false, canUpdate: false, updateCommand: 'OC_BACKUP_FULL_SQLITE=1 bash ~/.openclaw/scripts/safe-openclaw-update.sh 2026.9.2' }
    render(<OpenClawUpdateBanner />)
    expect(screen.queryByText('updateNow')).toBeNull()
    expect(screen.getByText('copyCommand')).toBeTruthy()
  })
})
