import { createAction } from '@reduxjs/toolkit'
import type { Event } from './generated'

/** One frame of core's event stream; each feature's sync listens for the types it owns. */
export const coreEvent = createAction<Event>('core/event')
