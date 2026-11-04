import { useCallback, useEffect, useState } from 'react'
import type { CatalogView, DownloadItem, HardwareReport } from '../../../shared/setup'
import { useCoreState } from './useCoreState'

interface SetupInfo {
  hardware: HardwareReport | null
  catalog: CatalogView | null
  downloads: DownloadItem[]
  /** Asks core for the catalog again (after a removal; finished downloads trigger it by themselves). */
  refreshCatalog: () => void
}

/**
 * What the welcome card needs: the PC's hardware, the catalog, and the live download queue. Null until answered.
 * Hardware and catalog come from core, so they are asked for only once core is ready, and again after every restart;
 * the last answer stays on screen in between.
 */
export function useSetup(): SetupInfo {
  const ready = useCoreState()?.status === 'ready'
  const [hardware, setHardware] = useState<HardwareReport | null>(null)
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [downloads, setDownloads] = useState<DownloadItem[] | null>(null)

  const readCatalog = useCallback(() => {
    window.api.setup
      .catalog()
      .then(setCatalog)
      .catch((error) => console.error('Could not read the model catalog', error))
  }, [])

  // The queue is main's own copy, so it can be read whatever core is doing.
  useEffect(() => {
    // Subscribe first (as useModels does), so a change during the first request isn't lost.
    const unsubscribe = window.api.setup.onDownloads(setDownloads)
    window.api.setup
      .downloads()
      .then((initial) => setDownloads((current) => current ?? initial))
      .catch((error) => console.error('Could not read the download list', error))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!ready) return
    window.api.setup
      .hardware()
      .then(setHardware)
      .catch((error) => console.error('Could not read the hardware report', error))
    readCatalog()
  }, [ready, readCatalog])

  // A download that finishes turns an entry into "installed", so the catalog has to be read again.
  const finished = (downloads ?? [])
    .filter((download) => download.state === 'done')
    .map((download) => download.id)
    .join()
  useEffect(() => {
    if (finished && ready) readCatalog()
  }, [finished, ready, readCatalog])

  return { hardware, catalog, downloads: downloads ?? [], refreshCatalog: readCatalog }
}
