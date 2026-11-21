import { emptyApi as api } from './emptyApi'
export const addTagTypes = [
  'catalog',
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
      getConfig: build.query<GetConfigApiResponse, GetConfigApiArg>({
        query: () => ({ url: `/api/config` }),
        providesTags: ['config']
      }),
      getConfigChat: build.query<GetConfigChatApiResponse, GetConfigChatApiArg>({
        query: () => ({ url: `/api/config/chat` }),
        providesTags: ['config']
      }),
      putConfigChat: build.mutation<PutConfigChatApiResponse, PutConfigChatApiArg>({
        query: (queryArg) => ({ url: `/api/config/chat`, method: 'PUT', body: queryArg.body }),
        invalidatesTags: ['config']
      }),
      getConfigEngineLlamaserver: build.query<
        GetConfigEngineLlamaserverApiResponse,
        GetConfigEngineLlamaserverApiArg
      >({
        query: () => ({ url: `/api/config/engine.llamaserver` }),
        providesTags: ['config']
      }),
      putConfigEngineLlamaserver: build.mutation<
        PutConfigEngineLlamaserverApiResponse,
        PutConfigEngineLlamaserverApiArg
      >({
        query: (queryArg) => ({ url: `/api/config/engine.llamaserver`, method: 'PUT', body: queryArg.body }),
        invalidatesTags: ['config']
      }),
      getConfigProviderLlamacpp: build.query<
        GetConfigProviderLlamacppApiResponse,
        GetConfigProviderLlamacppApiArg
      >({
        query: () => ({ url: `/api/config/provider.llamacpp` }),
        providesTags: ['config']
      }),
      putConfigProviderLlamacpp: build.mutation<
        PutConfigProviderLlamacppApiResponse,
        PutConfigProviderLlamacppApiArg
      >({
        query: (queryArg) => ({ url: `/api/config/provider.llamacpp`, method: 'PUT', body: queryArg.body }),
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
      getModelFit: build.query<GetModelFitApiResponse, GetModelFitApiArg>({
        query: (queryArg) => ({
          url: `/api/models/${queryArg.id}/fit`,
          params: {
            context: queryArg.context,
            placement: queryArg.placement
          }
        }),
        providesTags: ['models']
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
export type GetConfigApiResponse = /** status 200 OK */ ConfigAll
export type GetConfigApiArg = void
export type GetConfigChatApiResponse = /** status 200 OK */ {
  rev: number
  value: Settings
}
export type GetConfigChatApiArg = void
export type PutConfigChatApiResponse = /** status 200 OK */ {
  rev: number
  value: Settings
}
export type PutConfigChatApiArg = {
  body: {
    rev: number
    value: Settings
  }
}
export type GetConfigEngineLlamaserverApiResponse = /** status 200 OK */ {
  effective?: LlamaServerEffective
  rev: number
  value: LlamaServerSettings
}
export type GetConfigEngineLlamaserverApiArg = void
export type PutConfigEngineLlamaserverApiResponse = /** status 200 OK */ {
  effective?: LlamaServerEffective
  rev: number
  value: LlamaServerSettings
}
export type PutConfigEngineLlamaserverApiArg = {
  body: {
    rev: number
    value: LlamaServerSettings
  }
}
export type GetConfigProviderLlamacppApiResponse = /** status 200 OK */ {
  effective?: LlamaCppEffective
  rev: number
  value: LlamaCppSettings
}
export type GetConfigProviderLlamacppApiArg = void
export type PutConfigProviderLlamacppApiResponse = /** status 200 OK */ {
  effective?: LlamaCppEffective
  rev: number
  value: LlamaCppSettings
}
export type PutConfigProviderLlamacppApiArg = {
  body: {
    rev: number
    value: LlamaCppSettings
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
export type GetModelFitApiResponse = /** status 200 OK */ Choice
export type GetModelFitApiArg = {
  id: string
  context?: string
  placement?: string
}
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
export type Settings = {
  lastModel: string | null
}
export type LlamaServerEffective = {
  path: string
}
export type LlamaServerSettings = {
  build: 'bundled' | 'cuda'
  path: string | null
}
export type LlamaCppEffective = {
  modelsDir: string
}
export type ModelOptions = {
  args?: string
  context?: number | null
  placement?: 'auto' | 'gpu' | 'experts' | 'layers' | 'cpu'
}
export type LlamaCppSettings = {
  embeddingModel: string | null
  idleUnloadMinutes: number | null
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
export type Choice = {
  capped: boolean
  context: number
  fit: 'fits' | 'slower' | 'tooBig' | 'unknown'
  layers?: number
  placement: 'gpu' | 'experts' | 'layers' | 'cpu'
  ramBytes: number
  source: 'estimate' | 'measured' | 'unknown'
  tokensPerSecond: number
  vramBytes: number
}
export type Model = {
  busy: boolean
  context: Choice | null
  error?: string
  id: string
  kind: 'chat' | 'embedding' | 'unreadable'
  moe: boolean
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
export type ChatCreated = {
  model: string
  profile: string
}
export type ChatCreatedEvent = {
  data: ChatCreated
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'chat.created'
  v: number
}
export type ChatTitled = {
  source: 'auto' | 'user'
  title: string
}
export type ChatTitledEvent = {
  data: ChatTitled
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'chat.titled'
  v: number
}
export type ChatModel = {
  model: string
}
export type ChatModelEvent = {
  data: ChatModel
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'chat.model'
  v: number
}
export type TurnRetracted = {
  runId: string
}
export type TurnRetractedEvent = {
  data: TurnRetracted
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'turn.retracted'
  v: number
}
export type ChatDeleted = {
  chatId: string
}
export type ChatDeletedEvent = {
  data: ChatDeleted
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'chat.deleted'
  v: number
}
export type RunQueued = {
  chatId: string
  model: string
  origin: 'user'
  profile: string
  requestId: string
}
export type RunQueuedEvent = {
  data: RunQueued
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'run.queued'
  v: number
}
export type InputReceived = {
  chatId: string
  requestId: string
  text: string
}
export type InputReceivedEvent = {
  data: InputReceived
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'input.received'
  v: number
}
export type RunStarted = {
  chatId: string
}
export type RunStartedEvent = {
  data: RunStarted
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'run.started'
  v: number
}
export type RunPaused = {
  chatId: string
  reason: 'interrupted'
}
export type RunPausedEvent = {
  data: RunPaused
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'run.paused'
  v: number
}
export type RunResumed = {
  chatId: string
}
export type RunResumedEvent = {
  data: RunResumed
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'run.resumed'
  v: number
}
export type RunError = {
  code: string
  message: string
}
export type RunFinished = {
  chatId: string
  error?: RunError | null
  state: 'done' | 'stopped' | 'failed'
}
export type RunFinishedEvent = {
  data: RunFinished
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'run.finished'
  v: number
}
export type MessageDelta = {
  n: number
  text: string
}
export type MessageDeltaEvent = {
  data: MessageDelta
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'message.delta'
  v: number
}
export type ReasoningDelta = {
  n: number
  text: string
}
export type ReasoningDeltaEvent = {
  data: ReasoningDelta
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'reasoning.delta'
  v: number
}
export type MessagePartial = {
  n: number
  reasoning: string
  text: string
}
export type MessagePartialEvent = {
  data: MessagePartial
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'message.partial'
  v: number
}
export type MessagePart = {
  kind: 'text' | 'reasoning'
  text: string
}
export type MessageStats = {
  answerTokens: number
  contextSize: number
  durationMs: number
  exact: boolean
  firstTokenMs: number
  promptTokens: number
  tokensPerSecond: number
}
export type MessageCompleted = {
  chatId: string
  model: string
  partial: boolean
  parts: MessagePart[]
  stats: MessageStats
}
export type MessageCompletedEvent = {
  data: MessageCompleted
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'message.completed'
  v: number
}
export type CompactionCompleted = {
  chatId: string
  firstKeptSeq: number
  summary: string
  tokensAfter: number
  tokensBefore: number
}
export type CompactionCompletedEvent = {
  data: CompactionCompleted
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'compaction.completed'
  v: number
}
export type SchedWaiting = {
  runId: string
  why: string
}
export type SchedState = {
  holder?: string
  waiting: SchedWaiting[]
}
export type SchedStateEvent = {
  data: SchedState
  /** durable events only */
  seq?: number
  stream: string
  time: number
  type: 'sched.state'
  v: number
}
export type Event =
  | ConfigChangedEvent
  | ModelStateEvent
  | DownloadProgressEvent
  | ChatCreatedEvent
  | ChatTitledEvent
  | ChatModelEvent
  | TurnRetractedEvent
  | ChatDeletedEvent
  | RunQueuedEvent
  | InputReceivedEvent
  | RunStartedEvent
  | RunPausedEvent
  | RunResumedEvent
  | RunFinishedEvent
  | MessageDeltaEvent
  | ReasoningDeltaEvent
  | MessagePartialEvent
  | MessageCompletedEvent
  | CompactionCompletedEvent
  | SchedStateEvent
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
  useGetConfigQuery,
  useGetConfigChatQuery,
  usePutConfigChatMutation,
  useGetConfigEngineLlamaserverQuery,
  usePutConfigEngineLlamaserverMutation,
  useGetConfigProviderLlamacppQuery,
  usePutConfigProviderLlamacppMutation,
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
  useGetModelFitQuery,
  useLoadModelMutation,
  useUnloadModelMutation,
  useGetVersionQuery,
  useHealthQuery
} = injectedRtkApi
