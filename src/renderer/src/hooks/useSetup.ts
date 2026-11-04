import { useEffect, useState } from 'react'
import type { CatalogView, DownloadItem, HardwareReport } from '../../../shared/setup'

interface SetupInfo {
  hardware: HardwareReport | null
  catalog: CatalogView | null
  downloads: DownloadItem[]
}

/** What the welcome card needs: the PC's hardware, the catalog, and the live download queue. Null until answered. */
export function useSetup(): SetupInfo {
  const [hardware, setHardware] = useState<HardwareReport | null>(null)
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [downloads, setDownloads] = useState<DownloadItem[] | null>(null)

  useEffect(() => {
    // Subscribe first (as useModels does), so a change during the first request isn't lost.
    const unsubscribe = window.api.setup.onDownloads(setDownloads)
    const log = (what: string) => (error: unknown) => console.error(`Could not read the ${what}`, error)
    window.api.setup.hardware().then(setHardware).catch(log('hardware report'))
    window.api.setup.catalog().then(setCatalog).catch(log('model catalog'))
    window.api.setup
      .downloads()
      .then((initial) => setDownloads((current) => current ?? initial))
      .catch(log('download list'))
    return unsubscribe
  }, [])

  return { hardware, catalog, downloads: downloads ?? [] }
}
