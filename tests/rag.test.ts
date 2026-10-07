import { describe, expect, it, vi } from 'vitest'
import { decodeEvidenceSet, RagClient, RagClientError } from '../src/rag/client.js'
import type { EvidenceSet } from '../src/rag/contracts.js'
import { renderEvidenceSet } from '../src/rag/render.js'
import { ragTraceMetadata } from '../src/rag/trace.js'

function evidenceSet(): EvidenceSet {
  return {
    query: 'PRIVATE_USER_QUERY',
    mode: 'iterative',
    hits: [{
      evidenceId: 'E1', rank: 1, title: 'Source title', snippet: 'PRIVATE_SOURCE_SNIPPET',
      source: 'textbooks', sourceType: 'medical_reference', corpus: 'textbooks',
      sourceDocumentId: 'chapter-1', chunkId: '0', score: 0.91,
      retrievalQuery: 'PRIVATE_GENERATED_QUERY', retrievalQueries: ['PRIVATE_GENERATED_QUERY'],
      retrievalRound: 1, snippetTruncated: false,
    }],
    retrieval: {
      rounds: 2, generatedQueries: 2, uniqueDocuments: 1, candidateCount: 6,
      returnedEvidenceCount: 1, retrievalCalls: 4, plannerCalls: 2,
      retrievalLatencyMs: 12.5, plannerLatencyMs: 18, latencyMs: 32.5,
      estimatedContextTokens: 31, plannerModel: 'local-qwen', plannerPromptVersion: 'planner-v1',
      plannerInputTokens: 100, plannerOutputTokens: 20, generatedQueryHashes: ['abc123'],
      degraded: false,
    },
    corpusVersion: 'medtext-local-a1b2',
  }
}

describe('RAG contracts and rendering', () => {
  it('validates an EvidenceSet and preserves provenance while rejecting an answer field', () => {
    const decoded = decodeEvidenceSet(evidenceSet())
    expect(decoded.hits[0]).toMatchObject({ corpus: 'textbooks', sourceDocumentId: 'chapter-1', chunkId: '0' })
    expect(() => decodeEvidenceSet({ ...evidenceSet(), finalAnswer: 'not allowed' })).toThrow(RagClientError)
    expect(() => decodeEvidenceSet({ ...evidenceSet(), hits: [{ ...evidenceSet().hits[0], rank: 4 }] })).toThrow(RagClientError)
  })

  it('renders stable evidence identifiers and omits generated-query text', () => {
    const rendered = renderEvidenceSet(evidenceSet())
    expect(rendered).toContain('"evidenceId":"E1"')
    expect(rendered).toContain('"corpus":"textbooks"')
    expect(rendered).not.toContain('PRIVATE_GENERATED_QUERY')
    expect(rendered).toContain('PRIVATE_SOURCE_SNIPPET')
  })

  it('projects only RAG counters, hashes, and corpus version into metadata trace', () => {
    const metadata = ragTraceMetadata([{ type: 'text', text: renderEvidenceSet(evidenceSet()) }])
    expect(metadata).toMatchObject({
      ragMode: 'iterative', retrievalRounds: 2, generatedQueryCount: 2,
      candidateCount: 6, returnedEvidenceCount: 1, retrievalCalls: 4,
      plannerCalls: 2, retrievalLatencyMs: 12.5, plannerLatencyMs: 18, ragLatencyMs: 32.5,
      plannerInputTokens: 100, plannerOutputTokens: 20,
      corpusVersion: 'medtext-local-a1b2', generatedQueryHashes: ['abc123'],
    })
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_USER_QUERY')
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_GENERATED_QUERY')
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_SOURCE_SNIPPET')
  })
})

describe('RAG health-engine HTTP client', () => {
  it('sends a typed search request and validates an empty EvidenceSet', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ...evidenceSet(), hits: [], retrieval: { ...evidenceSet().retrieval, returnedEvidenceCount: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new RagClient({ baseUrl: 'http://127.0.0.1:8322', fetcher })
    const result = await client.search({ query: 'query', mode: 'single', topK: 1 })
    expect(result.hits).toEqual([])
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8322/v1/rag/search', expect.objectContaining({ method: 'POST' }))
  })

  it('maps unavailable service, backend response, invalid JSON, and timeout to typed failures', async () => {
    const unavailable = new RagClient({ fetcher: vi.fn().mockRejectedValue(new TypeError('network')) })
    await expect(unavailable.search({ query: 'query' })).rejects.toMatchObject({ kind: 'unavailable' })

    const backend = new RagClient({ fetcher: vi.fn(async () => new Response('', { status: 503 })) })
    await expect(backend.search({ query: 'query' })).rejects.toMatchObject({ kind: 'backend', status: 503 })

    const invalid = new RagClient({ fetcher: vi.fn(async () => new Response('{', { status: 200 })) })
    await expect(invalid.search({ query: 'query' })).rejects.toMatchObject({ kind: 'invalid_response' })

    const timeout = new RagClient({
      timeoutMs: 5,
      fetcher: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })),
    })
    await expect(timeout.search({ query: 'query' })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('propagates DSH cancellation and rejects non-loopback endpoints', async () => {
    const controller = new AbortController()
    const client = new RagClient({
      fetcher: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })),
    })
    const pending = client.search({ query: 'query' }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    expect(() => new RagClient({ baseUrl: 'https://example.org' })).toThrow(/loopback/)
  })
})
