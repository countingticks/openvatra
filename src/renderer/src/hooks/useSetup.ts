import { useCallback, useEffect, useMemo } from 'react'
import {
  parseCatalogView,
  type CatalogView,
  type DownloadItem,
  type HardwareReport
} from '../../../shared/setup'
import { selectConnection } from '../core/connectionSlice'
import { coreApi } from '../core/coreApi'
import { useGetCatalogQuery, useGetHardwareQuery, useListDownloadsQuery } from '../core/generated'
import { useAppDispatch, useAppSelector } from '../store/hooks'

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
 * All three come from core. While core restarts the last hardware and catalog answers stay on screen (RTK Query
 * keeps `data` through a failed refetch); the new connection reads them again.
 */
export function useSetup(): SetupInfo {
  const dispatch = useAppDispatch()
  const connection = useAppSelector(selectConnection)
  const { data: queue } = useListDownloadsQuery(undefined, { skip: connection === null })
  const { data: hardware } = useGetHardwareQuery()
  const { data: catalogAnswer } = useGetCatalogQuery()
  const downloads = connection === null ? noDownloads : (queue?.items ?? noDownloads)
  const catalog = useMemo(() => parseCatalogView(catalogAnswer), [catalogAnswer])

  const refreshCatalog = useCallback(() => {
    dispatch(coreApi.util.invalidateTags(['catalog']))
  }, [dispatch])

  // A download that finishes turns an entry into "installed", so the catalog has to be read again.
  const finished = downloads
    .filter((download) => download.state === 'done')
    .map((download) => download.id)
    .join()
  useEffect(() => {
    if (finished) refreshCatalog()
  }, [finished, refreshCatalog])

  return { hardware: hardware ?? null, catalog, downloads, refreshCatalog }
}
