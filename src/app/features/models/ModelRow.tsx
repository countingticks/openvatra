import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { ModelOptionsForm } from './ModelOptionsForm'
import { Button } from '@app/ui/button'
import { formatContext, formatSize } from './modelText'
import { cn } from '@app/lib/utils'
import type { ModelInfo } from '@app/core/types'
import type { ModelOptions } from '@app/core/generated'

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
        {model.context && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={`Loads with ${model.context.context.toLocaleString('en-US')} tokens of context`}
          >
            {formatContext(model.context.context)}
          </span>
        )}
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

      {/* Always mounted so it can animate shut: grid rows go 0fr <-> 1fr. While closed it is hidden from assistive
          technology and can't take focus (inert). */}
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out in-data-[motion=reduce]:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <ModelOptionsForm
            id={optionsId}
            model={model}
            options={options}
            expanded={expanded}
            onChange={onOptions}
          />
        </div>
      </div>
    </li>
  )
}
