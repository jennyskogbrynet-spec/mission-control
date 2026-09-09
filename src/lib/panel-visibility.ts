/**
 * Installation-scoped hiding of navigation panels.
 *
 * Mission Control ships 32 panels because it is a general product. A given
 * installation uses a subset; the rest are confusion surface for the operator
 * and test surface for us. `MC_HIDDEN_PANELS` lets an installation say which
 * ones it does not use, without anyone deleting a panel another installation
 * still needs.
 *
 * The default is empty on purpose. A hard-coded default list would turn one
 * family's setup into every installation's behaviour; the recommended list for
 * THIS installation is documented in `docs/panels.md` and set via the
 * environment.
 *
 * Scope note: this hides panels from navigation only. Direct URLs still render,
 * because every panel lives behind one catch-all client route and turning an
 * unlisted id into a 404 there would also swallow plugin-provided panels. This
 * is a decluttering control, not an access control — `MC_HIDDEN_PANELS` must
 * never be used to keep an operator away from something they may not see.
 */

const SEPARATOR = ','

function normalizePanelId(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Parse the comma-separated `MC_HIDDEN_PANELS` value.
 *
 * Anything unparseable degrades to "hide nothing" rather than throwing: a typo
 * in an env var must not take the dashboard down.
 */
export function parseHiddenPanels(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string') return []

  const seen = new Set<string>()
  for (const segment of raw.split(SEPARATOR)) {
    const id = normalizePanelId(segment)
    if (id) seen.add(id)
  }
  return [...seen]
}

/**
 * Whether this panel id is hidden by configuration.
 *
 * An id in the list that matches no real panel is simply never asked about, so
 * unknown ids are ignored without needing a warning path of their own.
 */
export function isPanelHidden(
  panelId: string,
  hiddenPanels: readonly string[] | undefined,
): boolean {
  if (!hiddenPanels || hiddenPanels.length === 0) return false
  return hiddenPanels.includes(normalizePanelId(panelId))
}
