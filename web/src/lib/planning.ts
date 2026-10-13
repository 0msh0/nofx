import { getAuthHeaders, handleJSONResponse } from './api/helpers'
export interface Plan {
  id: string
  hash: string
  expires: string
  created: string
  quantity: string
  risk: string
  reward: string
  reward_risk: string
  snapshot: {
    venue: string
    symbol: string
    kind: string
    tick: string
    step: string
    quote_asset: string
    base_asset: string
  }
  constraints: Constraints
  idea: Idea
  orders: {
    index: number
    price: string
    quantity: string
    offset_seconds: number
  }[]
}
export interface Idea {
  name: string
  side: 'long' | 'short'
  entry: string
  stop: string
  target: string
  rationale: string
  execution: {
    kind: 'limit' | 'ladder' | 'twap'
    levels?: { price: string; weight: string }[]
    slices?: number
    interval_seconds?: number
  }
}
export interface Constraints {
  equity: string
  max_risk: string
  max_notional: string
  min_reward_risk: string
  fee_bps: string
  slippage_bps: string
}
export interface LiveOrder {
  client_id: string
  order_id: string
  role: string
  price: string
  quantity: string
  filled: string
  status: string
  error?: string
}
export interface LiveRun {
  id: string
  exchange_id: string
  plan_id: string
  plan_hash: string
  approval_hash: string
  state: string
  error?: string
  plan: Plan
  orders: LiveOrder[]
}
export interface PlanningState {
  records: Record<string, { plan: Plan; state: string }>
  accounts: Record<string, string>
  runs: LiveRun[]
  mode: 'live'
  now: string
}
export interface Drawing {
  kind: string
  label: string
  points: { time: number; price: string }[]
}
export interface ChartContext {
  venue: string
  symbol: string
  interval: string
  resolution: string
  visible_from?: number
  visible_to?: number
}
export interface PlanningChart {
  context(): ChartContext
  whenReady(): Promise<void>
  setContext(venue: string, symbol: string, resolution?: string): Promise<void>
  plot(p: Plan | null, phase?: string, compare?: Plan[]): Promise<void>
  focusPlan(): Promise<void>
  draw(drawings: Drawing[], source: string, interval: string): Promise<void>
  dispose(): void
}
declare global {
  interface Window {
    WorkspaceChart: new (options: Record<string, unknown>) => PlanningChart
  }
}
export const defaultLimits: Constraints = {
  equity: '1000',
  max_risk: '10',
  max_notional: '100',
  min_reward_risk: '2',
  fee_bps: '10',
  slippage_bps: '10',
}
export async function planningAPI<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch('/api/planning/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: getAuthHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handleJSONResponse<T>(r)
}
export interface PlanningEvent {
  type: string
  data: Record<string, unknown>
}
export async function streamPlanning(
  body: unknown,
  signal: AbortSignal,
  onEvent: (e: PlanningEvent) => void
): Promise<void> {
  const r = await fetch('/api/planning/chat', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok) {
    await handleJSONResponse(r)
    return
  }
  if (!r.body) throw new Error('服务没有返回规划流')
  const reader = r.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let at: number
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        for (const line of frame.split('\n'))
          if (line.startsWith('data: ')) {
            onEvent(JSON.parse(line.slice(6)) as PlanningEvent)
          }
      }
      if (buffer.length > 1 << 20) throw new Error('规划事件超过限制')
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
const scripts = new Map<string, Promise<void>>()
export function loadPlanningChart(): Promise<void> {
  const load = (url: string) => {
    let promise = scripts.get(url)
    if (!promise) {
      promise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = url
        script.onload = () => resolve()
        script.onerror = () => {
          scripts.delete(url)
          script.remove()
          reject(
            new Error(
              '图表组件加载失败，请检查构建时是否初始化 charting 子模块'
            )
          )
        }
        document.head.append(script)
      })
      scripts.set(url, promise)
    }
    return promise
  }
  return load('/charting_library/charting_library.standalone.js').then(() =>
    load('/planning/chart.js')
  )
}
export function expired(p: Plan, clock = Date.now()) {
  return Date.parse(p.expires) <= clock
}
