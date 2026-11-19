import { useId } from 'react'
import { FileLocations } from './FileLocations'
import { SegmentedControl } from '@app/ui/SegmentedControl'
import { SettingRow } from './SettingRow'
import { Switch } from '@app/ui/switch'
import { usePlatform } from '@app/platform/usePlatform'
import { useAppDispatch, useAppSelector } from '@app/store/hooks'
import { selectSettings, settingsChanged } from '@app/store/settingsSlice'
import type { SettingsPatch } from '@shared/settings'

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
  const { files } = usePlatform()
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
        hint="Motion and effects in the app. System follows Windows."
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

      {files && <FileLocations />}
    </div>
  )
}
