import { act, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { allTags, coreApi } from '@app/core/coreApi'
import { renderWithStore } from '../../renderWithStore'

const searches = (requests: { url: string }[]): number =>
  requests.filter((request) => new URL(request.url).pathname === '/api/hf/search').length

describe('coreApi', () => {
  it('does not refetch a Hugging Face search when every tag is invalidated', async () => {
    const { store, coreHttp } = renderWithStore(<div />)
    coreHttp.answer('/api/hf/search', { repos: [] })
    await waitFor(() => expect(store.getState().coreConnection).not.toBeNull())
    const subscription = store.dispatch(coreApi.endpoints.searchHf.initiate({ q: 'qwen' }))
    await subscription
    expect(searches(coreHttp.requests)).toBe(1)

    // A query that does provide a tag proves the invalidation ran: it is refetched, the search is not.
    const models = store.dispatch(coreApi.endpoints.listModels.initiate())
    await models
    const modelRequests = (): number =>
      coreHttp.requests.filter((request) => new URL(request.url).pathname === '/api/models').length
    const before = modelRequests()
    act(() => {
      store.dispatch(coreApi.util.invalidateTags([...allTags]))
    })
    await waitFor(() => expect(modelRequests()).toBeGreaterThan(before))

    expect(searches(coreHttp.requests)).toBe(1)
    subscription.unsubscribe()
    models.unsubscribe()
  })
})
