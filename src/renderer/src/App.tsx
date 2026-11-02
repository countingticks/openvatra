import { Button } from '@renderer/components/ui/button'

export function App(): React.JSX.Element {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-2">
      <h1 className="text-3xl font-semibold tracking-tight">OpenVatra</h1>
      <p className="text-muted-foreground">Your AI&apos;s home hearth.</p>
      <Button className="mt-4">Get started</Button>
    </main>
  )
}
