// Whether the app animates. One decision for the whole UI, made from Settings → Animations and Windows' own
// reduced-motion preference, and written onto <html data-motion="reduce" | "full">: CSS transitions key off the
// attribute, and components read it through useReducedMotion.
import type { Settings } from '../../shared/settings'

export const motionAttribute = 'data-motion'

/** 'off' never animates, 'on' always does, 'system' does what Windows asks. */
export function shouldReduceMotion(setting: Settings['motion'], windowsReducesMotion: boolean): boolean {
  if (setting === 'off') return true
  if (setting === 'on') return false
  return windowsReducesMotion
}

export function applyMotion(reduce: boolean, root: HTMLElement = document.documentElement): void {
  root.setAttribute(motionAttribute, reduce ? 'reduce' : 'full')
}
