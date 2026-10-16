import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const REWRITE = 'REWRITTEN: fix the null-pointer bug in parser.ts, add a regression test'
const ORIGIN = { kind: 'composer' } as const

function submit(text: string) {
  return { text, wait: false, origin: ORIGIN }
}

// Wire the bottoms every path needs and expose what the composer was filled with.
function harness(on: On, fillOk = true): () => string | null {
  mock.store(on)
  let filled: string | null = null
  // Op-events answer with a { value } envelope; hook events answer directly.
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: REWRITE,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }))
  on('prompt.fill', (_$, e) => {
    filled = e.text
    return { isFilled: fillOk }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return () => filled
}

test('++ enhances and fills the composer for review without sending', async ($, on) => {
  const filled = harness(on)

  const r = await $.prompt.submit(submit('fix the bug ++'))

  // The rewrite was placed in the composer, and the original submit was dropped.
  expect(filled()).toBe(REWRITE)
  expect(r.drop).toBeDefined()
  expect(r.text).toBeUndefined()
})

test('a plain prompt passes through untouched', async ($, on) => {
  const filled = harness(on)

  const r = await $.prompt.submit(submit('just a normal prompt'))

  expect(r.text).toBe('just a normal prompt')
  expect(filled()).toBeNull()
})

test('++ on a slash-command is not enhanced, only the marker is stripped', async ($, on) => {
  const filled = harness(on)

  const r = await $.prompt.submit(submit('/notes ++'))

  expect(r.text).toBe('/notes')
  expect(filled()).toBeNull()
})

test('a prompt ending in ++ with no space before it (C++) is left untouched', async ($, on) => {
  const filled = harness(on)

  const r = await $.prompt.submit(submit('how do I compile this in C++'))

  expect(r.text).toBe('how do I compile this in C++')
  expect(filled()).toBeNull()
})

test('a bare ++ is a no-op, not an empty prompt', async ($, on) => {
  const filled = harness(on)

  const r = await $.prompt.submit(submit('++'))

  expect(r.text).toBe('++')
  expect(filled()).toBeNull()
})

test('if the composer refuses the fill, the enhanced prompt is sent, not lost', async ($, on) => {
  harness(on, false)

  const r = await $.prompt.submit(submit('fix the bug ++'))

  expect(r.text).toBe(REWRITE)
  expect(r.drop).toBeUndefined()
})

function runEnhance($: Engine, args: string) {
  return $.command.run({
    command: 'enhance',
    args,
    origin: ORIGIN,
    presentation: { isFullscreen: false, columns: 80 },
  })
}

test('/enhance auto turns on auto mode: the next prompt is rewritten and sent', async ($, on) => {
  harness(on)

  await runEnhance($, 'auto')
  const r = await $.prompt.submit(submit('make the thing better'))

  // Auto mode sends the rewrite straight through (no review).
  expect(r.text).toBe(REWRITE)
})

test('/enhance switches strategy and reports it', async ($, on) => {
  harness(on)

  const set = await runEnhance($, 'clarify')
  expect(set.text).toContain('clarify')

  // A bare /enhance cycles to the next style.
  const cycled = await runEnhance($, '')
  expect(cycled.text).toContain('spec')
})
