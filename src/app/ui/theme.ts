// Light or dark: main sets the mode (nativeTheme.themeSource, from Settings → Theme), and it reaches the page as
// `prefers-color-scheme`. This mirrors it onto the `dark` class the design tokens key off, live: switching in
// Settings, or Windows switching while Theme is System, restyles the window at once.
const darkQuery = '(prefers-color-scheme: dark)'

/** Starts following the colour scheme; returns a function that stops. */
export function followColorScheme(root: HTMLElement = document.documentElement): () => void {
  const media = window.matchMedia?.(darkQuery)
  const apply = (): void => {
    root.classList.toggle('dark', media?.matches ?? false)
  }
  apply()
  media?.addEventListener('change', apply)
  return () => media?.removeEventListener('change', apply)
}
