import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { EnhanceStyle } from '../types'

const MARKER = '++'
const MIN_LENGTH = 3
const AUTO_KEY = 'prompt-enhancer/auto'
const STYLE_KEY = 'prompt-enhancer/style'
const STYLE_ORDER: readonly EnhanceStyle[] = ['polish', 'clarify', 'spec']
const DEFAULT_STYLE: EnhanceStyle = 'spec'

const autoAtom = atom({ plugin: 'prompt-enhancer', key: 'auto' } as const, false)
const styleAtom = atom({ plugin: 'prompt-enhancer', key: 'style' } as const, DEFAULT_STYLE)

// Each strategy is a system prompt plus a one-line blurb shown when you switch.
const STYLES: Record<EnhanceStyle, { blurb: string; system: string }> = {
  polish: {
    blurb: 'tightens wording, same information',
    system: [
      'You are a prompt editor for an AI coding agent (Claude Code).',
      "Rewrite the developer's instruction below into a clearer, more precise version.",
      '- Preserve intent exactly. Add no requirements, features, or scope.',
      '- Keep every file name, path, identifier, and command verbatim.',
      '- Be concise.',
      'Output ONLY the rewritten instruction. No preamble or commentary.',
    ].join('\n'),
  },
  clarify: {
    blurb: 'rewrite + the questions worth answering first',
    system: [
      'You are a prompt editor for an AI coding agent (Claude Code).',
      "Rewrite the developer's instruction below, then surface the gaps.",
      '- Preserve intent exactly. Add no requirements or scope.',
      '- Keep file names, paths, and identifiers verbatim.',
      'Output EXACTLY this shape and nothing else:',
      '<rewritten instruction>',
      '',
      'Before building, confirm:',
      '- <the question whose answer would most change the work>',
      '- <next most important question>',
      '(2 to 4 questions, most important first.)',
    ].join('\n'),
  },
  spec: {
    blurb: 'goal / assumptions / do / done-when',
    system: [
      'You turn a rough instruction into a scoped task for an AI coding agent (Claude Code).',
      "- Preserve the author's intent. Never invent requirements; label anything you infer as an assumption the author can correct.",
      '- Keep every file name, path, identifier, and command verbatim.',
      '- Do NOT ask the author any questions. Make reasonable assumptions and list them under Assumed instead.',
      "- Be concise; omit any section that doesn't apply.",
      'Output ONLY this shape:',
      'Goal: <one line>',
      'Assumed (correct me): <inferences, if any>',
      'Do: <concrete steps>',
      'Done when: <checkable acceptance criteria>',
    ].join('\n'),
  },
}

// Ask the fast model to rewrite `core` with `system`. Returns the rewrite, or null on failure.
async function enhance($: EngineInterface, core: string, system: string): Promise<string | null> {
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system,
      prompt: core,
      maxTokens: 1024,
      effort: 'low',
      timeoutMs: 15000,
    })
    if (!r.isAnswered) {
      return null
    }
    const out = r.text.trim()
    if (out === '' || out === core.trim()) {
      return null
    }
    return out
  } catch {
    return null
  }
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const auto = await read($, autoAtom)
  const style = await read($, styleAtom)
  $.ui.status(`⌁ ${style}${auto ? ' · auto' : ''}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const savedAuto = await $.store.get(AUTO_KEY)
    const savedStyle = await $.store.get(STYLE_KEY)
    const style: EnhanceStyle =
      savedStyle === 'polish' || savedStyle === 'clarify' || savedStyle === 'spec'
        ? savedStyle
        : DEFAULT_STYLE
    await update($, autoAtom, () => savedAuto === true)
    await update($, styleAtom, () => style)
    await refreshStatus($)

    await $.command.register({
      name: 'enhance',
      description: 'Cycle enhance style (polish|clarify|spec); /enhance auto toggles auto-send. End a prompt with ++ to enhance it.',
    })

    return next(e)
  })

  on('command.run', { command: 'enhance' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    let text: string

    if (arg === 'auto') {
      const now = !(await read($, autoAtom))
      await update($, autoAtom, () => now)
      await $.store.set(AUTO_KEY, now)
      text = now
        ? 'Auto-enhance ON — every prompt is rewritten and sent. /enhance auto again to turn off.'
        : 'Auto-enhance OFF — end a prompt with ++ to enhance just that one.'
    } else if (arg === 'polish' || arg === 'clarify' || arg === 'spec') {
      await update($, styleAtom, () => arg)
      await $.store.set(STYLE_KEY, arg)
      text = `Enhance style: ${arg} — ${STYLES[arg].blurb}.`
    } else if (arg === '' || arg === 'next') {
      const cur = await read($, styleAtom)
      const nextStyle = STYLE_ORDER[(STYLE_ORDER.indexOf(cur) + 1) % STYLE_ORDER.length] ?? DEFAULT_STYLE
      await update($, styleAtom, () => nextStyle)
      await $.store.set(STYLE_KEY, nextStyle)
      text = `Enhance style → ${nextStyle} — ${STYLES[nextStyle].blurb}. (styles: polish | clarify | spec · /enhance auto to auto-send · end a prompt with ++)`
    } else {
      text = 'Usage: /enhance (cycle style) · /enhance polish|clarify|spec · /enhance auto'
    }

    await refreshStatus($)
    $.ui.toast(`⌁ ${text.split(' —')[0]}`)

    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    const trimmedEnd = e.text.replace(/\s+$/, '')
    const hasMarker = trimmedEnd.endsWith(MARKER)
    const core = (hasMarker ? trimmedEnd.slice(0, -MARKER.length) : e.text).replace(/\s+$/, '')
    const auto = await read($, autoAtom)

    // Nothing opted in: leave the prompt exactly as typed.
    if (!hasMarker && !auto) {
      return next(e)
    }

    // Don't touch slash-commands, bash (!) escapes, or trivially short text.
    const probe = core.trim()
    if (probe.length < MIN_LENGTH || probe.startsWith('/') || probe.startsWith('!')) {
      return next({ ...e, text: core })
    }

    const style = await read($, styleAtom)
    // Explicit ++ with auto off => fill the composer for review. Otherwise send.
    const review = hasMarker && !auto

    $.ui.toast(`⌁ enhancing (${style})…`)
    const enhanced = await enhance($, core, STYLES[style].system)

    if (enhanced === null) {
      if (review) {
        await $.prompt.fill({ text: core, mode: 'replace' })
        $.ui.toast('⌁ couldn’t enhance — your text is back')
        return { drop: 'prompt-enhancer: enhance failed; original restored for review' }
      }
      $.ui.toast('⌁ couldn’t enhance — sent as-is')
      return next({ ...e, text: core })
    }

    if (review) {
      await $.prompt.fill({ text: enhanced, mode: 'replace' })
      $.ui.toast('⌁ enhanced — review & press Enter')
      return { drop: 'prompt-enhancer: enhanced prompt filled for review' }
    }

    $.ui.toast('⌁ enhanced & sent')
    return next({ ...e, text: enhanced })
  }).catch(($, e, next) => next(e))
}
