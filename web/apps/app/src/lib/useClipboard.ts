import { useCallback, useState } from 'react'

/** How the last copy went; undefined before one, or once reset. */
export type CopyStatus = 'copied' | 'failed' | undefined

/**
 * Copies text and says whether it worked. Browsers have no clipboard on
 * plain HTTP other than localhost, which counts as a failure, so the person
 * can be told to copy by hand.
 */
export function useClipboard() {
  const [status, setStatus] = useState<CopyStatus>()
  const copy = useCallback(async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }, [])
  const reset = useCallback(() => setStatus(undefined), [])
  return { status, copy, reset }
}
