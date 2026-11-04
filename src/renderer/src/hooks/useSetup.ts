import { useCallback, useEffect, useState } from 'react'
import type { CatalogView, DownloadItem, HardwareReport } from '../../../shared/setup'

interface SetupInfo {
  hardware: HardwareReport | null
  catalog: CatalogView | null
  downloads: DownloadItem[]
  /** Asks core for the catalog again (after a removal; finished downloads trigger it by themselves). */
  refreshCatalog: () => void
}

/** What the welcome card needs: the PC's hardware, the catalog, and the live download queue. Null until answered. */
export function useSetup(): SetupInfo {
  const [hardware, setHardware] = useState<HardwareReport | null>(null)
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [downloads, setDownloads] = useState<DownloadItem[] | null>(null)

  const readCatalog = useCallback(() => {
    window.api.setup
      .catalog()
      .then(setCatalog)
      .catch((error) => console.error('Could not read the model catalog', error))
  }, [])

  useEffect(() => {
    // Subscribe first (as useModels does), so a change during the first request isn't lost.
    const unsubscribe = window.api.setup.onDownloads(setDownloads)
    const log = (what: string) => (error: unknown) => console.error(`Could not read the ${what}`, error)
    window.api.setup.hardware().then(setHardware).catch(log('hardware report'))
    readCatalog()
    window.api.setup
      .downloads()
      .then((initial) => setDownloads((current) => current ?? initial))
      .catch(log('download list'))
    return unsubscribe
  }, [readCatalog])

  // A download that finishes turns an entry into "installed", so the catalog has to be read again.
  const finished = (downloads ?? [])
    .filter((download) => download.state === 'done')
    .map((download) => download.id)
    .join()
  useEffect(() => {
    if (finished) readCatalog()
  }, [finished, readCatalog])

  return { hardware, catalog, downloads: downloads ?? [], refreshCatalog: readCatalog }
}
