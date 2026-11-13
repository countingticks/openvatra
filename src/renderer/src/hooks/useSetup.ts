import { useCallback, useEffect, useState } from 'react'
import type { CatalogView, DownloadItem, HardwareReport } from '../../../shared/setup'
import { selectConnection } from '../core/connectionSlice'
import { useListDownloadsQuery } from '../core/generated'
import { useAppSelector } from '../store/hooks'
import { useCoreState } from './useCoreState'

const noDownloads: DownloadItem[] = []

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
  const connection = useAppSelector(selectConnection)
  const { data: queue } = useListDownloadsQuery(undefined, { skip: connection === null })
  const downloads: DownloadItem[] = connection === null ? noDownloads : (queue?.items ?? noDownloads)

  const readCatalog = useCallback(() => {
    window.api.setup
      .catalog()
      .then(setCatalog)
      .catch((error) => console.error('Could not read the model catalog', error))
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
  const finished = downloads
    .filter((download) => download.state === 'done')
    .map((download) => download.id)
    .join()
  useEffect(() => {
    if (finished && ready) readCatalog()
  }, [finished, ready, readCatalog])

  return { hardware, catalog, downloads, refreshCatalog: readCatalog }
}
