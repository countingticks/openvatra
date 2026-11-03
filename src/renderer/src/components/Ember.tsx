import { useEffect, useState } from 'react'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import {
  composeFrame,
  mascotSize,
  nextBlinkTick,
  playLength,
  toRuns,
  type MascotState
} from '@renderer/mascot/animation'
import { loadAnimation, type Clip } from '@renderer/mascot/loadAnimation'

interface EmberProps {
  state: MascotState
  /** loading only: known progress 0–1. Leave out while unknown; at 1 the ready burst plays, then idle. */
  progress?: number
  /** Whole-number scale keeps every pixel the same size, so the art stays crisp. */
  scale?: 2 | 3
}

interface Playing {
  clip: Clip
  tick: number
  /** idle: the tick the next (or current) blink starts at. */
  blinkAt?: number
}

function start(clip: Clip): Playing {
  const { blink, ms } = loadAnimation(clip)
  return { clip, tick: 0, blinkAt: blink ? nextBlinkTick(0, ms) : undefined }
}

function label(clip: Clip, progress: number | undefined): string {
  if (clip === 'loading' && progress !== undefined) return `Ember, loading ${Math.round(progress * 100)}%`
  return `Ember, ${clip}`
}

/** Ember, the mascot: plays the frames of `state`, then whatever a one-shot (like success) hands over to. */
export function Ember({ state, progress, scale = 2 }: EmberProps): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const clip: Clip = state === 'loading' && progress !== undefined && progress >= 1 ? 'ready' : state
  const [playing, setPlaying] = useState<Playing>(() => start(clip))
  const [requested, setRequested] = useState(clip)

  // A new state from the parent restarts the animation. Done while rendering (React's pattern for state that
  // follows a prop), so the old state's frame is never drawn first. New progress alone doesn't restart it.
  if (requested !== clip) {
    setRequested(clip)
    setPlaying(start(clip))
  }

  const animation = loadAnimation(playing.clip)

  useEffect(() => {
    const length = playLength(animation)
    const handOver = (): void => {
      if (animation.then) setPlaying(start(animation.then))
    }

    // Reduced motion: hold the first frame, but still leave a one-shot when it would have ended.
    if (reducedMotion) {
      if (!Number.isFinite(length)) return
      const timer = setTimeout(handOver, length * animation.ms)
      return () => clearTimeout(timer)
    }

    const timer = setInterval(() => {
      setPlaying((current) => {
        const tick = current.tick + 1
        if (tick >= length) return animation.then ? start(animation.then) : current
        // Once a blink has played, pick a new random moment for the next one.
        const { blink } = animation
        const blinked = blink && current.blinkAt !== undefined && tick >= current.blinkAt + blink.steps.length
        return { ...current, tick, blinkAt: blinked ? nextBlinkTick(tick, animation.ms) : current.blinkAt }
      })
    }, animation.ms)
    return () => clearInterval(timer)
  }, [animation, reducedMotion])

  // Progress is information, not motion: it shows with reduced motion too. The blink doesn't.
  const loadingProgress = playing.clip === 'loading' ? progress : undefined
  const frame = reducedMotion
    ? composeFrame(animation, 0, { progress: loadingProgress })
    : composeFrame(animation, playing.tick, { blinkAt: playing.blinkAt, progress: loadingProgress })
  const runs = toRuns(frame, animation.palette)
  const size = mascotSize * scale

  return (
    <svg
      role="img"
      aria-label={label(playing.clip, loadingProgress)}
      width={size}
      height={size}
      viewBox={`0 0 ${mascotSize} ${mascotSize}`}
      shapeRendering="crispEdges"
    >
      {runs.map((run) => (
        <rect key={`${run.x},${run.y}`} x={run.x} y={run.y} width={run.width} height={1} fill={run.color} />
      ))}
    </svg>
  )
}
