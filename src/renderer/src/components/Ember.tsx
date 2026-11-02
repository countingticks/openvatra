import { useEffect, useMemo, useState } from 'react'
import { usePrefersReducedMotion } from '@renderer/hooks/usePrefersReducedMotion'
import { frameAt, mascotSize, playLength, toRuns, type MascotState } from '@renderer/mascot/animation'
import { loadAnimation } from '@renderer/mascot/loadAnimation'

interface EmberProps {
  state: MascotState
  /** Whole-number scale keeps every pixel the same size, so the art stays crisp. */
  scale?: 2 | 3
}

interface Playing {
  state: MascotState
  tick: number
}

/** Ember, the mascot: plays the frames of `state`, then whatever a one-shot (like success) hands over to. */
export function Ember({ state, scale = 2 }: EmberProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [playing, setPlaying] = useState<Playing>({ state, tick: 0 })
  const [requested, setRequested] = useState(state)

  // A new state from the parent restarts the animation. Done while rendering (React's pattern for state that
  // follows a prop), so the old state's frame is never drawn first.
  if (requested !== state) {
    setRequested(state)
    setPlaying({ state, tick: 0 })
  }

  const animation = loadAnimation(playing.state)

  useEffect(() => {
    const length = playLength(animation)
    const handOver = (): void => {
      if (animation.then) setPlaying({ state: animation.then, tick: 0 })
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
        if (tick < length) return { ...current, tick }
        return animation.then ? { state: animation.then, tick: 0 } : current
      })
    }, animation.ms)
    return () => clearInterval(timer)
  }, [animation, reducedMotion])

  const { frame } = frameAt(animation, reducedMotion ? 0 : playing.tick)
  const runs = useMemo(() => toRuns(frame, animation.palette), [frame, animation.palette])
  const size = mascotSize * scale

  return (
    <svg
      role="img"
      aria-label={`Ember, ${playing.state}`}
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
