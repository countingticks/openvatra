import type { CoreState } from '@shared/core'
import type { Platform } from '@app/platform/platform'
import type { AppDispatch } from '@app/store/store'
import { connectionChanged } from './connectionSlice'

/** Keeps the connection slice in step with core's state, for as long as the window lives. */
export function followCoreState(core: Platform['core'], dispatch: AppDispatch): void {
  let received = false
  const apply = (state: CoreState): void => {
    dispatch(connectionChanged(state.status === 'ready' ? state.connection : null))
  }
  // Subscribe before asking: a push that lands while getState is in flight is newer than its answer.
  core.onState((state) => {
    received = true
    apply(state)
  })
  core
    .state()
    .then((state) => {
      if (!received) apply(state)
    })
    .catch((error) => console.error('Could not read the models service state', error))
}
