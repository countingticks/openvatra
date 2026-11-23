import { describe, expect, it } from 'vitest'
import type { Choice } from '@app/core/generated'
import { failureReason, fitHint, formatContext } from '@app/features/models/modelText'

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

describe('fitHint', () => {
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
    expect(fitHint({ ...choice, ...change }, total)).toBe(text)
  })
})
