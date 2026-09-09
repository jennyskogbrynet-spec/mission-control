import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ info: {} as Record<string, unknown> }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/store', () => ({ useMissionControl: () => ({ updateAvailable: state.info, dismissUpdate: vi.fn() }) }))
import { UpdateBanner } from './update-banner'
afterEach(cleanup)

describe('Mission Control managed release banner', () => {
  it('explains managed updates and keeps release notes available without an update action', () => {
    state.info = { latestVersion: '3.0.0', releaseUrl: 'https://example.com/release', managedRelease: true, managedUpdateReason: 'Updates are tested and installed together.' }
    render(<UpdateBanner />)
    expect(screen.getByText('Updates are tested and installed together.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'updateNow' })).toBeNull()
    expect(screen.getByRole('link', { name: 'viewRelease' })).toHaveAttribute('href', 'https://example.com/release')
  })
  it('preserves the upstream update action for unmanaged installations', () => {
    state.info = { latestVersion: '3.0.0', releaseUrl: 'https://example.com/release', managedRelease: false }
    render(<UpdateBanner />)
    expect(screen.getByRole('button', { name: 'updateNow' })).toBeTruthy()
  })
})
