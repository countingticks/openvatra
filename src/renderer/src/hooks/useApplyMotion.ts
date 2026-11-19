// Keeps <html data-motion> in step with Settings → Animations and Windows' preference, both live.
import { useEffect, useRef } from 'react'
import { usePrefersReducedMotion } from '@app/ui/usePrefersReducedMotion'
import { applyMotion, shouldReduceMotion } from '@app/ui/motion'
import { useAppSelector } from '@app/store/hooks'
import { selectSettings } from '@app/store/settingsSlice'

/** Longer than the segmented control's slide (200 ms), so the click that turns animations off still animates. */
const switchOffDelayMs = 250

export function useApplyMotion(): void {
  const setting = useAppSelector(selectSettings).motion
  const windowsReducesMotion = usePrefersReducedMotion()
  const applied = useRef(false)

  useEffect(() => {
    const reduce = shouldReduceMotion(setting, windowsReducesMotion)
    // Only a live change to "reduce" waits; the first apply (startup) and turning animations on don't.
    const wait = reduce && applied.current
    applied.current = true
    if (!wait) {
      applyMotion(reduce)
      return
    }
    const timer = setTimeout(() => applyMotion(reduce), switchOffDelayMs)
    return () => clearTimeout(timer)
  }, [setting, windowsReducesMotion])
}
