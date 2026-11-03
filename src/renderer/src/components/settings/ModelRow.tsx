import { useId, useState } from 'react'
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
}

/** One model: name, size and its options, folded away by default. Running models is the popover's job. */
export function ModelRow({ model, options, onOptions }: ModelRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const optionsId = useId()

  return (
    <li className="flex flex-col border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-[13px]" title={model.id}>
            {model.id}
          </span>
          <span className="text-xs text-muted-foreground">{formatSize(model.sizeBytes)}</span>
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Options for ${model.id}`}
          aria-expanded={expanded}
          aria-controls={optionsId}
          onClick={() => setExpanded((open) => !open)}
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
