import { Sidebar } from '@renderer/components/Sidebar'
import { TabView } from '@renderer/components/TabView'
import { useTabShortcuts } from '@renderer/hooks/useTabShortcuts'

export function App(): React.JSX.Element {
  useTabShortcuts()

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <TabView />
      </main>
    </div>
  )
}
