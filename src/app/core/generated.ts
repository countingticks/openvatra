import { emptyApi as api } from './emptyApi'
export const addTagTypes = [
  'catalog',
  'chats',
  'config',
  'downloads',
  'engines',
  'events',
  'hardware',
  'hf',
  'models',
  'runs',
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
        query: (queryArg) => ({
          url: `/api/catalog/${encodeURIComponent(String(queryArg.id))}/remove`,
          method: 'POST'
        }),
        invalidatesTags: ['catalog']
      }),
      listChats: build.query<ListChatsApiResponse, ListChatsApiArg>({
        query: (queryArg) => ({
          url: `/api/chats`,
          params: {
            q: queryArg.q
          }
        }),
        providesTags: ['chats']
      }),
      deleteChat: build.mutation<DeleteChatApiResponse, DeleteChatApiArg>({
        query: (queryArg) => ({
          url: `/api/chats/${encodeURIComponent(String(queryArg.id))}`,
          method: 'DELETE'
        }),
        invalidatesTags: ['chats']
      }),
      getChat: build.query<GetChatApiResponse, GetChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${encodeURIComponent(String(queryArg.id))}` }),
        providesTags: ['chats']
      }),
      updateChat: build.mutation<UpdateChatApiResponse, UpdateChatApiArg>({
        query: (queryArg) => ({
          url: `/api/chats/${encodeURIComponent(String(queryArg.id))}`,
          method: 'PATCH',
          body: queryArg.body
        }),
        invalidatesTags: ['chats']
      }),
      exportChat: build.query<ExportChatApiResponse, ExportChatApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${encodeURIComponent(String(queryArg.id))}/export` }),
        providesTags: ['chats']
      }),
      getTranscript: build.query<GetTranscriptApiResponse, GetTranscriptApiArg>({
        query: (queryArg) => ({ url: `/api/chats/${encodeURIComponent(String(queryArg.id))}/messages` }),
        providesTags: ['chats']
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
        query: (queryArg) => ({
          url: `/api/downloads/${encodeURIComponent(String(queryArg.id))}`,
          method: 'DELETE'
        }),
        invalidatesTags: ['downloads']
      }),
      pauseDownload: build.mutation<PauseDownloadApiResponse, PauseDownloadApiArg>({
        query: (queryArg) => ({
          url: `/api/downloads/${encodeURIComponent(String(queryArg.id))}/pause`,
          method: 'POST'
        }),
        invalidatesTags: ['downloads']
      }),
      resumeDownload: build.mutation<ResumeDownloadApiResponse, ResumeDownloadApiArg>({
        query: (queryArg) => ({
          url: `/api/downloads/${encodeURIComponent(String(queryArg.id))}/resume`,
          method: 'POST'
        }),
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
      listHfFiles: build.query<ListHfFilesApiResponse, ListHfFilesApiArg>({
        query: (queryArg) => ({
          url: `/api/hf/repos/${encodeURIComponent(String(queryArg.owner))}/${encodeURIComponent(String(queryArg.name))}/files`
        }),
        providesTags: ['hf']
      }),
      searchHf: build.query<SearchHfApiResponse, SearchHfApiArg>({
        query: (queryArg) => ({
          url: `/api/hf/search`,
          params: {
            q: queryArg.q,
            page: queryArg.page
          }
        }),
        providesTags: ['hf']
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
          url: `/api/models/${encodeURIComponent(String(queryArg.id))}/fit`,
          params: {
            context: queryArg.context,
            placement: queryArg.placement
          }
        }),
        providesTags: ['models']
      }),
      loadModel: build.mutation<LoadModelApiResponse, LoadModelApiArg>({
        query: (queryArg) => ({
          url: `/api/models/${encodeURIComponent(String(queryArg.id))}/load`,
          method: 'POST'
        }),
        invalidatesTags: ['models']
      }),
      removeModel: build.mutation<RemoveModelApiResponse, RemoveModelApiArg>({
        query: (queryArg) => ({
          url: `/api/models/${encodeURIComponent(String(queryArg.id))}/remove`,
          method: 'POST'
        }),
        invalidatesTags: ['models']
      }),
      unloadModel: build.mutation<UnloadModelApiResponse, UnloadModelApiArg>({
        query: (queryArg) => ({
          url: `/api/models/${encodeURIComponent(String(queryArg.id))}/unload`,
          method: 'POST'
        }),
        invalidatesTags: ['models']
      }),
      startRun: build.mutation<StartRunApiResponse, StartRunApiArg>({
        query: (queryArg) => ({ url: `/api/runs`, method: 'POST', body: queryArg.startRun }),
        invalidatesTags: ['runs']
      }),
      getRun: build.query<GetRunApiResponse, GetRunApiArg>({
        query: (queryArg) => ({ url: `/api/runs/${encodeURIComponent(String(queryArg.id))}` }),
        providesTags: ['runs']
      }),
      resumeRun: build.mutation<ResumeRunApiResponse, ResumeRunApiArg>({
        query: (queryArg) => ({
          url: `/api/runs/${encodeURIComponent(String(queryArg.id))}/resume`,
          method: 'POST'
        }),
        invalidatesTags: ['runs']
      }),
      stopRun: build.mutation<StopRunApiResponse, StopRunApiArg>({
        query: (queryArg) => ({
          url: `/api/runs/${encodeURIComponent(String(queryArg.id))}/stop`,
          method: 'POST'
        }),
        invalidatesTags: ['runs']
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
export type ListChatsApiResponse = /** status 200 OK */ ChatList
export type ListChatsApiArg = {
  q?: string
}
export type DeleteChatApiResponse = unknown
export type DeleteChatApiArg = {
  id: string
}
export type GetChatApiResponse = /** status 200 OK */ ChatBody
export type GetChatApiArg = {
  id: string
}
export type UpdateChatApiResponse = /** status 200 OK */ ChatBody
export type UpdateChatApiArg = {
  id: string
  body: {
    model?: string | null
    title?: string | null
  }
}
export type ExportChatApiResponse = /** status 200 OK */ string
export type ExportChatApiArg = {
  id: string
}
export type GetTranscriptApiResponse = /** status 200 OK */ Transcript
export type GetTranscriptApiArg = {
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
export type PauseDownloadApiResponse = /** status 202 Accepted */ StatusBody
export type PauseDownloadApiArg = {
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
export type ListHfFilesApiResponse = /** status 200 OK */ Listing
export type ListHfFilesApiArg = {
  owner: string
  name: string
}
export type SearchHfApiResponse = /** status 200 OK */ HfSearchBody
export type SearchHfApiArg = {
  q?: string
  page?: number
}
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
export type RemoveModelApiResponse = unknown
export type RemoveModelApiArg = {
  id: string
}
export type UnloadModelApiResponse = /** status 202 Accepted */ StatusBody
export type UnloadModelApiArg = {
  id: string
}
export type StartRunApiResponse = /** status 202 Accepted */ RunRef
export type StartRunApiArg = {
  startRun: StartRun
}
export type GetRunApiResponse = /** status 200 OK */ RunSnapshot
export type GetRunApiArg = {
  id: string
}
export type ResumeRunApiResponse = unknown
export type ResumeRunApiArg = {
  id: string
}
export type StopRunApiResponse = unknown
export type StopRunApiArg = {
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
export type ActiveRun = {
  id: string
  state: 'queued' | 'running' | 'interrupted'
}
export type SnippetPart = {
  match: boolean
  text: string
}
export type ChatItem = {
  activeRun?: ActiveRun | null
  id: string
  model: string
  /** search only: the best matching message */
  snippet?: SnippetPart[]
  title: string
  titleSource: 'auto' | 'user'
  /** Unix ms */
  updatedAt: number
}
export type ChatList = {
  chats: ChatItem[]
  seq: number
}
export type ChatBody = {
  chat: ChatItem
  seq: number
}
export type RunError = {
  code: string
  message: string
}
export type RunSnapshot = {
  chatId: string
  error?: RunError | null
  id: string
  model: string
  profile: string
  seq: number
  state: 'queued' | 'running' | 'interrupted' | 'done' | 'stopped' | 'failed'
}
export type ContextParts = {
  files: number
  messageCount: number
  /** the summary of earlier messages included */
  messages: number
  search: number
  system: number
}
export type ContextUse = {
  /** may sum to a little more or less than used: used is the estimate */
  parts: ContextParts
  /** 0 when the chat's model is not installed */
  size: number
  used: number
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
  reasoningMs: number
  tokensPerSecond: number
}
export type TranscriptItem = {
  failed?: boolean
  kind: 'input' | 'answer' | 'summary'
  /** the answer was cut off by a stop or a failure */
  partial?: boolean
  /** answer */
  parts?: MessagePart[]
  runId: string
  seq: number
  /** answer */
  stats?: MessageStats | null
  /** input and summary */
  text?: string
  /** Unix ms when the message was written */
  time: number
}
export type Transcript = {
  activeRun?: RunSnapshot | null
  context: ContextUse
  items: TranscriptItem[]
  runs: RunSnapshot[]
  seq: number
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
  build: 'auto' | 'bundled' | 'cuda'
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
  name: string
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
export type HfStart = {
  quant: string
  /** owner/name */
  repo: string
}
export type StartDownload = {
  catalogId?: string
  engine?: 'cuda'
  hf?: HfStart | null
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
  expertLayers?: number
  fit: 'fits' | 'slower' | 'tooBig' | 'unknown'
  gpuExpertLayers?: number
  layers?: number
  placement: 'gpu' | 'experts' | 'layers' | 'cpu'
  ramBytes: number
  source: 'estimate' | 'measured' | 'unknown'
  tokensPerSecond: number
  vramBytes: number
}
export type Memory = {
  ramBytes: number
  vramBytes: number
}
export type Model = {
  busy: boolean
  context: Choice | null
  error?: string
  id: string
  kind: 'chat' | 'embedding' | 'unreadable'
  /** null unless the model is ready; measured, else the fit estimate */
  memory: Memory | null
  moe: boolean
  name: string
  projector?: string
  /** null when the file name has no quantisation label */
  quant: string | null
  sizeBytes: number
  state: 'stopped' | 'loading' | 'ready' | 'error'
  /** Code, Vision, MoE, Embeddings, in that order */
  tags: string[]
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
export type GroupFile = {
  name: string
  sha256: string
  sizeBytes: number
}
export type Group = {
  files: GroupFile[]
  fit: 'fits' | 'slower' | 'tooBig'
  installed: boolean
  quant: string
  sizeBytes: number
}
export type Listing = {
  diskFreeBytes: number | null
  groups: Group[]
  repo: string
  revision: string
  tags: string[]
}
export type Repo = {
  downloads: number
  id: string
  likes: number
  name: string
  owner: string
  quants: number
  tags: string[]
  updatedAt: string
}
export type HfSearchBody = {
  hasMore: boolean
  page: number
  repos: Repo[]
}
export type RunRef = {
  chatId: string
  runId: string
  /** read the run's events on /api/events from after this seq */
  seq: number
}
export type StartRun = {
  /** omit to start a new chat */
  chatId?: string
  /** omit for the chat's model, or for a new chat the last one named */
  model?: string
  /** last: retract the chat's last turn and send it again (with text: edited) */
  replace?: 'last'
  /** the client's id for this send; the same id again answers the same run */
  requestId: string
  text?: string
}
export type VersionBody = {
  api: number
  version: string
}
export const {
  useGetCatalogQuery,
  useRemoveCatalogEntryMutation,
  useListChatsQuery,
  useDeleteChatMutation,
  useGetChatQuery,
  useUpdateChatMutation,
  useExportChatQuery,
  useGetTranscriptQuery,
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
  usePauseDownloadMutation,
  useResumeDownloadMutation,
  useGetEnginesQuery,
  useStreamEventsQuery,
  useGetHardwareQuery,
  useRefreshHardwareMutation,
  useListHfFilesQuery,
  useSearchHfQuery,
  useListModelsQuery,
  useRefreshModelsMutation,
  useGetModelFitQuery,
  useLoadModelMutation,
  useRemoveModelMutation,
  useUnloadModelMutation,
  useStartRunMutation,
  useGetRunQuery,
  useResumeRunMutation,
  useStopRunMutation,
  useGetVersionQuery,
  useHealthQuery
} = injectedRtkApi
