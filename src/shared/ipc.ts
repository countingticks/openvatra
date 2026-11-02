// The complete API the renderer may use, exposed by the preload as `window.api`.
// This file is the trust boundary: the UI can do exactly what is listed here and nothing else.
// Keep it small; every addition must be reviewed (see AGENTS.md, "Ask first").

export interface RuntimeInfo {
  /** Operating system, as Node reports it (e.g. 'win32'). */
  readonly platform: string
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
}

export interface Api {
  /** Static facts about the running app; safe to read, nothing to change. */
  readonly runtime: RuntimeInfo
}
