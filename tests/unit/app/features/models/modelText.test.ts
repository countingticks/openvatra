import { describe, expect, it } from 'vitest'
import type { Choice } from '@app/core/generated'
import type { ModelInfo } from '@app/core/types'
import {
  failureReason,
  fitFacts,
  formatContext,
  modelDetail,
  shortContext,
  stateDot
} from '@app/features/models/modelText'

describe('failureReason', () => {
  it.each([
    [
      "core's message from its error body",
      { status: 409, data: { error: 'not_enough_space', message: 'Not enough free space.' } },
      'Not enough free space.'
    ],
    ['no connection to core', { status: 'CORE_UNAVAILABLE' }, 'The models service is not running'],
    [
      'a failed fetch',
      { status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' },
      'Could not reach the models service'
    ],
    [
      "an IPC error, without Electron's prefix",
      new Error("Error invoking remote method 'files:pick': Error: disk full"),
      'disk full'
    ],
    ['a plain string', 'something broke', 'something broke']
  ])('%s', (_case, error, expected) => {
    expect(failureReason(error)).toBe(expected)
  })
})

describe('formatContext', () => {
  it.each([
    [32768, '32K'],
    [262144, '256K'],
    [40000, '40,000']
  ])('writes %i as %s', (tokens, text) => {
    expect(formatContext(tokens)).toBe(text)
  })
})

describe('shortContext', () => {
  it.each([
    [32768, '32k'],
    [50000, '50,000']
  ])('writes %i as %s', (tokens, text) => {
    expect(shortContext(tokens)).toBe(text)
  })
})

describe('fitFacts', () => {
  const GB = 1024 ** 3
  const choice: Choice = {
    context: 32768,
    capped: false,
    fit: 'fits',
    placement: 'gpu',
    ramBytes: 2 * GB,
    vramBytes: 6 * GB,
    tokensPerSecond: 0,
    source: 'estimate'
  }

  it.each<[string, Partial<Choice>, number | null, string]>([
    ['fits with the GPU total', {}, 8 * GB, '32K tokens · fits on your GPU (6.0 GB of 8.0 GB)'],
    ['fits without a hardware total', {}, null, '32K tokens · fits on your GPU (6.0 GB)'],
    [
      'slower with experts in RAM',
      { fit: 'slower', placement: 'experts' },
      8 * GB,
      '32K tokens · experts in RAM: slower · 6.0 GB GPU, 2.0 GB RAM'
    ],
    [
      'slower with some layers on the GPU',
      { fit: 'slower', placement: 'layers', layers: 20 },
      8 * GB,
      '32K tokens · 20 layers on the GPU: slower · 6.0 GB GPU, 2.0 GB RAM'
    ],
    [
      'slower on the CPU',
      { fit: 'slower', placement: 'cpu' },
      8 * GB,
      '32K tokens · CPU only: slower · 2.0 GB RAM'
    ],
    [
      'experts with the expert layers on the GPU, measured',
      {
        fit: 'slower',
        placement: 'experts',
        gpuExpertLayers: 16,
        expertLayers: 40,
        source: 'measured',
        tokensPerSecond: 34,
        vramBytes: 10.4 * GB,
        ramBytes: 12.8 * GB
      },
      12 * GB,
      '32K tokens · experts in RAM: slower · 10.4 GB GPU, 12.8 GB RAM · 16 of 40 expert layers on the GPU · measured · about 34 tokens per second'
    ],
    [
      'experts without the expert layers',
      { fit: 'slower', placement: 'experts', expertLayers: 40 },
      8 * GB,
      '32K tokens · experts in RAM: slower · 6.0 GB GPU, 2.0 GB RAM'
    ],
    [
      'gpu with both set',
      { gpuExpertLayers: 16, expertLayers: 40 },
      8 * GB,
      '32K tokens · fits on your GPU (6.0 GB of 8.0 GB)'
    ],
    [
      'everything on the GPU with experts',
      { placement: 'experts', gpuExpertLayers: 40, expertLayers: 40, source: 'measured', ramBytes: 0 },
      8 * GB,
      '32K tokens · fits on your GPU (6.0 GB of 8.0 GB) · 40 of 40 expert layers on the GPU · measured'
    ],
    ['too big', { fit: 'tooBig' }, 8 * GB, '32K tokens · too big for this PC · needs 6.0 GB GPU, 2.0 GB RAM'],
    [
      'too big on the CPU',
      { fit: 'tooBig', placement: 'cpu' },
      8 * GB,
      '32K tokens · too big for this PC · needs 2.0 GB RAM'
    ],
    ['unknown', { fit: 'unknown' }, 8 * GB, "32K tokens · memory use can't be estimated for this model"],
    [
      'measured, with its speed',
      { source: 'measured', tokensPerSecond: 23.6 },
      8 * GB,
      '32K tokens · fits on your GPU (6.0 GB of 8.0 GB) · measured · about 24 tokens per second'
    ],
    [
      'measured, with no speed',
      { source: 'measured' },
      8 * GB,
      '32K tokens · fits on your GPU (6.0 GB of 8.0 GB) · measured'
    ],
    [
      'an estimate with a speed under one',
      { fit: 'slower', placement: 'cpu', tokensPerSecond: 0.4 },
      8 * GB,
      '32K tokens · CPU only: slower · 2.0 GB RAM · about 1 token per second'
    ],
    [
      'unknown, measured and fast',
      { fit: 'unknown', source: 'measured', tokensPerSecond: 12 },
      8 * GB,
      "32K tokens · memory use can't be estimated for this model"
    ],
    [
      'the model maximum',
      { capped: true },
      8 * GB,
      "32K tokens (the model's maximum) · fits on your GPU (6.0 GB of 8.0 GB)"
    ]
  ])('says %s', (_name, change, total, text) => {
    expect(fitFacts({ ...choice, ...change }, total).detail).toBe(text)
  })

  it.each<[string, Partial<Choice>, number | null, string]>([
    ['fits with a total', { vramBytes: 6.1 * GB }, 12 * GB, '6.1 of 12.0 GB GPU'],
    ['fits under 1 GB of VRAM', { vramBytes: 512 * 1024 ** 2 }, 12 * GB, '512 MB of 12.0 GB GPU'],
    ['fits without a total', { vramBytes: 6.1 * GB }, null, '6.1 GB GPU'],
    [
      'slower with experts in RAM',
      { fit: 'slower', placement: 'experts', vramBytes: 4.2 * GB, ramBytes: 3 * GB },
      12 * GB,
      '4.2 GB GPU + 3.0 GB RAM'
    ],
    [
      'slower with layers on the GPU',
      { fit: 'slower', placement: 'layers', vramBytes: 4.2 * GB, ramBytes: 3 * GB },
      12 * GB,
      '4.2 GB GPU + 3.0 GB RAM'
    ],
    ['slower on the CPU', { fit: 'slower', placement: 'cpu', ramBytes: 3 * GB }, 12 * GB, '3.0 GB RAM'],
    [
      'too big',
      { fit: 'tooBig', vramBytes: 18 * GB, ramBytes: 4 * GB },
      12 * GB,
      'needs 18.0 GB GPU + 4.0 GB RAM'
    ],
    [
      'too big on the CPU',
      { fit: 'tooBig', placement: 'cpu', ramBytes: 4 * GB },
      12 * GB,
      'needs 4.0 GB RAM'
    ],
    ['unknown', { fit: 'unknown' }, 12 * GB, "Memory use can't be estimated"]
  ])('puts the facts of %s', (_name, change, total, facts) => {
    expect(fitFacts({ ...choice, ...change }, total).facts).toBe(facts)
  })

  it.each<[string, Partial<Choice>, string]>([
    ['an estimate', { tokensPerSecond: 41.6 }, '~42 tok/s'],
    ['a measurement', { tokensPerSecond: 42, source: 'measured' }, '42 tok/s'],
    ['a speed under one', { tokensPerSecond: 0.4 }, '~1 tok/s'],
    ['no speed', { tokensPerSecond: 0 }, ''],
    ['too big with a speed', { fit: 'tooBig', tokensPerSecond: 20 }, ''],
    ['unknown with a speed', { fit: 'unknown', tokensPerSecond: 20 }, '']
  ])('writes the speed of %s', (_name, change, speed) => {
    expect(fitFacts({ ...choice, ...change }, 8 * GB).speed).toBe(speed)
  })
})

describe('modelDetail', () => {
  const base: ModelInfo = {
    id: 'm',
    name: 'M',
    state: 'stopped',
    busy: false,
    sizeBytes: 5 * 1024 ** 3,
    kind: 'chat',
    moe: false,
    quant: 'Q4_K_M',
    tags: [],
    memory: null,
    context: { context: 32768 } as Choice
  }

  it.each([
    ['everything known', base, 'Q4_K_M · 5.0 GB · 32k context'],
    ['no quant', { ...base, quant: null }, '5.0 GB · 32k context'],
    ['no context choice', { ...base, context: null }, 'Q4_K_M · 5.0 GB']
  ])('%s', (_case, model, expected) => {
    expect(modelDetail(model)).toBe(expected)
  })
})

describe('stateDot', () => {
  it('fills with brand when ready, pulses when loading, and is hollow when stopped', () => {
    expect(stateDot('ready')).toContain('bg-brand')
    expect(stateDot('loading')).toContain('animate-pulse')
    expect(stateDot('stopped')).not.toContain('bg-')
    expect(stateDot('stopped')).toContain('ring')
  })
})
