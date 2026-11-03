import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { AppFolder, FileLocations as Locations } from '../../../../shared/ipc'

const rows: { folder: AppFolder; label: string; path: (locations: Locations) => string }[] = [
  { folder: 'settings', label: 'Settings file', path: (locations) => locations.settingsFile },
  { folder: 'logs', label: 'Logs', path: (locations) => locations.logsFolder }
]

/** Where OpenVatra keeps its files, e.g. to attach the log to a bug report. Main decides the paths. */
export function FileLocations(): React.JSX.Element {
  const [locations, setLocations] = useState<Locations>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    let current = true
    window.api.files
      .locations()
      .then((found) => current && setLocations(found))
      .catch(() => current && setProblem('The file locations could not be read.'))
    // Ignore an answer that arrives after the page is gone.
    return () => {
      current = false
    }
  }, [])

  async function open(folder: AppFolder): Promise<void> {
    setProblem(undefined)
    try {
      await window.api.files.openFolder(folder)
    } catch {
      setProblem('That folder could not be opened.')
    }
  }

  return (
    <div className="flex flex-col gap-2.5 py-4">
      <span className="text-sm font-medium">File locations</span>
      <dl className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.folder} className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[12.5px] text-muted-foreground">{row.label}</dt>
              <dd className="font-mono text-xs break-all select-text">
                {locations ? row.path(locations) : '…'}
              </dd>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Open the ${row.label.toLowerCase()} folder`}
              onClick={() => void open(row.folder)}
            >
              <FolderOpen aria-hidden />
              Open folder
            </Button>
          </div>
        ))}
      </dl>
      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
