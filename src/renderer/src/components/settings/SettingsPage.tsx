import { GeneralSection } from '@renderer/components/settings/GeneralSection'

export function SettingsPage(): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-8 py-12">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <GeneralSection />
      </div>
    </div>
  )
}
