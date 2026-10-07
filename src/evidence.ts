export interface EvidenceHit {
  evidenceId: string
  rank: number
  title: string
  snippet: string
  source: string
  sourceType: string
  score: number
}

export interface EvidenceResult {
  query: string
  hits: EvidenceHit[]
}

export interface EvidenceFixture {
  evidenceId: string
  title: string
  snippet: string
  keywords: string[]
}

export interface SearchInput {
  query: string
  topK?: number
}

export function validateSearchInput(input: unknown): SearchInput & { query: string; topK: number } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('arguments must be an object')
  }

  const candidate = input as Record<string, unknown>
  if (typeof candidate.query !== 'string' || candidate.query.trim().length === 0) {
    throw new TypeError('query must be a non-empty string after trimming')
  }

  const query = candidate.query.trim()
  const topK = candidate.topK === undefined ? 3 : candidate.topK
  if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > 10) {
    throw new RangeError('topK must be an integer between 1 and 10')
  }

  return { query, topK: topK as number }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function scoreFixture(query: string, fixture: EvidenceFixture): number {
  const normalizedQuery = normalize(query)
  const title = normalize(fixture.title)
  const snippet = normalize(fixture.snippet)
  const normalizedKeywords = fixture.keywords.map(normalize)
  const titleMatch = title.includes(normalizedQuery)
  const snippetMatch = snippet.includes(normalizedQuery)
  const keywordMatches = normalizedKeywords.filter(keyword =>
    normalizedQuery.includes(keyword) || keyword.includes(normalizedQuery),
  ).length

  return (titleMatch ? 3 : 0) + (snippetMatch ? 1 : 0) + keywordMatches
}

export function searchMedicalEvidence(
  input: unknown,
  fixtures: readonly EvidenceFixture[],
  signal?: AbortSignal,
): EvidenceResult {
  signal?.throwIfAborted()
  const { query, topK } = validateSearchInput(input)
  const ranked = fixtures
    .map(fixture => ({ fixture, score: scoreFixture(query, fixture) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => {
      const scoreOrder = right.score - left.score
      if (scoreOrder !== 0) return scoreOrder
      return left.fixture.evidenceId < right.fixture.evidenceId ? -1 : left.fixture.evidenceId > right.fixture.evidenceId ? 1 : 0
    })
    .slice(0, topK)

  signal?.throwIfAborted()
  return {
    query,
    hits: ranked.map(({ fixture, score }, index) => ({
      evidenceId: fixture.evidenceId,
      rank: index + 1,
      title: fixture.title,
      snippet: fixture.snippet,
      source: `fixture://${fixture.evidenceId}`,
      sourceType: 'synthetic_fixture',
      score,
    })),
  }
}
