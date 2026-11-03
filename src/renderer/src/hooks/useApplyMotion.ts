// Keeps <html data-motion> in step with Settings → Animations and Windows' preference, both live.
import { useEffect } from 'react'
import { usePrefersReducedMotion } from '@renderer/hooks/usePrefersReducedMotion'
import { applyMotion, shouldReduceMotion } from '@renderer/motion'
import { useAppSelector } from '@renderer/store/hooks'
import { selectSettings } from '@renderer/store/settingsSlice'

export function useApplyMotion(): void {
  const setting = useAppSelector(selectSettings).motion
  const windowsReducesMotion = usePrefersReducedMotion()

  useEffect(() => {
    applyMotion(shouldReduceMotion(setting, windowsReducesMotion))
  }, [setting, windowsReducesMotion])
}
