import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { coreEvent } from '@app/core/events'
import type {
  Event,
  MessageStats,
  RunSnapshot,
  Transcript as Wire,
  TranscriptItem
} from '@app/core/generated'
import { runView, Transcript } from '@app/features/runs'
import { renderWithStore } from '../../../renderWithStore'

const stats = (overrides: Partial<MessageStats> = {}): MessageStats => ({
  promptTokens: 412,
  answerTokens: 286,
  exact: true,
  tokensPerSecond: 38.2,
  firstTokenMs: 100,
  durationMs: 7500,
  contextSize: 8192,
  reasoningMs: 0,
  ...overrides
})

const run = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: 'r1',
  chatId: 'c1',
  state: 'done',
  profile: 'chat',
  model: 'tiny',
  seq: 1,
  error: null,
  ...overrides
})

function transcript(items: TranscriptItem[], runs: RunSnapshot[] = [run()], active?: RunSnapshot): Wire {
  return {
    seq: 10,
    items,
    runs,
    activeRun: active ?? null,
    context: { used: 0, size: 0, parts: { system: 0, messages: 0, messageCount: 0, search: 0, files: 0 } }
  }
}

const input = (seq: number, text: string): TranscriptItem => ({
  kind: 'input',
  seq,
  runId: 'r1',
  time: 0,
  text
})

const answer = (seq: number, overrides: Partial<TranscriptItem> = {}): TranscriptItem => ({
  kind: 'answer',
  seq,
  runId: 'r1',
  time: 0,
  parts: [{ kind: 'text', text: 'An answer' }],
  stats: stats(),
  partial: false,
  ...overrides
})

const frame = (type: string, data: object, stream = 'run:r1'): Event =>
  ({ type, stream, v: 1, time: 0, data }) as Event

interface Shown extends ReturnType<typeof renderWithStore> {
  onContinue: Mock<(runId: string) => void>
  onOpenModelSettings: Mock<() => void>
  onRegenerate: Mock<() => void>
  onEdit: Mock<(text: string) => Promise<void>>
  /** Dispatches a core event and lets the next animation frame render it. */
  push(event: Event): void
}

function show(
  wire: Wire,
  options: { modelLoading?: boolean; onEdit?: Mock<(text: string) => Promise<void>> } = {}
): Shown {
  const onContinue = vi.fn<(runId: string) => void>()
  const onOpenModelSettings = vi.fn<() => void>()
  const onRegenerate = vi.fn<() => void>()
  const onEdit = options.onEdit ?? vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const rendered = renderWithStore(
    <Transcript
      view={runView(wire)}
      model="tiny"
      modelLoading={options.modelLoading ?? false}
      onContinue={onContinue}
      onOpenModelSettings={onOpenModelSettings}
      onRegenerate={onRegenerate}
      onEdit={onEdit}
    />
  )
  const push = (event: Event): void => {
    act(() => {
      rendered.store.dispatch(coreEvent(event))
    })
    act(() => vi.advanceTimersToNextFrame())
  }
  return { ...rendered, onContinue, onOpenModelSettings, onRegenerate, onEdit, push }
}

describe('Transcript', () => {
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the input as a bubble and the answer as markdown', () => {
    show(
      transcript([input(1, 'Make a list'), answer(2, { parts: [{ kind: 'text', text: '- one\n- two' }] })])
    )

    expect(screen.getByText('Make a list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two'])
  })

  it('marks a queued input', () => {
    show(transcript([input(1, 'A'), input(2, 'B')], [run({ state: 'running' })], run({ state: 'running' })))

    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('keeps the thinking collapsed until opened, labelled with its time', () => {
    show(
      transcript([
        input(1, 'Hi'),
        answer(2, {
          parts: [
            { kind: 'reasoning', text: 'Let me think' },
            { kind: 'text', text: 'Hello' }
          ],
          stats: stats({ reasoningMs: 12_000 })
        })
      ])
    )
    const disclosure = screen.getByRole('button', { name: 'Thought for 12 s' })

    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Let me think')).toBeNull()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Let me think')).toBeInTheDocument()
  })

  it('labels live reasoning "Thinking…", then the time it took once text arrives', () => {
    const { push } = show(
      transcript([input(1, 'Hi')], [run({ state: 'running' })], run({ state: 'running' }))
    )

    push(frame('reasoning.delta', { text: 'hmm', n: 1 }))
    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument()

    push(frame('message.delta', { text: 'Hello there', n: 2 }))
    expect(screen.getByRole('button', { name: /^Thought for \d+ s$/ })).toBeInTheDocument()
    expect(screen.getByText('Hello there')).toBeInTheDocument()
  })

  it('says why a live answer has not started: the lease, or the model loading', () => {
    const active = run({ state: 'queued' })
    const { push, unmount } = show(transcript([input(1, 'Hi')], [active], active))
    push(
      frame(
        'sched.state',
        { holder: 'r9', waiting: [{ runId: 'r1', time: 0, why: 'another chat is answering' }] },
        'system'
      )
    )
    expect(screen.getByText('Waiting: another chat is answering')).toBeInTheDocument()
    unmount()

    const running = run({ state: 'running' })
    show(transcript([input(1, 'Hi')], [running], running), { modelLoading: true })
    expect(screen.getByText('Loading tiny…')).toBeInTheDocument()
  })

  it('copies only the text of an answer', async () => {
    show(
      transcript([
        input(1, 'Hi'),
        answer(2, {
          parts: [
            { kind: 'reasoning', text: 'secret' },
            { kind: 'text', text: 'Hello ' },
            { kind: 'text', text: 'world' }
          ]
        })
      ])
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }))
    })

    expect(writeText).toHaveBeenCalledWith('Hello world')
  })

  it('shows the speed with the full stats line as its title, and nothing for no speed', () => {
    show(
      transcript([
        input(1, 'A'),
        answer(2),
        input(3, 'B'),
        answer(4, { stats: stats({ exact: false, tokensPerSecond: 0, durationMs: 1200 }) })
      ])
    )

    expect(screen.getByText('38 tok/s')).toHaveAttribute('title', '38 tok/s · 412 in · 286 out · 7.5 s')
    expect(screen.getAllByText(/tok\/s/)).toHaveLength(1)
  })

  it.each([
    ['the last idle answer', 'Copy answer', 4, ['Copy answer', 'Regenerate answer']],
    ['an earlier answer', 'Copy answer', 2, ['Copy answer']]
  ])('gives %s its actions', (_name, _first, seq, names) => {
    show(transcript([input(1, 'A'), answer(2), input(3, 'B'), answer(4)]))
    const copies = screen.getAllByRole('button', { name: 'Copy answer' })
    expect(copies).toHaveLength(2)
    const row = copies[seq === 4 ? 1 : 0].parentElement as HTMLElement
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(names)
    expect(within(row).getAllByText('38 tok/s')).toHaveLength(1)
  })

  it('gives the last idle input Edit and Copy, and an earlier input Copy only', () => {
    show(transcript([input(1, 'A'), answer(2), input(3, 'B'), answer(4)]))
    const rows = screen
      .getAllByRole('button', { name: 'Copy message' })
      .map((button) => button.parentElement as HTMLElement)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).queryByRole('button', { name: 'Edit message' })).toBeNull()
    expect(within(rows[1]).getByRole('button', { name: 'Edit message' })).toBeInTheDocument()
  })

  it('copies the input text and names the button Copied for 1.5 s', async () => {
    show(transcript([input(1, 'Hello there')]))
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    })
    expect(writeText).toHaveBeenCalledWith('Hello there')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
  })

  it('ends a stopped partial answer with "Stopped", but not a failed one', () => {
    const { unmount } = show(
      transcript([input(1, 'Hi'), answer(2, { partial: true })], [run({ state: 'stopped' })])
    )
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    unmount()

    show(
      transcript(
        [input(1, 'Hi'), answer(2, { partial: true, failed: true })],
        [run({ state: 'failed', error: { code: 'backend_failed', message: 'The model stopped answering.' } })]
      )
    )
    expect(screen.queryByText('Stopped')).toBeNull()
  })

  it('marks where earlier messages were summarised', () => {
    show(transcript([{ kind: 'summary', seq: 1, runId: 'r1', time: 0, text: 'SUMMARY' }, input(2, 'Hi')]))

    expect(screen.getByText('Earlier messages summarised')).toBeInTheDocument()
  })

  it('offers Continue for an interrupted run and model settings only for failures they fix', () => {
    const paused = run({ state: 'interrupted' })
    const first = show(transcript([input(1, 'Hi')], [paused], paused))
    expect(screen.getByText('Cut off when OpenVatra stopped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(first.onContinue).toHaveBeenCalledWith('r1')
    first.unmount()

    const loadFailed = show(
      transcript(
        [input(1, 'Hi')],
        [run({ state: 'failed', error: { code: 'model_load_failed', message: 'The model could not load.' } })]
      )
    )
    expect(screen.getByText('The model could not load.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open model settings' }))
    expect(loadFailed.onOpenModelSettings).toHaveBeenCalled()
    loadFailed.unmount()

    show(
      transcript(
        [input(1, 'Hi')],
        [run({ state: 'failed', error: { code: 'backend_failed', message: 'The model stopped answering.' } })]
      )
    )
    expect(screen.getByText('The model stopped answering.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open model settings' })).toBeNull()
  })

  it('offers Regenerate under the last answer only, and not while a run is active', () => {
    const two = [input(1, 'A'), answer(2), input(3, 'B'), answer(4)]
    const idle = show(transcript(two))
    expect(screen.getAllByRole('button', { name: 'Regenerate answer' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate answer' }))
    expect(idle.onRegenerate).toHaveBeenCalled()
    idle.unmount()

    const running = run({ state: 'running' })
    show(transcript([...two, input(5, 'C')], [running], running))
    expect(screen.queryByRole('button', { name: 'Regenerate answer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
  })

  it('offers Retry, not Regenerate, for a failed last turn', () => {
    const failed = show(
      transcript(
        [input(1, 'Hi'), answer(2, { partial: true, failed: true })],
        [run({ state: 'failed', error: { code: 'backend_failed', message: 'The model stopped answering.' } })]
      )
    )

    expect(screen.queryByRole('button', { name: 'Regenerate answer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(failed.onRegenerate).toHaveBeenCalled()
  })

  describe('editing the last message', () => {
    const two = (): Wire => transcript([input(1, 'A'), answer(2), input(3, 'B'), answer(4)])
    const editor = (): HTMLElement => screen.getByRole('textbox', { name: 'Edit message' })

    it('offers Edit on the last input only, and Esc restores the bubble', () => {
      show(two())
      expect(screen.getAllByRole('button', { name: 'Edit message' })).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      expect(editor()).toHaveValue('B')
      expect(editor()).toHaveFocus()
      fireEvent.keyDown(editor(), { key: 'Escape' })

      expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull()
      expect(screen.getByText('B')).toBeInTheDocument()
    })

    it('sends the new text with Enter, closes on success, and sends nothing when empty', async () => {
      const shown = show(two())
      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))

      fireEvent.change(editor(), { target: { value: '  ' } })
      fireEvent.keyDown(editor(), { key: 'Enter' })
      expect(shown.onEdit).not.toHaveBeenCalled()

      fireEvent.change(editor(), { target: { value: 'B2' } })
      fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })
      expect(shown.onEdit).not.toHaveBeenCalled()
      fireEvent.keyDown(editor(), { key: 'Enter' })

      expect(shown.onEdit).toHaveBeenCalledWith('B2')
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull())
    })

    it('stays open with its text when sending fails', async () => {
      const onEdit = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('no'))
      show(two(), { onEdit })
      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      fireEvent.change(editor(), { target: { value: 'B2' } })

      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      await waitFor(() => expect(editor()).not.toBeDisabled())
      expect(editor()).toHaveValue('B2')
    })
  })
})
