import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * Keeps one broken page from blanking the whole window: without it, an error while rendering unmounts everything,
 * sidebar included. A class because React only offers this for class components.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Main copies the page's console errors into main.log, so this ends up in the log file.
    console.error('A page failed to render', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong here</h1>
        <p className="max-w-sm text-muted-foreground">
          This page couldn&apos;t be shown. The other tabs still work, and the details are in the log file.
        </p>
        <Button variant="outline" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    )
  }
}
