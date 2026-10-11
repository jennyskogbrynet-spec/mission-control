import { describe, expect, it } from 'vitest'
import { extractPrRefs, isPrKey, isPrListKey, parsePrValue, prKey } from '@/lib/pr-links'

describe('isPrKey', () => {
  it.each([
    'pr',
    'prNumber',
    'pr_number',
    'prUrl',
    'pr_url',
    'github_pr',
    'github_pr_url',
    'integration_base_pr',
    'implementation_pr',
    'featurePrNumber',
    'followupPullRequest',
    'pull_request',
    'pullRequestUrl',
  ])('%s names a pull request', (key) => expect(isPrKey(key)).toBe(true))

  it.each(['pr_count', 'express', 'headSha', 'candidateHeadSha', 'press', 'sprint', 'pr_state', 'proof_expected', 'pullback'])(
    '%s does not',
    (key) => expect(isPrKey(key)).toBe(false),
  )

  it('recognises list keys separately', () => {
    expect(isPrListKey('prs')).toBe(true)
    expect(isPrListKey('pull_requests')).toBe(true)
    expect(isPrListKey('pr')).toBe(false)
  })
})

describe('parsePrValue', () => {
  it('reads numbers, #numbers and numeric strings as bare PRs', () => {
    expect(parsePrValue(438)).toEqual({ repo: null, number: 438 })
    expect(parsePrValue('#438')).toEqual({ repo: null, number: 438 })
    expect(parsePrValue(' 438 ')).toEqual({ repo: null, number: 438 })
  })

  it('reads GitHub PR URLs and owner/repo#n, lower-casing the repo', () => {
    expect(parsePrValue('https://github.com/Jenny/Babysential/pull/497')).toEqual({ repo: 'jenny/babysential', number: 497 })
    expect(parsePrValue('https://github.com/a/b/pull/12/files')).toEqual({ repo: 'a/b', number: 12 })
    expect(parsePrValue('a/b#7')).toEqual({ repo: 'a/b', number: 7 })
  })

  it.each([0, -3, 1.5, 'merged', '', 'https://example.com/pull/3', 'https://github.com/a/b/issues/3', null, undefined, {}, true])(
    'rejects %s',
    (value) => expect(parsePrValue(value)).toBeNull(),
  )
})

describe('extractPrRefs', () => {
  it('merges the column, top-level keys and nested keys, deduplicated, with sources', () => {
    const refs = extractPrRefs(
      {
        github_pr_number: 438,
        metadata: {
          prUrl: 'https://github.com/o/r/pull/438',
          native_codex_review: { candidate: { prNumber: 438, headSha: 'abc' } },
          product_delivery: { prNumber: 458 },
          history: [{ pr_url: 'https://github.com/o/r/pull/435' }],
          unrelated: { count: 99, sha: 'deadbeef' },
        },
      },
      'o/r',
    )
    expect(refs.map((r) => [r.repo, r.number])).toEqual([
      ['o/r', 435],
      ['o/r', 438],
      ['o/r', 458],
    ])
    const pr438 = refs.find((r) => r.number === 438)!
    expect(pr438.sources).toEqual(expect.arrayContaining(['column', 'prUrl', 'native_codex_review.candidate.prNumber']))
  })

  it('does not take numbers from keys that merely contain "pr", nor from free text', () => {
    const refs = extractPrRefs({
      metadata: { pr_count: 5, express: 7, description: 'see PR #12 and https://github.com/o/r/pull/13', rsc_dropped_count: 3 },
    })
    expect(refs).toEqual([])
  })

  it('leaves a bare number unresolved when there is no default repo, and resolves it from a URL to the same number', () => {
    expect(extractPrRefs({ metadata: { pr: 531 } })).toEqual([{ repo: null, number: 531, sources: ['pr'] }])
    expect(extractPrRefs({ metadata: { pr: 531, github_pr_url: 'https://github.com/o/r/pull/531' } }).map((r) => r.repo)).toEqual(['o/r'])
    expect(extractPrRefs({ metadata: { pr: 531 } }, 'O/R')[0].repo).toBe('o/r')
  })

  it('accepts metadata as a JSON string and survives garbage', () => {
    expect(extractPrRefs({ metadata: '{"prNumber": 7}' }, 'o/r')).toHaveLength(1)
    expect(extractPrRefs({ metadata: '{not json' })).toEqual([])
    expect(extractPrRefs({ metadata: null })).toEqual([])
    expect(extractPrRefs({ metadata: '[1,2]' })).toEqual([])
  })

  it('reads list keys', () => {
    expect(extractPrRefs({ metadata: { prs: [1, 'https://github.com/o/r/pull/2', 'x'] } }, 'o/r').map((r) => r.number)).toEqual([1, 2])
  })

  it('uses github_repo with the column when it holds owner/repo', () => {
    expect(extractPrRefs({ github_pr_number: 9, github_repo: 'Org/Repo' })[0]).toEqual({ repo: 'org/repo', number: 9, sources: ['column'] })
  })

  it('is bounded on deeply nested input', () => {
    let deep: Record<string, unknown> = { prNumber: 1 }
    for (let i = 0; i < 40; i++) deep = { child: deep }
    expect(() => extractPrRefs({ metadata: deep }, 'o/r')).not.toThrow()
    expect(extractPrRefs({ metadata: deep }, 'o/r')).toEqual([])
  })
})

describe('prKey', () => {
  it('lower-cases the repo', () => expect(prKey('Jenny/Babysential', 5)).toBe('jenny/babysential#5'))
})
