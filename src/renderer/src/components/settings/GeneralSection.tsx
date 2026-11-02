import { useId } from 'react'
import { FileLocations } from '@renderer/components/settings/FileLocations'
import { Label } from '@renderer/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Switch } from '@renderer/components/ui/switch'
import { useAppDispatch, useAppSelector } from '@renderer/store/hooks'
import { selectSettings, settingsChanged } from '@renderer/store/settingsSlice'
import { closeActions, themes, type SettingsPatch } from '../../../../shared/settings'

const themeLabels: Record<(typeof themes)[number], string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark'
}

const closeActionLabels: Record<(typeof closeActions)[number], string> = {
  tray: 'Keep running in the tray',
  quit: 'Quit OpenVatra'
}

/** Radio groups report the chosen value as `unknown`; only accept one of ours. */
function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return options.includes(value as T)
}

export function GeneralSection(): React.JSX.Element {
  const settings = useAppSelector(selectSettings)
  const dispatch = useAppDispatch()
  const change = (patch: SettingsPatch): void => {
    dispatch(settingsChanged(patch))
  }
  const ids = { theme: useId(), startup: useId(), startupHint: useId(), close: useId() }

  return (
    <section aria-labelledby={`${ids.theme}-section`} className="flex flex-col gap-6">
      <h2 id={`${ids.theme}-section`} className="text-base font-semibold">
        General
      </h2>

      <div className="flex flex-col gap-3">
        <span id={ids.theme} className="font-medium">
          Theme
        </span>
        <RadioGroup
          aria-labelledby={ids.theme}
          value={settings.theme}
          onValueChange={(value) => isOneOf(themes, value) && change({ theme: value })}
          className="flex gap-6"
        >
          {themes.map((theme) => (
            <Label key={theme} className="font-normal">
              <RadioGroupItem value={theme} />
              {themeLabels[theme]}
            </Label>
          ))}
        </RadioGroup>
        <p className="text-muted-foreground">System follows the light or dark mode set in Windows.</p>
      </div>

      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.startup}>Start with Windows</Label>
          <p id={ids.startupHint} className="text-muted-foreground">
            OpenVatra starts in the tray when you sign in. Works in the installed app.
          </p>
        </div>
        <Switch
          id={ids.startup}
          aria-describedby={ids.startupHint}
          checked={settings.startWithWindows}
          onCheckedChange={(checked) => change({ startWithWindows: checked })}
        />
      </div>

      <div className="flex flex-col gap-3">
        <span id={ids.close} className="font-medium">
          When I close the window
        </span>
        <RadioGroup
          aria-labelledby={ids.close}
          value={settings.closeAction}
          onValueChange={(value) => isOneOf(closeActions, value) && change({ closeAction: value })}
        >
          {closeActions.map((action) => (
            <Label key={action} className="font-normal">
              <RadioGroupItem value={action} />
              {closeActionLabels[action]}
            </Label>
          ))}
        </RadioGroup>
      </div>

      <FileLocations />
    </section>
  )
}
