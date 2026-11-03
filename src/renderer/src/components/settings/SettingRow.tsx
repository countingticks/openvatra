import { Label } from '@renderer/components/ui/label'

interface SettingRowProps {
  label: string
  hint: string
  /** The label's id, for controls that name themselves with aria-labelledby (radio groups). */
  labelId?: string
  /** The control's id, for controls a <label for> can point at (switches). */
  controlId?: string
  hintId?: string
  /** The control, shown on the right. */
  children: React.ReactNode
}

/** One setting: its label and a one-line hint on the left, the control on the right, a divider below. */
export function SettingRow({
  label,
  hint,
  labelId,
  controlId,
  hintId,
  children
}: SettingRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-5 border-b border-border py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        {controlId ? (
          <Label htmlFor={controlId} className="text-sm">
            {label}
          </Label>
        ) : (
          <span id={labelId} className="text-sm font-medium">
            {label}
          </span>
        )}
        <p id={hintId} className="text-[12.5px] text-muted-foreground">
          {hint}
        </p>
      </div>
      {children}
    </div>
  )
}
