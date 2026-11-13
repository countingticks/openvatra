import { emptyApi as api } from './emptyApi'
export const addTagTypes = [
  'catalog',
  'chats',
  'config',
  'downloads',
  'engines',
  'events',
  'hardware',
  'models',
  'version',
  'core'
] as const
const injectedRtkApi = api
  .enhanceEndpoints({
    addTagTypes
  })
  .injectEndpoints({
    endpoints: (build) => ({
      getCatalog: build.query<GetCatalogApiResponse, GetCatalogApiArg>({
        query: () => ({ url: `/api/catalog` }),
        providesTags: ['catalog']
      }),
      removeCatalogEntry: build.mutation<RemoveCatalogEntryApiResponse, RemoveCatalogEntryApiArg>({
        query: (queryArg) => ({ url: `/api/catalog/${queryArg.id}/remove`, method: 'POST' }),
        invalidatesTags: ['catalog']
      }),
      listChats: build.query<ListChatsApiResponse, ListChatsApiArg>({
        query: () => ({ url: `/api/chats` }),
        providesTags: ['chats']
      }),
      createChat: build.mutation<CreateChatApiResponse, CreateChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats`, method: 'POST', body: queryArg.createChat }),
        invalidatesTags: ['chats']
      }),
      deleteChat: build.mutation<DeleteChatApiResponse, DeleteChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${queryArg.id}`, method: 'DELETE' }),
        invalidatesTags: ['chats']
      }),
      getChat: build.query<GetChatApiResponse, GetChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${queryArg.id}` }),
        providesTags: ['chats']
      }),
      updateChat: build.mutation<UpdateChatApiResponse, UpdateChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${queryArg.id}`, method: 'PATCH', body: queryArg.body }),
        invalidatesTags: ['chats']
      }),
      exportChat: build.query<ExportChatApiResponse, ExportChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${queryArg.id}/export` }),
        providesTags: ['chats']
      }),
      getConfig: build.query<GetConfigApiResponse, GetConfigApiArg>({
        query: () => ({ url: `/api/config` }),
        providesTags: ['config']
      }),
      getConfigModels: build.query<GetConfigModelsApiResponse, GetConfigModelsApiArg>({
        query: () => ({ url: `/api/config/models` }),
        providesTags: ['config']
      }),
      putConfigModels: build.mutation<PutConfigModelsApiResponse, PutConfigModelsApiArg>({
        query: (queryArg) => ({ url: `/api/config/models`, method: 'PUT', body: queryArg.body }),
        invalidatesTags: ['config']
      }),
      listDownloads: build.query<ListDownloadsApiResponse, ListDownloadsApiArg>({
        query: () => ({ url: `/api/downloads` }),
        providesTags: ['downloads']
      }),
      startDownload: build.mutation<StartDownloadApiResponse, StartDownloadApiArg>({
        query: (queryArg) => ({ url: `/api/downloads`, method: 'POST', body: queryArg.startDownload }),
        invalidatesTags: ['downloads']
      }),
      cancelDownload: build.mutation<CancelDownloadApiResponse, CancelDownloadApiArg>({
        query: (queryArg) => ({ url: `/api/downloads/${queryArg.id}`, method: 'DELETE' }),
        invalidatesTags: ['downloads']
      }),
      resumeDownload: build.mutation<ResumeDownloadApiResponse, ResumeDownloadApiArg>({
        query: (queryArg) => ({ url: `/api/downloads/${queryArg.id}/resume`, method: 'POST' }),
        invalidatesTags: ['downloads']
      }),
      getEngines: build.query<GetEnginesApiResponse, GetEnginesApiArg>({
        query: () => ({ url: `/api/engines` }),
        providesTags: ['engines']
      }),
      streamEvents: build.query<StreamEventsApiResponse, StreamEventsApiArg>({
        query: (queryArg) => ({
          url: `/api/events`,
          params: {
            after: queryArg.after,
            stream: queryArg.stream,
            log: queryArg.log
          }
        }),
        providesTags: ['events']
      }),
      getHardware: build.query<GetHardwareApiResponse, GetHardwareApiArg>({
        query: () => ({ url: `/api/hardware` }),
        providesTags: ['hardware']
      }),
      refreshHardware: build.mutation<RefreshHardwareApiResponse, RefreshHardwareApiArg>({
        query: () => ({ url: `/api/hardware/refresh`, method: 'POST' }),
        invalidatesTags: ['hardware']
      }),
      listModels: build.query<ListModelsApiResponse, ListModelsApiArg>({
        query: () => ({ url: `/api/models` }),
        providesTags: ['models']
      }),
      refreshModels: build.mutation<RefreshModelsApiResponse, RefreshModelsApiArg>({
        query: () => ({ url: `/api/models/refresh`, method: 'POST' }),
        invalidatesTags: ['models']
      }),
      loadModel: build.mutation<LoadModelApiResponse, LoadModelApiArg>({
        query: (queryArg) => ({ url: `/api/models/${queryArg.id}/load`, method: 'POST' }),
        invalidatesTags: ['models']
      }),
      unloadModel: build.mutation<UnloadModelApiResponse, UnloadModelApiArg>({
        query: (queryArg) => ({ url: `/api/models/${queryArg.id}/unload`, method: 'POST' }),
        invalidatesTags: ['models']
      }),
      getVersion: build.query<GetVersionApiResponse, GetVersionApiArg>({
        query: () => ({ url: `/api/version` }),
        providesTags: ['version']
      }),
      health: build.query<HealthApiResponse, HealthApiArg>({
        query: () => ({ url: `/health` }),
        providesTags: ['core']
      })
    }),
    overrideExisting: false
  })
export { injectedRtkApi as generatedApi }
export type GetCatalogApiResponse = /** status 200 OK */ View
export type GetCatalogApiArg = void
export type RemoveCatalogEntryApiResponse = unknown
export type RemoveCatalogEntryApiArg = {
  id: string
}
export type ListChatsApiResponse = /** status 200 OK */ Chat[]
export type ListChatsApiArg = void
export type CreateChatApiResponse = /** status 201 Created */ Chat
export type CreateChatApiArg = {
  createChat: CreateChat
}
export type DeleteChatApiResponse = unknown
export type DeleteChatApiArg = {
  id: string
}
export type GetChatApiResponse = /** status 200 OK */ ChatWithMessages
export type GetChatApiArg = {
  id: string
}
export type UpdateChatApiResponse = /** status 200 OK */ Chat
export type UpdateChatApiArg = {
  id: string
  body: {
    model?: string | null
    title?: string | null
    webSearch?: boolean | null
  }
}
export type ExportChatApiResponse = /** status 200 OK */ string
export type ExportChatApiArg = {
  id: string
}
export type GetConfigApiResponse = /** status 200 OK */ ConfigAll
export type GetConfigApiArg = void
export type GetConfigModelsApiResponse = /** status 200 OK */ {
  effective?: ModelsEffective
  rev: number
  value: Models
}
export type GetConfigModelsApiArg = void
export type PutConfigModelsApiResponse = /** status 200 OK */ {
  effective?: ModelsEffective
  rev: number
  value: Models
}
export type PutConfigModelsApiArg = {
  body: {
    rev: number
    value: Models
  }
}
export type ListDownloadsApiResponse = /** status 200 OK */ DownloadsBody
export type ListDownloadsApiArg = void
export type StartDownloadApiResponse = /** status 202 Accepted */ StatusBody
export type StartDownloadApiArg = {
  startDownload: StartDownload
}
export type CancelDownloadApiResponse = /** status 202 Accepted */ StatusBody
export type CancelDownloadApiArg = {
  id: string
}
export type ResumeDownloadApiResponse = /** status 202 Accepted */ StatusBody
export type ResumeDownloadApiArg = {
  id: string
}
export type GetEnginesApiResponse = /** status 200 OK */ EnginesBody
export type GetEnginesApiArg = void
export type StreamEventsApiResponse = /** status 200 OK */ Hello | Event
export type StreamEventsApiArg = {
  after?: number | null
  stream?: string
  log?: string
}
export type GetHardwareApiResponse = /** status 200 OK */ Report
export type GetHardwareApiArg = void
export type RefreshHardwareApiResponse = /** status 200 OK */ Report
export type RefreshHardwareApiArg = void
export type ListModelsApiResponse = /** status 200 OK */ StateBody
export type ListModelsApiArg = void
export type RefreshModelsApiResponse = /** status 202 Accepted */ StatusBody
export type RefreshModelsApiArg = void
export type LoadModelApiResponse = /** status 200 OK */ StatusBody
export type LoadModelApiArg = {
  id: string
}
export type UnloadModelApiResponse = /** status 202 Accepted */ StatusBody
export type UnloadModelApiArg = {
  id: string
}
export type GetVersionApiResponse = /** status 200 OK */ VersionBody
export type GetVersionApiArg = void
export type HealthApiResponse = /** status 200 OK */ StatusBody
export type HealthApiArg = void
export type File = {
  name: string
  sha256: string
  sizeBytes: number
}
export type Item = {
  baseUrl?: string
  diskShortBytes: number
  files: File[]
  fit: 'fits' | 'slower' | 'tooBig'
  id: string
  installed: boolean
  licence: string
  name: string
  needsGB: number
  rank: number
  repo: string
  revision: string
  summary: string
  tags: string[]
}
export type View = {
  diskFreeBytes: number | null
  entries: Item[]
  recommended: string | null
}
export type ErrorBody = {
  /** 409 config_conflict only: the section as it is now */
  current?: any
  error: string
  message: string
}
export type Chat = {
  createdAt: number
  id: string
  model: string
  settings: any
  title: string
  titleSource: string
  updatedAt: number
  webSearch: boolean
}
export type CreateChat = {
  model: string
  webSearch?: boolean
}
export type Message = {
  chatId: string
  content: string
  createdAt: number
  error: string
  id: string
  model: string
  reasoning: string
  role: string
  stats: any
  status: string
}
export type ChatWithMessages = {
  chat: Chat
  messages: Message[]
}
export type SectionEntry = {
  effective?: any
  rev: number
  value: any
}
export type ConfigAll = {
  sections: {
    [key: string]: SectionEntry
  }
}
export type ModelsEffective = {
  llamaServerPath: string
  modelsDir: string
}
export type ModelOptions = {
  args?: string
}
export type Models = {
  embeddingModel: string | null
  engine: 'bundled' | 'cuda'
  idleUnloadMinutes: number | null
  llamaServerPath: string | null
  modelsDir: string | null
  options: {
    [key: string]: ModelOptions
  }
}
export type DownloadItem = {
  bytes: number
  error?: string
  id: string
  speed: number
  state: 'queued' | 'downloading' | 'verifying' | 'paused' | 'error' | 'done'
  total: number
}
export type DownloadsBody = {
  items: DownloadItem[]
}
export type StatusBody = {
  status: string
}
export type StartDownload = {
  catalogId?: string
  engine?: 'cuda'
}
export type BundledEngine = {
  /** release tag of the llama.cpp build shipped with the app; null when unreadable */
  tag: string | null
}
export type EnginesBody = {
  bundled: BundledEngine
  /** ready: installed for the pinned tag; stale: only an older one */
  cuda: 'none' | 'ready' | 'stale'
}
export type Hello = {
  head: number
  log: string
  reset: boolean
}
export type ConfigChanged = {
  rev: number
  section: string
}
export type ConfigChangedEvent = {
  data: ConfigChanged
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'config.changed'
  v: number
}
export type Model = {
  busy: boolean
  error?: string
  id: string
  kind: 'chat' | 'embedding' | 'unreadable'
  projector?: string
  sizeBytes: number
  state: 'stopped' | 'loading' | 'ready' | 'error'
}
export type StateBody = {
  models: Model[]
}
export type ModelStateEvent = {
  data: StateBody
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'model.state'
  v: number
}
export type DownloadProgressEvent = {
  data: DownloadsBody
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'download.progress'
  v: number
}
export type Event = ConfigChangedEvent | ModelStateEvent | DownloadProgressEvent
export type Gpu = {
  freeBytes: number
  name: string
  totalBytes: number
  vendor: string
}
export type Report = {
  error?: string
  gpu: Gpu | null
  ramBytes: number
}
export type VersionBody = {
  api: number
  version: string
}
export const {
  useGetCatalogQuery,
  useRemoveCatalogEntryMutation,
  useListChatsQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
  useGetChatQuery,
  useUpdateChatMutation,
  useExportChatQuery,
  useGetConfigQuery,
  useGetConfigModelsQuery,
  usePutConfigModelsMutation,
  useListDownloadsQuery,
  useStartDownloadMutation,
  useCancelDownloadMutation,
  useResumeDownloadMutation,
  useGetEnginesQuery,
  useStreamEventsQuery,
  useGetHardwareQuery,
  useRefreshHardwareMutation,
  useListModelsQuery,
  useRefreshModelsMutation,
  useLoadModelMutation,
  useUnloadModelMutation,
  useGetVersionQuery,
  useHealthQuery
} = injectedRtkApi
