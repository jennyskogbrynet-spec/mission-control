import { afterEach, describe, expect, it } from 'vitest'
import { parseHiddenPanels, isPanelHidden } from '../panel-visibility'

describe('parseHiddenPanels', () => {
  it('falls back to an empty list when nothing is configured', () => {
    expect(parseHiddenPanels(undefined)).toEqual([])
    expect(parseHiddenPanels('')).toEqual([])
    expect(parseHiddenPanels('   ')).toEqual([])
  })

  it('splits a comma-separated list and trims each id', () => {
    expect(parseHiddenPanels('webhooks, github ,super')).toEqual(['webhooks', 'github', 'super'])
  })

  it('lower-cases ids so casing in the env value cannot silently miss', () => {
    expect(parseHiddenPanels('WebHooks,GITHUB')).toEqual(['webhooks', 'github'])
  })

  it('drops empty segments from sloppy values', () => {
    expect(parseHiddenPanels('webhooks,,github,')).toEqual(['webhooks', 'github'])
  })

  it('de-duplicates repeated ids', () => {
    expect(parseHiddenPanels('webhooks,github,webhooks')).toEqual(['webhooks', 'github'])
  })

  it('accepts a value that is not a string without throwing', () => {
    expect(parseHiddenPanels(null as unknown as string)).toEqual([])
    expect(parseHiddenPanels(42 as unknown as string)).toEqual([])
  })
})

describe('isPanelHidden', () => {
  it('hides nothing when the flag is empty', () => {
    const hidden = parseHiddenPanels('')
    expect(isPanelHidden('webhooks', hidden)).toBe(false)
    expect(isPanelHidden('github', hidden)).toBe(false)
    expect(isPanelHidden('overview', hidden)).toBe(false)
  })

  it('hides exactly the configured ids and nothing else', () => {
    const hidden = parseHiddenPanels('webhooks,github')
    expect(isPanelHidden('webhooks', hidden)).toBe(true)
    expect(isPanelHidden('github', hidden)).toBe(true)
    expect(isPanelHidden('overview', hidden)).toBe(false)
  })

  it('ignores an unknown id in the flag instead of failing', () => {
    const hidden = parseHiddenPanels('webhooks,not-a-real-panel')
    expect(isPanelHidden('webhooks', hidden)).toBe(true)
    expect(isPanelHidden('not-a-real-panel', hidden)).toBe(true)
    expect(isPanelHidden('overview', hidden)).toBe(false)
  })

  it('matches case-insensitively on the panel id being checked', () => {
    const hidden = parseHiddenPanels('webhooks')
    expect(isPanelHidden('WEBHOOKS', hidden)).toBe(true)
  })

  it('treats a missing hidden list as hiding nothing', () => {
    expect(isPanelHidden('webhooks', undefined)).toBe(false)
  })
})

describe('the MC_HIDDEN_PANELS contract as the status route reads it', () => {
  const original = process.env.MC_HIDDEN_PANELS
  afterEach(() => {
    if (original === undefined) delete process.env.MC_HIDDEN_PANELS
    else process.env.MC_HIDDEN_PANELS = original
  })

  it('hides nothing when the variable is not set at all', () => {
    delete process.env.MC_HIDDEN_PANELS
    const hidden = parseHiddenPanels(process.env.MC_HIDDEN_PANELS)
    expect(hidden).toEqual([])
    expect(isPanelHidden('webhooks', hidden)).toBe(false)
  })

  it('hides exactly the documented default list for this installation', () => {
    process.env.MC_HIDDEN_PANELS = 'webhooks,github,super,integrations'
    const hidden = parseHiddenPanels(process.env.MC_HIDDEN_PANELS)
    for (const id of ['webhooks', 'github', 'super', 'integrations']) {
      expect(isPanelHidden(id, hidden)).toBe(true)
    }
    for (const id of ['overview', 'tasks', 'agents', 'cost-tracker', 'settings']) {
      expect(isPanelHidden(id, hidden)).toBe(false)
    }
  })
})
