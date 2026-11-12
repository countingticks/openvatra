/** core's errors are `{ "error": code, "message": text }`; anything else gets a generic message. */
export async function coreErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown } | null
    const message = body?.message
    if (typeof message === 'string' && message) return message.slice(0, 300)
  } catch {
    // not JSON: fall through
  }
  return `core answered with HTTP ${response.status}`
}
