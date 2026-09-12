import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SkillAnalyticsPanel } from './skill-analytics-panel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('skill analytics panel', () => {
  it.each([
    ['invalid', 'Statistikkfilen er ugyldig. Generer et nytt gyldig øyeblikksbilde.'],
    ['error', 'Kunne ikke lese statistikk. Kontroller integrasjonen og prøv igjen.'],
  ])('shows sanitized %s integration state', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status, snapshot: null }) }))
    render(<SkillAnalyticsPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText('Ingen gyldig statistikkfil er konfigurert for dette arbeidsområdet.')).not.toBeInTheDocument()
  })
  it('shows honest coverage and supports search and numeric column sorting', async () => {
    const base = { origins: ['local'], status: ['installed_local'], categories: { document_read: 1 }, lastUse: null, days30: 2, days90: 2, sessions: 1, words: 20, bytes: 100, flags: [], proposal: 'Vurder' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ready', snapshot: { version: 1, workspaceId: 1, generatedAt: '2026-09-12T20:00:00Z', coverage: { status: 'partial', sources: ['codex'], limitations: ['Kun lokale spor'] }, skills: [
      { ...base, id: '1234567890abcdef', name: 'alpha', days7: 0 },
      { ...base, id: '2234567890abcdef', name: 'beta', days7: 3 },
      { ...base, id: '3234567890abcdef', name: 'gamma', days7: null },
    ] } }) }))
    render(<SkillAnalyticsPanel />)
    expect(await screen.findByText('Delvis')).toBeInTheDocument()
    expect(screen.getByText('Kun lokale spor')).toBeInTheDocument()
    const table = screen.getByRole('table')
    fireEvent.click(screen.getByRole('button', { name: '7 dager' }))
    fireEvent.click(screen.getByRole('button', { name: '7 dager ↑' }))
    const dataRows = within(table).getAllByRole('row').slice(1)
    expect(within(dataRows[0]).getByRole('rowheader')).toHaveTextContent('beta')
    expect(within(dataRows[2]).getByRole('rowheader')).toHaveTextContent('gamma')
    fireEvent.change(screen.getByRole('textbox', { name: 'Søk i skill-statistikk' }), { target: { value: 'alpha' } })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Søk i skill-statistikk' }), { target: { value: 'Skill-dokument lest' } })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
  })

  it('distinguishes missing workspace snapshot from transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'unavailable', snapshot: null }) }))
    render(<SkillAnalyticsPanel />)
    expect(await screen.findByText('Ingen gyldig statistikkfil er konfigurert for dette arbeidsområdet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Eksporter synlige rader (CSV)' })).toBeDisabled()
  })
})
