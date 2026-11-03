import { useId } from 'react'
import { FileLocations } from '@renderer/components/settings/FileLocations'
import { SegmentedControl } from '@renderer/components/settings/SegmentedControl'
import { SettingRow } from '@renderer/components/settings/SettingRow'
import { Switch } from '@renderer/components/ui/switch'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import type { SettingsPatch } from '../../../../shared/settings'

const themeOptions = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
] as const

const motionOptions = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
] as const

const closeOptions = [
  { value: 'tray', label: 'Keep in tray' },
  { value: 'quit', label: 'Quit' }
] as const

/** The General settings: one row per setting, saved as soon as it changes. */
export function GeneralSection(): React.JSX.Element {
  const settings = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const change = (patch: SettingsPatch): void => {
    dispatch(settingsChanged(patch))
  }
  const ids = { theme: useId(), motion: useId(), startup: useId(), startupHint: useId(), close: useId() }

  return (
    <div className="flex flex-col">
      <SettingRow
        label="Theme"
        hint="System follows the light or dark mode set in Windows."
        labelId={ids.theme}
      >
        <SegmentedControl
          labelledBy={ids.theme}
          value={settings.theme}
          options={themeOptions}
          onChange={(theme) => change({ theme })}
        />
      </SettingRow>

      <SettingRow
        label="Animations"
        hint="Motion and effects across the app. System follows your Windows setting."
        labelId={ids.motion}
      >
        <SegmentedControl
          labelledBy={ids.motion}
          value={settings.motion}
          options={motionOptions}
          onChange={(motion) => change({ motion })}
        />
      </SettingRow>

      <SettingRow
        label="Start with Windows"
        hint="Starts in the tray when you sign in. Works in the installed app."
        controlId={ids.startup}
        hintId={ids.startupHint}
      >
        <Switch
          id={ids.startup}
          aria-describedby={ids.startupHint}
          checked={settings.startWithWindows}
          onCheckedChange={(checked) => change({ startWithWindows: checked })}
        />
      </SettingRow>

      <SettingRow
        label="When I close the window"
        hint="Keep running in the tray, or quit OpenVatra."
        labelId={ids.close}
      >
        <SegmentedControl
          labelledBy={ids.close}
          value={settings.closeAction}
          options={closeOptions}
          onChange={(closeAction) => change({ closeAction })}
        />
      </SettingRow>

      <FileLocations />
    </div>
  )
}
