import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LlamaCppSettings } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import { coreWrites, fitQueries } from '../../../fakeCoreHttp'
import type { renderWithStore } from '../../../renderWithStore'
import { chosen, nomic, openModels, putValues, qwen, ready } from './openModelsSection'

type Rendered = Awaited<ReturnType<typeof openModels>>

const choice = (context: number): NonNullable<ModelInfo['context']> => ({
  context,
  capped: false,
  fit: 'fits',
  placement: 'gpu',
  ramBytes: 0,
  vramBytes: 1,
  tokensPerSecond: 0,
  source: 'estimate'
})

/** The writes that are about models, not the GPU card's refresh of the hardware numbers. */
const modelWrites = (rendered: Rendered): { method: string; path: string; body: unknown }[] =>
  coreWrites(rendered.coreHttp).filter((write) => write.path !== '/api/hardware/refresh')

/** Opens the options of one model and waits for core's answers the form starts from. */
async function openOptionsOf(
  model: ModelInfo,
  options: LlamaCppSettings['options'] = {},
  models: ModelInfo[] = [model, nomic],
  extra: NonNullable<Parameters<typeof renderWithStore>[2]> = {}
): Promise<Rendered & { group: HTMLElement }> {
  const rendered = await openModels({ ...chosen, options }, { coreState: ready, models, ...extra })
  // The arguments box starts from what core has, so wait for core's answer (its folder shows) first.
  await screen.findByText('D:\\models')
  const toggle = await screen.findByRole('button', { name: `Options for ${model.name}` })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return { ...rendered, group: screen.getByRole('group', { name: `Options for ${model.name}` }) }
}

describe('the installed list', () => {
  it('lists chat models, then embedding models, each by name, with no Load, Unload pill or description', async () => {
    const alpha: ModelInfo = { ...qwen, id: 'zzz-file', name: 'alpha model' }
    await openModels(chosen, { coreState: ready, models: [nomic, qwen, alpha] })

    await screen.findByRole('list', { name: 'Installed models' })
    expect(
      screen
        .getAllByRole('button', { name: /^Options for / })
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Options for alpha model', 'Options for Qwen3 8B', 'Options for nomic-embed'])
    expect(screen.queryByRole('button', { name: /^(Load|Unload)/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/^(Loaded|Not loaded)$/)).not.toBeInTheDocument()
  })

  it('shows a row’s tags, 32k for a chat model with a context choice, and its size; the file id is in title', async () => {
    const sized: ModelInfo = { ...qwen, tags: ['Code', 'MoE'], context: choice(32768) }
    await openModels(chosen, { coreState: ready, models: [sized, nomic] })

    const list = await screen.findByRole('list', { name: 'Installed models' })
    const name = within(list).getByTitle(sized.id)
    const row = name.closest('li') as HTMLElement
    expect(name).toHaveTextContent('Qwen3 8B')
    expect(within(row).getByText('Code')).toBeInTheDocument()
    expect(within(row).getByText('MoE')).toBeInTheDocument()
    expect(within(row).getByTitle('Loads with 32,768 tokens of context')).toHaveTextContent('32k')
    expect(within(row).getByText('5.0 GB')).toBeInTheDocument()
    // The embedding model has no context choice to show.
    expect(within(list).getAllByTitle(/^Loads with/)).toHaveLength(1)
  })

  it('has the dot’s state word in the row’s accessible text', async () => {
    await openModels(chosen, { coreState: ready, models: [{ ...qwen, state: 'ready' }] })

    const list = await screen.findByRole('list', { name: 'Installed models' })
    const row = within(list).getByTitle(qwen.id).closest('li') as HTMLElement
    expect(within(row).getByText('loaded')).toBeInTheDocument()
  })

  it('keeps one model’s options open at a time', async () => {
    await openModels(chosen, { coreState: ready, models: [qwen, nomic] })
    const first = await screen.findByRole('button', { name: `Options for ${qwen.name}` })
    const second = screen.getByRole('button', { name: `Options for ${nomic.name}` })

    fireEvent.click(first)
    fireEvent.click(second)

    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('group', { name: /^Options for / })).toHaveLength(1)
  })

  describe('the fit line', () => {
    it('shows "Slower" in the warning colour and the hint without its size', async () => {
      const rendered = await openModels(chosen, { coreState: ready, models: [qwen, nomic] })
      rendered.coreHttp.fit = {
        ...rendered.coreHttp.fit,
        fit: 'slower',
        placement: 'cpu',
        ramBytes: 6 * 1024 ** 3
      }
      await screen.findByText('D:\\models')
      fireEvent.click(await screen.findByRole('button', { name: `Options for ${qwen.name}` }))
      const group = screen.getByRole('group', { name: `Options for ${qwen.name}` })

      expect(await within(group).findByText('Slower')).toHaveClass('text-warning')
      expect(within(group).getByText('CPU only: slower · 6.0 GB RAM')).toBeInTheDocument()
      expect(within(group).queryByText(/tokens/)).not.toBeInTheDocument()
    })

    it('shows no word for an unknown fit, only the hint', async () => {
      const rendered = await openModels(chosen, { coreState: ready, models: [qwen, nomic] })
      rendered.coreHttp.fit = { ...rendered.coreHttp.fit, fit: 'unknown' }
      await screen.findByText('D:\\models')
      fireEvent.click(await screen.findByRole('button', { name: `Options for ${qwen.name}` }))
      const group = screen.getByRole('group', { name: `Options for ${qwen.name}` })

      expect(
        await within(group).findByText("memory use can't be estimated for this model")
      ).toBeInTheDocument()
      expect(within(group).queryByText(/^(Fits|Slower|Too big)$/)).not.toBeInTheDocument()
    })
  })

  describe('Unload and Reset to defaults', () => {
    it('shows Unload only for a ready model, and posts it', async () => {
      const loaded: ModelInfo = { ...qwen, state: 'ready' }
      const idle: ModelInfo = { ...qwen, id: 'idle-file', name: 'Idle model' }
      const rendered = await openModels(chosen, { coreState: ready, models: [loaded, idle] })

      fireEvent.click(await screen.findByRole('button', { name: `Options for ${idle.name}` }))
      expect(screen.queryByRole('button', { name: 'Unload' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: `Options for ${loaded.name}` }))
      fireEvent.click(await screen.findByRole('button', { name: 'Unload' }))

      await waitFor(() =>
        expect(modelWrites(rendered)).toEqual([
          { method: 'POST', path: `/api/models/${loaded.id}/unload`, body: undefined }
        ])
      )
    })

    it('disables Reset to defaults without options', async () => {
      const { group } = await openOptionsOf(qwen)

      expect(within(group).getByRole('button', { name: 'Reset to defaults' })).toBeDisabled()
    })

    it('removes only this model’s key', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen, {
        [qwen.id]: { args: '--jinja', context: 8192 },
        'nomic-embed': { args: '--other' }
      })

      fireEvent.click(within(group).getByRole('button', { name: 'Reset to defaults' }))

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({ 'nomic-embed': { args: '--other' } })
    })
  })

  describe('Extra arguments', () => {
    it('saves when the box loses focus, keeping other models’ options', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen, { 'nomic-embed': { args: '--jinja' } })
      const args = within(group).getByLabelText('Extra arguments')

      fireEvent.change(args, { target: { value: '  --temp 0.7 --alias "my qwen"\n' } })
      expect(putValues(coreHttp)).toEqual([])
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({
        'nomic-embed': { args: '--jinja' },
        [qwen.id]: { args: '--temp 0.7 --alias "my qwen"' }
      })
    })

    it('keeps the stored context and placement when the arguments change', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen, {
        [qwen.id]: { args: '--jinja', context: 8192, placement: 'cpu' }
      })
      const args = within(group).getByLabelText('Extra arguments')

      fireEvent.change(args, { target: { value: '--temp 0.7' } })
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({
        [qwen.id]: { args: '--temp 0.7', context: 8192, placement: 'cpu' }
      })
    })

    it('refuses a flag OpenVatra sets itself, and saves nothing', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen)
      const args = within(group).getByLabelText('Extra arguments')

      fireEvent.change(args, { target: { value: '--temp 0.7 --port 9000' } })
      fireEvent.blur(args)

      expect(args).toHaveAttribute('aria-invalid', 'true')
      expect(args).toHaveAccessibleDescription("--port is set by OpenVatra and can't be changed.")
      expect(putValues(coreHttp)).toEqual([])
    })

    it('refuses the size and placement flags, which OpenVatra sets itself', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen)
      const args = within(group).getByLabelText('Extra arguments')

      fireEvent.change(args, { target: { value: '-ngl 20' } })
      fireEvent.blur(args)

      expect(args).toHaveAttribute('aria-invalid', 'true')
      expect(args).toHaveAccessibleDescription("-ngl is set by OpenVatra and can't be changed.")
      expect(putValues(coreHttp)).toEqual([])
    })

    it('drops the model’s entry when the box is emptied', async () => {
      const { coreHttp, group } = await openOptionsOf(qwen, { [qwen.id]: { args: '--jinja' } })
      const args = within(group).getByLabelText('Extra arguments')
      expect(args).toHaveValue('--jinja')

      fireEvent.change(args, { target: { value: ' ' } })
      fireEvent.blur(args)

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({})
    })
  })

  describe('context size and placement', () => {
    const sized: ModelInfo = { ...qwen, context: choice(32768) }

    /** Picks an option of the open menu; Base UI selects on the pointer's release, not on a bare click. */
    async function choose(name: string): Promise<void> {
      const option = await screen.findByRole('option', { name })
      fireEvent.pointerDown(option)
      fireEvent.mouseDown(option)
      fireEvent.pointerUp(option)
      fireEvent.mouseUp(option)
      fireEvent.click(option)
    }

    describe('the hint', () => {
      it('asks core about Auto and shows the answer, and asks nothing for an embedding model', async () => {
        const { coreHttp, group } = await openOptionsOf(sized)

        expect(await within(group).findByText(/^fits on your GPU \(4\.0 GB of /)).toBeInTheDocument()
        expect(fitQueries(coreHttp)).toEqual([{ context: 'auto', placement: 'auto' }])

        fireEvent.click(screen.getByRole('button', { name: `Options for ${nomic.name}` }))
        await screen.findByRole('group', { name: `Options for ${nomic.name}` })
        expect(fitQueries(coreHttp)).toHaveLength(1)
      })

      it('asks about a typed size once, 300 ms after the last keystroke', async () => {
        const { coreHttp, group } = await openOptionsOf(sized, { [qwen.id]: { context: 40000 } })
        await within(group).findByText(/fits on your GPU/)
        const input = within(group).getByLabelText('Context size in tokens')
        const before = fitQueries(coreHttp).length

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          fireEvent.change(input, { target: { value: '6553' } })
          act(() => void vi.advanceTimersByTime(200))
          fireEvent.change(input, { target: { value: '65536' } })
          act(() => void vi.advanceTimersByTime(299))
          expect(fitQueries(coreHttp)).toHaveLength(before)
          act(() => void vi.advanceTimersByTime(1))
        } finally {
          vi.useRealTimers()
        }

        await waitFor(() => expect(fitQueries(coreHttp)).toHaveLength(before + 1))
        expect(fitQueries(coreHttp).at(-1)).toEqual({ context: '65536', placement: 'auto' })
      })

      it('asks at once when the placement changes', async () => {
        const { coreHttp, group } = await openOptionsOf(sized)
        await within(group).findByText(/fits on your GPU/)

        fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
        await choose('CPU only')

        await waitFor(() =>
          expect(fitQueries(coreHttp).at(-1)).toEqual({ context: 'auto', placement: 'cpu' })
        )
      })

      it('empties the hint while the new answer is missing, instead of keeping the old one', async () => {
        const { coreHttp, group } = await openOptionsOf(sized)
        await within(group).findByText(/fits on your GPU/)
        coreHttp.respond('GET', `/api/models/${qwen.id}/fit`, () => ({
          status: 500,
          body: { error: 'internal', message: 'no answer' }
        }))

        fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
        await choose('CPU only')

        await waitFor(() => expect(fitQueries(coreHttp).at(-1)?.placement).toBe('cpu'))
        await waitFor(() => expect(within(group).queryByText(/fits on your GPU/)).not.toBeInTheDocument())
      })
    })

    it('shows Auto for both on a chat model, and neither on an embedding model', async () => {
      const { group } = await openOptionsOf(sized)

      expect(within(group).getByRole('radio', { name: 'Auto' })).toBeChecked()
      expect(within(group).getByRole('combobox', { name: 'Placement' })).toHaveTextContent('Automatic')
      expect(within(group).queryByLabelText('Context size in tokens')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: `Options for ${nomic.name}` }))
      const embedding = screen.getByRole('group', { name: `Options for ${nomic.name}` })
      expect(within(embedding).queryByText('Context')).not.toBeInTheDocument()
      expect(within(embedding).queryByText('Placement')).not.toBeInTheDocument()
    })

    it('shows a stored preset on its segment, and any other size as Custom with the number', async () => {
      const preset = await openOptionsOf(sized, { [qwen.id]: { context: 32768 } })
      expect(within(preset.group).getByRole('radio', { name: '32k' })).toBeChecked()
      expect(within(preset.group).queryByLabelText('Context size in tokens')).not.toBeInTheDocument()
      preset.unmount()

      const other = await openOptionsOf(sized, { [qwen.id]: { context: 40000 } })
      expect(within(other.group).getByRole('radio', { name: 'Custom' })).toBeChecked()
      expect(within(other.group).getByLabelText('Context size in tokens')).toHaveValue('40000')
    })

    it('saves a preset size at once', async () => {
      const { coreHttp, group } = await openOptionsOf(sized)

      fireEvent.click(within(group).getByRole('radio', { name: '64k' }))

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { context: 65536 } })
    })

    it("starts Custom from the model's auto size and saves nothing until Enter", async () => {
      const { coreHttp, group } = await openOptionsOf(sized)

      fireEvent.click(within(group).getByRole('radio', { name: 'Custom' }))

      const input = await within(group).findByLabelText('Context size in tokens')
      expect(input).toHaveValue('32768')
      expect(putValues(coreHttp)).toEqual([])
      fireEvent.change(input, { target: { value: '131072' } })
      expect(putValues(coreHttp)).toEqual([])
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { context: 131072 } })
    })

    it('explains a size out of range, saves nothing, and Escape puts the stored size back', async () => {
      const { coreHttp, group } = await openOptionsOf(sized, { [qwen.id]: { context: 8192 } })
      const input = within(group).getByLabelText('Context size in tokens')

      fireEvent.change(input, { target: { value: '1000' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription('A whole number from 2048 to 1048576.')
      expect(putValues(coreHttp)).toEqual([])

      fireEvent.keyDown(input, { key: 'Escape' })
      expect(input).toHaveValue('8192')
      expect(input).not.toHaveAttribute('aria-invalid')
    })

    it('Auto drops the size and keeps the arguments', async () => {
      const { coreHttp, group } = await openOptionsOf(sized, {
        [qwen.id]: { args: '--jinja', context: 8192 }
      })

      fireEvent.click(within(group).getByRole('radio', { name: 'Auto' }))

      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { args: '--jinja' } })
    })

    it('offers experts on the CPU to a mixture-of-experts model and layers to the others', async () => {
      const optionLabels = (): (string | null)[] =>
        within(screen.getByRole('listbox'))
          .getAllByRole('option')
          .map((option) => option.querySelector('span')?.textContent ?? null)

      const plain = await openOptionsOf(sized)
      fireEvent.click(within(plain.group).getByRole('combobox', { name: 'Placement' }))
      await screen.findByRole('option', { name: 'CPU only' })
      expect(optionLabels()).toEqual([
        'Automatic',
        'All on the graphics card',
        'Some layers on the GPU',
        'CPU only'
      ])
      plain.unmount()

      const moe = await openOptionsOf({ ...sized, moe: true })
      fireEvent.click(within(moe.group).getByRole('combobox', { name: 'Placement' }))
      await screen.findByRole('option', { name: 'Experts on the CPU' })
      expect(optionLabels()).toEqual([
        'Automatic',
        'All on the graphics card',
        'Experts on the CPU',
        'CPU only'
      ])
      moe.unmount()

      const stored = await openOptionsOf({ ...sized, moe: true }, { [qwen.id]: { placement: 'layers' } })
      fireEvent.click(within(stored.group).getByRole('combobox', { name: 'Placement' }))
      expect(await screen.findByRole('option', { name: 'Some layers on the GPU' })).toBeInTheDocument()
    })

    it('saves a placement, and Automatic removes it', async () => {
      const { coreHttp, group } = await openOptionsOf(sized)

      fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
      await choose('CPU only')
      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(1))
      expect(putValues(coreHttp)[0]?.options).toEqual({ [qwen.id]: { placement: 'cpu' } })

      await waitFor(() =>
        expect(within(group).getByRole('combobox', { name: 'Placement' })).toHaveTextContent('CPU only')
      )
      fireEvent.click(within(group).getByRole('combobox', { name: 'Placement' }))
      await choose('Automatic')
      await waitFor(() => expect(putValues(coreHttp)).toHaveLength(2))
      expect(putValues(coreHttp)[1]?.options).toEqual({})
    })
  })

  describe('empty states', () => {
    it('says the service is starting', async () => {
      await openModels(chosen, { coreState: { status: 'starting' } })

      expect(screen.getByText('Starting the models service…')).toHaveAttribute('role', 'status')
    })

    it('shows the service problem instead of the list', async () => {
      await openModels({}, { coreState: { status: 'problem', reason: 'core exited (code 1)' } })

      expect(
        await screen.findByText('The models service has a problem: core exited (code 1)')
      ).toHaveAttribute('role', 'alert')
    })

    it('says when the folder has no models', async () => {
      await openModels(chosen, { coreState: ready })

      expect(await screen.findByText(/^No models found/)).toHaveAttribute('role', 'status')
    })
  })
})
