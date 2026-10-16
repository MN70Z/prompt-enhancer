// The three enhancement strategies you can switch between with /enhance.
export type EnhanceStyle = 'polish' | 'clarify' | 'spec'

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': {
      // Whether every prompt is enhanced and sent automatically (/enhance auto).
      auto: boolean
      // Which strategy ++ uses (/enhance cycles; /enhance polish|clarify|spec sets).
      style: EnhanceStyle
    }
  }
}
