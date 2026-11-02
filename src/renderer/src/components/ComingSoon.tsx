interface ComingSoonProps {
  title: string
  description: string
}

/** Stands in for a tab whose module doesn't exist yet. */
export function ComingSoon({ title, description }: ComingSoonProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-sm text-muted-foreground">{description}</p>
    </div>
  )
}
