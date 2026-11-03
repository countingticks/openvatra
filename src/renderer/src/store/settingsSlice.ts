// The settings file's current values, for the Settings page. Changes show at once ("optimistic") and are then
// saved by the store's listener, which puts the saved result in place, or the old values back if saving failed.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { applyPatch, defaultSettings, type Settings, type SettingsPatch } from '../../../shared/settings'

export const settingsSlice = createSlice({
  name: 'settings',
  initialState: (): Settings => structuredClone(defaultSettings),
  reducers: {
    /** The user changed something: show it now; the listener saves it. */
    settingsChanged(state, action: PayloadAction<SettingsPatch>) {
      // The same merge main uses, so what the UI shows is what will be saved.
      return applyPatch(state, action.payload)
    },
    /** What main saved (or, after a failure, what was there before). */
    settingsReplaced(_state, action: PayloadAction<Settings>) {
      return action.payload
    }
  },
  selectors: {
    selectSettings: (state) => state
  }
})

export const { settingsChanged, settingsReplaced } = settingsSlice.actions
export const { selectSettings } = settingsSlice.selectors
