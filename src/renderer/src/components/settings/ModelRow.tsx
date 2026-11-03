import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { ModelOptionsForm } from '@renderer/components/settings/ModelOptionsForm'
import { Button } from '@renderer/components/ui/button'
import { formatSize } from '@renderer/lib/modelText'
import { cn } from '@renderer/lib/utils'
import type { ModelInfo } from '../../../../shared/core'
import type { ModelOptions } from '../../../../shared/settings'

interface ModelRowProps {
  model: ModelInfo
  options: ModelOptions | undefined
  onOptions: (next: ModelOptions | undefined) => void
  expanded: boolean
  onToggle: () => void
}

/** One model: name, size and its options, folded away by default. Running models is the popover's job. */
export function ModelRow({
  model,
  options,
  onOptions,
  expanded,
  onToggle
}: ModelRowProps): React.JSX.Element {
  const optionsId = useId()

  return (
    <li className="flex flex-col border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={model.id}>
          {model.id}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatSize(model.sizeBytes)}</span>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Options for ${model.id}`}
          aria-expanded={expanded}
          aria-controls={optionsId}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>

      {expanded && (
        <ModelOptionsForm
          id={optionsId}
          modelId={model.id}
          projector={model.projector}
          options={options}
          onChange={onOptions}
        />
      )}
    </li>
  )
}
