import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { getAuthHeaders, handleJSONResponse } from '../lib/api/helpers'
import { type AIModel, type Exchange } from '../types'
import { ROUTES } from '../router/paths'
import {
  type Plan,
  type LiveRun,
  type PlanningState,
  type Constraints,
  type Drawing,
  type Idea,
  type PlanningChart,
  type ChartContext,
  defaultLimits,
  expired,
  loadPlanningChart,
  planningAPI,
  streamPlanning,
} from '../lib/planning'
import './TradingPlanningPage.css'
const format = (n: string | number) =>
  Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 })
const states: Record<string, string> = {
  draft: '待批准',
  approved: '已批准',
  running: '执行中',
  position_open: '已入场 · 保护中',
  stopping: '停止后续入场',
  needs_attention: '需要核对',
  completed: '已结束',
  cancelled: '已取消',
  expired: '已过期',
}
const orderStates: Record<string, string> = {
  scheduled: '待释放',
  submitting: '正在提交',
  UNKNOWN: '回报未确认',
  NEW: '挂单中',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '已成交',
  CANCELED: '已取消',
  REJECTED: '已拒绝',
  EXPIRED: '已到期',
  TRIGGERED: '已触发 · 核对成交',
}
interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  content: string
}
export function TradingPlanningPage() {
  const [accounts, setAccounts] = useState<Exchange[]>([]),
    [models, setModels] = useState<AIModel[]>([]),
    [exchangeID, setExchangeID] = useState(''),
    [modelID, setModelID] = useState('')
  const [symbol, setSymbol] = useState('BTC'),
    [symbolInput, setSymbolInput] = useState('BTC'),
    [limits, setLimits] = useState<Constraints>(defaultLimits)
  const [data, setData] = useState<PlanningState>({
      records: {},
      accounts: {},
      runs: [],
      mode: 'live',
      now: '',
    }),
    [selected, setSelected] = useState(''),
    [compare, setCompare] = useState<string[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [instruction, setInstruction] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [price, setPrice] = useState('—'),
    [interval, setInterval] = useState('1h')
  const [trace, setTrace] = useState<string[]>([]),
    [review, setReview] = useState<Plan | null>(null),
    [confirmation, setConfirmation] = useState(''),
    [builder, setBuilder] = useState(false),
    [builderIdea, setBuilderIdea] = useState<Idea>({
      name: '自定义计划',
      side: 'long',
      entry: '',
      stop: '',
      target: '',
      rationale: '用户填写条件价格，数学引擎验证；未批准或执行。',
      execution: { kind: 'limit' },
    }),
    [levels, setLevels] = useState('')
  const [preferences, setPreferences] = useState(''),
    [history, setHistory] = useState<
      {
        id: string
        symbol: string
        exchange_id: string
        model_id: string
        messages: string
      }[]
    >([]),
    [tools, setTools] = useState<unknown[]>([])
  const chart = useRef<PlanningChart | null>(null),
    abort = useRef<AbortController | null>(null),
    session = useRef<string>(crypto.randomUUID()),
    chatBox = useRef<HTMLDivElement | null>(null),
    active = useRef(true)
  const account = accounts.find((a) => a.id === exchangeID),
    venue = account?.exchange_type || 'hyperliquid'
  const records = useMemo(
    () =>
      Object.values(data.records)
        .filter(
          (r) =>
            data.accounts[r.plan.id] === exchangeID &&
            r.plan.snapshot.symbol === symbol
        )
        .sort(
          (a, b) => Date.parse(b.plan.created) - Date.parse(a.plan.created)
        ),
    [data, exchangeID, symbol]
  )
  const current = data.records[selected],
    run = data.runs.find(
      (r) => r.plan_id === selected && r.exchange_id === exchangeID
    ),
    clock = Date.parse(data.now) || Date.now()
  const reload = useCallback(async () => {
    const next = await planningAPI<PlanningState>('state')
    if (active.current)
      setData((old) =>
        JSON.stringify({ ...old, now: '' }) ===
        JSON.stringify({ ...next, now: '' })
          ? { ...old, now: next.now }
          : next
      )
  }, [])
  const refreshHistory = useCallback(async () => {
    const rows = await planningAPI<typeof history>('conversations')
    if (active.current) setHistory(rows)
  }, [])
  useEffect(() => {
    active.current = true
    Promise.all([api.getExchangeConfigs(), api.getModelConfigs()])
      .then(([ex, ai]) => {
        if (!active.current) return
        const supported = ex.filter(
          (a) =>
            a.enabled &&
            ['binance', 'hyperliquid'].includes(a.exchange_type || '')
        )
        const enabled = ai.filter((m) => m.enabled && m.has_api_key)
        setAccounts(supported)
        setModels(enabled)
        setExchangeID(supported[0]?.id || '')
        setModelID(enabled[0]?.id || '')
        const native =
          supported[0]?.exchange_type === 'binance' ? 'BTCUSDT' : 'BTC'
        setSymbol(native)
        setSymbolInput(native)
      })
      .catch((e) => setError(String(e.message)))
    reload().catch((e) => setError(e.message))
    refreshHistory().catch(() => {})
    planningAPI<{ text: string }>('preferences')
      .then((p) => setPreferences(p.text))
      .catch(() => {})
    const timer = window.setInterval(() => reload().catch(() => {}), 4000)
    return () => {
      active.current = false
      clearInterval(timer)
      abort.current?.abort()
      chart.current?.dispose()
      chart.current = null
    }
  }, [reload, refreshHistory])
  useEffect(() => {
    let cancelled = false
    if (!exchangeID) return
    planningAPI<{ equity: string; available: string; fee_bps: string }>(
      'account?exchange_id=' +
        encodeURIComponent(exchangeID) +
        '&symbol=' +
        encodeURIComponent(symbol)
    )
      .then((a) => {
        if (cancelled) return
        const equity = Number(a.equity),
          available = Number(a.available)
        if (equity > 0 && available > 0)
          setLimits({
            ...defaultLimits,
            equity: a.equity,
            max_risk: Math.min(10, equity * 0.01).toFixed(6),
            max_notional: Math.min(500, available * 0.5).toFixed(6),
            fee_bps: String(Math.max(10, Math.ceil(Number(a.fee_bps)))),
          })
      })
      .catch((e) => !cancelled && setError(e.message))
    loadPlanningChart()
      .then(() => {
        if (cancelled) return
        chart.current?.dispose()
        chart.current = new window.WorkspaceChart({
          venue,
          symbol,
          onStatus: (text: string) => !cancelled && setStatus(text),
          onPrice: (c: { close: string }) => !cancelled && setPrice(c.close),
          onContext: (c: ChartContext) => !cancelled && setInterval(c.interval),
          onError: (e: string) => !cancelled && setError(e),
          onAvailability: (available: boolean) => {
            if (!cancelled && !available) setStatus('图表正在加载或暂不可用')
          },
        })
        chart.current
          .setContext(venue, symbol, '60')
          .catch((e) => !cancelled && setError(e.message))
      })
      .catch((e) => setError(e.message))
    return () => {
      cancelled = true
      chart.current?.dispose()
      chart.current = null
    }
  }, [exchangeID, venue, symbol])
  useEffect(() => {
    if (!chart.current) return
    const list = compare
      .map((id) => data.records[id]?.plan)
      .filter(
        (p): p is Plan =>
          !!p && p.snapshot.symbol === symbol && p.snapshot.venue === venue
      )
    chart.current
      .plot(
        current?.plan || null,
        current?.state || 'draft',
        list.length >= 2 ? list : []
      )
      .catch((e) => setError(e.message))
  }, [current, compare, data.records, symbol, venue])
  useEffect(() => {
    const box = chatBox.current
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 200)
      box.scrollTop = box.scrollHeight
  }, [messages])
  async function choose(p: Plan) {
    setSelected(p.id)
    setCompare([])
    setError('')
    await chart.current?.plot(p, data.records[p.id].state, [])
    await chart.current?.focusPlan()
  }
  function changeAccount(id: string) {
    abort.current?.abort()
    setExchangeID(id)
    const a = accounts.find((v) => v.id === id)
    const native = a?.exchange_type === 'binance' ? 'BTCUSDT' : 'BTC'
    setSymbol(native)
    setSymbolInput(native)
    setSelected('')
    setCompare([])
    setMessages([])
    session.current = crypto.randomUUID()
    setPrice('—')
  }
  async function send(text = instruction) {
    if (busy || !text.trim()) return
    if (!modelID || !exchangeID) {
      setError('请先在 NOFX 设置中连接交易账户并启用 AI。')
      return
    }
    const context = chart.current?.context()
    if (!context || context.venue !== venue || context.symbol !== symbol) {
      setError('图表切换尚未完成，请稍后再试。')
      return
    }
    if (current && current.state !== 'draft') {
      setError('已锁定计划不能被 AI 修改。请选择新想法，或先取消该计划的审批。')
      return
    }
    const historyMessages = messages
      .filter((m) => m.role !== 'error')
      .slice(-16)
    setBusy(true)
    setError('')
    setInstruction('')
    setTrace([])
    setMessages((m) => [...m, { role: 'user', content: text }])
    const controller = new AbortController()
    abort.current = controller
    try {
      await streamPlanning(
        {
          exchange_id: exchangeID,
          model_id: modelID,
          symbol,
          venue,
          interval: context.interval,
          visible_from: context.visible_from,
          visible_to: context.visible_to,
          message: text,
          plan_id: selected || undefined,
          execution_kind: 'auto',
          session_id: session.current,
          turn_id: crypto.randomUUID(),
          history: historyMessages,
          constraints: limits,
        },
        controller.signal,
        (event) => {
          if (event.type === 'assistant')
            setMessages((m) => [
              ...m,
              { role: 'assistant', content: String(event.data.message) },
            ])
          if (event.type === 'error') setError(String(event.data.message))
          if (event.type === 'status') setStatus(String(event.data.message))
          if (event.type === 'tool_start')
            setTrace((t) => [...t, '读取／计算 · ' + String(event.data.name)])
          if (event.type === 'tool_result')
            setTrace((t) => [
              ...t,
              (event.data.ok ? '完成 · ' : '失败 · ') + String(event.data.name),
            ])
          if (event.type === 'plans') {
            const plans = event.data.plans as Plan[]
            if (plans?.length) {
              setSelected(plans[0].id)
              setCompare([])
            }
            reload().catch(() => {})
          }
          if (event.type === 'drawings') {
            const drawings = event.data.drawings as Drawing[]
            chart.current
              ?.draw(drawings, 'ai', context.interval)
              .catch((e) => setError(e.message))
          }
        }
      )
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(controller.signal.aborted ? '已停止本轮规划' : '')
      await reload().catch(() => {})
      await refreshHistory().catch(() => {})
    }
  }
  async function approveAndExecute() {
    if (!review || confirmation !== 'APPROVE LIVE' || busy) return
    const locked = review
    setBusy(true)
    setError('')
    try {
      const approved = await planningAPI<LiveRun>('approve', {
        plan_id: locked.id,
        hash: locked.hash,
        confirmation,
      })
      setReview(null)
      setConfirmation('')
      await planningAPI('execute', {
        id: approved.id,
        hash: approved.approval_hash,
      })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await reload().catch(() => {})
    } finally {
      setBusy(false)
    }
  }
  async function runAction(
    action: 'execute' | 'stop' | 'reconcile',
    r: LiveRun
  ) {
    setBusy(true)
    setError('')
    try {
      await planningAPI(action, { id: r.id, hash: r.approval_hash })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function saveBuilder() {
    setBusy(true)
    setError('')
    try {
      const idea = { ...builderIdea, execution: { ...builderIdea.execution } }
      if (idea.execution.kind === 'ladder') {
        idea.execution.levels = levels
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [p, w] = line.trim().split(/\s+/)
            return { price: p, weight: w }
          })
      }
      const p = await planningAPI<Plan>('compile', {
        exchange_id: exchangeID,
        symbol,
        idea,
        constraints: limits,
      })
      setBuilder(false)
      await reload()
      setSelected(p.id)
      setCompare([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  function newSession() {
    abort.current?.abort()
    session.current = crypto.randomUUID()
    setMessages([])
    setSelected('')
    setCompare([])
    setTrace([])
    setError('')
  }
  return (
    <div className="planning-page">
      <div className="planning-toolbar">
        <strong>交易规划</strong>
        <span className="planning-live">真实交易 · 明确批准后下单</span>
        <select
          aria-label="交易账户"
          value={exchangeID}
          onChange={(e) => changeAccount(e.target.value)}
          disabled={busy}
        >
          {accounts.length === 0 && <option>暂无已连接账户</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.exchange_type}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSymbol(
              symbolInput.trim().includes(':')
                ? symbolInput.trim()
                : symbolInput.trim().toUpperCase()
            )
            setSelected('')
            setCompare([])
          }}
        >
          <input
            aria-label="标的"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            disabled={busy}
          />
          <button disabled={busy}>打开标的</button>
        </form>
        <Link to={ROUTES.settings}>连接账户／配置 AI</Link>
      </div>
      {error && (
        <div className="planning-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {!exchangeID && (
        <div className="planning-empty">
          先在 NOFX 设置中连接 Binance 合约账户，或完成 Hyperliquid 钱包的 Agent
          和 Builder 授权。这里不要求另一套钱包或 AI 密钥。
        </div>
      )}
      <div className="planning-workspace">
        <section className="planning-chart-pane">
          <div className="planning-market">
            <div>
              <b>{symbol}</b>
              <strong>{price === '—' ? price : format(price)}</strong>
              <small>{interval} · 实时公开行情</small>
            </div>
            <div>
              <button onClick={() => chart.current?.focusPlan()}>
                聚焦方案
              </button>
              <button
                disabled={
                  busy || records.filter((r) => r.state === 'draft').length < 2
                }
                onClick={() => {
                  setCompare(
                    records
                      .filter(
                        (r) => r.state === 'draft' && !expired(r.plan, clock)
                      )
                      .slice(0, 3)
                      .map((r) => r.plan.id)
                  )
                }}
              >
                在图上比较
              </button>
            </div>
          </div>
          <div className="planning-chart" id="chart-container" />
          <div className="planning-legend">
            入场 <i className="entry" /> 止损 <i className="stop" /> 止盈{' '}
            <i className="target" />
            {compare.length > 1 && (
              <button onClick={() => setCompare([])}>
                退出比较 · 点击方案只看一份
              </button>
            )}
          </div>
          {current && (
            <div className="planning-selected">
              <b>
                {current.plan.idea.name} ·{' '}
                {current.plan.idea.side === 'long' ? '做多' : '做空'}
              </b>
              <div className="planning-price-row">
                <span>
                  入场 <strong>{format(current.plan.idea.entry)}</strong>
                </span>
                <span>
                  止损{' '}
                  <strong className="stop-text">
                    {format(current.plan.idea.stop)}
                  </strong>
                </span>
                <span>
                  目标{' '}
                  <strong className="target-text">
                    {format(current.plan.idea.target)}
                  </strong>
                </span>
                <span>
                  计划亏损{' '}
                  <strong>
                    {format(current.plan.risk)}{' '}
                    {current.plan.snapshot.quote_asset}
                  </strong>
                </span>
              </div>
              <details>
                <summary>
                  {current.plan.orders.length || 1} 笔子订单 ·
                  查看价格、数量和释放时间
                </summary>
                <table>
                  <thead>
                    <tr>
                      <th>子单</th>
                      <th>限价</th>
                      <th>数量</th>
                      <th>释放时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.plan.orders.map((o) => (
                      <tr key={o.index}>
                        <td>{o.index}</td>
                        <td>{format(o.price)}</td>
                        <td>
                          {format(o.quantity)}{' '}
                          {current.plan.snapshot.base_asset}
                        </td>
                        <td>
                          {o.offset_seconds === 0
                            ? '启动时'
                            : o.offset_seconds + ' 秒后'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>{current.plan.idea.rationale}</p>
              </details>
            </div>
          )}
          <div className="planning-candidates">
            <div className="planning-section-title">
              <b>候选方案 {records.length}</b>
              <button
                disabled={busy}
                onClick={() =>
                  send(
                    '读取当前行情和 K 线，提出单笔、分批和 TWAP 等多个符合风险约束的一次性交易草案，说明条件假设。'
                  )
                }
              >
                生成方案
              </button>
            </div>
            <div className="planning-card-list">
              {records.map((r) => (
                <button
                  key={r.plan.id}
                  className={
                    'planning-card ' +
                    (selected === r.plan.id ? 'selected' : '')
                  }
                  onClick={() => choose(r.plan)}
                >
                  <span
                    className={
                      r.plan.idea.side === 'long' ? 'target-text' : 'stop-text'
                    }
                  >
                    {compare.includes(r.plan.id)
                      ? String.fromCharCode(65 + compare.indexOf(r.plan.id)) +
                        ' · '
                      : ''}
                    {r.plan.idea.side === 'long' ? '↗ 做多' : '↘ 做空'} ·{' '}
                    {r.plan.idea.execution.kind === 'ladder'
                      ? '分批挂单'
                      : r.plan.idea.execution.kind === 'twap'
                        ? 'TWAP'
                        : '单笔限价'}
                  </span>
                  <strong>{r.plan.idea.name}</strong>
                  <span>入场 {format(r.plan.idea.entry)}</span>
                  <div>
                    <span>
                      计划亏损 <b>{format(r.plan.risk)}</b>
                    </span>
                    <span>
                      净盈亏比{' '}
                      <b>{Number(r.plan.reward_risk).toFixed(2)} : 1</b>
                    </span>
                  </div>
                  <small>
                    {expired(r.plan, clock) && r.state === 'draft'
                      ? '已过期 · 重新规划'
                      : states[r.state] || r.state}
                  </small>
                </button>
              ))}
            </div>
            {records.length === 0 && (
              <p>
                描述你的想法，或点击生成方案。未找到可行方案时，可以不交易。
              </p>
            )}
          </div>
          <details className="planning-tools">
            <summary>风险预算、分批订单与高级工具</summary>
            <div className="planning-limit-grid">
              {(Object.keys(limits) as (keyof Constraints)[]).map((key) => (
                <label key={key}>
                  {
                    {
                      equity: '账户权益预算',
                      max_risk: '最大计划亏损',
                      max_notional: '最大投入（1x）',
                      min_reward_risk: '最低净盈亏比',
                      fee_bps: '手续费假设 / bps',
                      slippage_bps: '滑点假设 / bps',
                    }[key]
                  }
                  <input
                    value={limits[key]}
                    inputMode="decimal"
                    disabled={busy}
                    onChange={(e) =>
                      setLimits({ ...limits, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <p>
              预算不得高于真实账户余额。Hyperliquid 费用必须包含 Builder
              费。止损跳空、保护单故障和滑点可能使实际亏损超过估计。
            </p>
            <button disabled={busy} onClick={() => setBuilder(true)}>
              自定义单笔／分批／TWAP
            </button>
            <label>
              讨论偏好
              <textarea
                value={preferences}
                onChange={(e) => setPreferences(e.target.value)}
                maxLength={1600}
              />
            </label>
            <button
              onClick={async () => {
                try {
                  const r = await fetch('/api/planning/preferences', {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ text: preferences }),
                  })
                  await handleJSONResponse(r)
                  setStatus('讨论偏好已保存，不改变硬风险设置')
                } catch (e) {
                  setError(String(e))
                }
              }}
            >
              保存偏好
            </button>
            <button
              onClick={async () => {
                try {
                  setTools(
                    await planningAPI<unknown[]>(
                      'entry-plugins?session_id=' + session.current
                    )
                  )
                } catch (e) {
                  setError(String(e))
                }
              }}
            >
              查看现场开发插件
            </button>
            {tools.length > 0 && <pre>{JSON.stringify(tools, null, 2)}</pre>}
          </details>
          <details className="planning-tools">
            <summary>执行记录 {data.runs.length}</summary>
            {data.runs
              .filter((r) => r.exchange_id === exchangeID)
              .map((r) => (
                <div className="planning-run" key={r.id}>
                  <b>
                    {r.plan.idea.name} · {states[r.state] || r.state}
                  </b>
                  {r.error && <p className="stop-text">{r.error}</p>}
                  <table>
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>真实订单 ID</th>
                        <th>状态</th>
                        <th>成交量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.orders.map((o) => (
                        <tr key={o.client_id}>
                          <td>{o.role}</td>
                          <td>{o.order_id || '尚未确认'}</td>
                          <td>{orderStates[o.status] || o.status}</td>
                          <td>{format(o.filled)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    disabled={busy}
                    onClick={() => runAction('reconcile', r)}
                  >
                    核对交易所状态
                  </button>
                  <button disabled={busy} onClick={() => runAction('stop', r)}>
                    停止后续入场／撤销未成交
                  </button>
                </div>
              ))}
          </details>
        </section>
        <aside className="planning-assistant">
          <div className="planning-assistant-title">
            <b>NOFX 规划助手</b>
            <button onClick={newSession} disabled={busy}>
              新想法
            </button>
          </div>
          <select
            aria-label="NOFX AI 模型"
            value={modelID}
            onChange={(e) => setModelID(e.target.value)}
            disabled={busy}
          >
            {models.length === 0 && <option>先在 NOFX 设置中启用 AI</option>}
            {models.map((m) => (
              <option value={m.id} key={m.id}>
                {m.name} · {m.customModelName || m.provider}
              </option>
            ))}
          </select>
          <div className="planning-messages" ref={chatBox}>
            {messages.length === 0 && (
              <p>先看行情，再一起规划。方案会画在图上，AI 不能批准或下单。</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={'planning-message ' + m.role}>
                {m.content}
              </div>
            ))}
          </div>
          <details className="planning-process">
            <summary>过程 {trace.length ? `· ${trace.length}` : ''}</summary>
            {trace.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </details>
          {busy && <p role="status">{status || '正在读取行情与推演…'}</p>}
          <form
            className="planning-composer"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <textarea
              aria-label="交易想法"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：比较回调做多的单笔、金字塔和 TWAP 入场…"
              maxLength={8000}
              disabled={busy}
            />
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  send(
                    '根据当前 K 线在图上标出可能的支撑和阻力，说明条件假设，暂不生成交易方案。'
                  )
                }
              >
                标支撑压力
              </button>
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()}>
                  停止思考
                </button>
              ) : (
                <button type="submit" disabled={!instruction.trim()}>
                  发送
                </button>
              )}
            </div>
          </form>
          <div className="planning-review">
            {current ? (
              <>
                <b>{current.plan.idea.name}</b>
                <p>
                  {states[run?.state || current.state] || current.state} ·
                  真实交易 ·{' '}
                  {accounts.find((a) => a.id === data.accounts[selected])?.name}
                </p>
                {run?.error && <p className="stop-text">{run.error}</p>}
                {current.state === 'draft' ? (
                  <button
                    className="planning-primary"
                    disabled={
                      busy ||
                      expired(current.plan, clock) ||
                      data.accounts[selected] !== exchangeID
                    }
                    onClick={() => {
                      setReview(current.plan)
                      setConfirmation('')
                    }}
                  >
                    {expired(current.plan, clock)
                      ? '已过期，请重新生成'
                      : '审阅并批准真实交易'}
                  </button>
                ) : run?.state === 'approved' ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => runAction('execute', run)}
                    >
                      执行这份已批准计划
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => runAction('stop', run)}
                    >
                      取消审批
                    </button>
                  </>
                ) : (
                  run && (
                    <button
                      disabled={busy}
                      onClick={() => runAction('stop', run)}
                    >
                      停止剩余入场
                    </button>
                  )
                )}
                <small>
                  AI
                  修改不构成审批。未知回报不重发，保护订单异常需要立即核对真实持仓。
                </small>
              </>
            ) : (
              <p>点击一份方案，在图上审阅后再批准。</p>
            )}
          </div>
          <details className="planning-history">
            <summary>历史规划会话 {history.length}</summary>
            {history.map((h) => (
              <button
                key={h.id}
                disabled={busy}
                onClick={() => {
                  session.current = h.id
                  changeAccount(h.exchange_id)
                  session.current = h.id
                  setSymbol(h.symbol)
                  setSymbolInput(h.symbol)
                  setModelID(h.model_id)
                  setMessages(JSON.parse(h.messages))
                  setSelected('')
                }}
              >
                {h.symbol} · {h.id.slice(0, 8)}
              </button>
            ))}
          </details>
        </aside>
      </div>
      {review && (
        <div className="planning-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="planning-approval-title"
            className="planning-modal"
          >
            <h2 id="planning-approval-title">批准真实交易</h2>
            <p>
              {account?.name} · {review.snapshot.venue} ·{' '}
              {review.snapshot.symbol} ·{' '}
              {review.idea.side === 'long' ? '做多' : '做空'}
            </p>
            <div className="planning-price-row">
              <span>入场 {format(review.idea.entry)}</span>
              <span>止损 {format(review.idea.stop)}</span>
              <span>目标 {format(review.idea.target)}</span>
            </div>
            <p>
              总数量 {format(review.quantity)} · 计划亏损 {format(review.risk)}{' '}
              {review.snapshot.quote_asset} · {review.orders.length || 1}{' '}
              笔子订单 · 1x 杠杆
            </p>
            <p>
              只执行锁定的固定限价计划。分批立即释放，TWAP
              按表中时间释放。部分成交后提交对应数量的减仓止损／止盈；保护单异常停止后续入场，需要人工核对。停止入场不会平掉已成交仓位。实际亏损可能超过估计。
            </p>
            <table>
              <thead>
                <tr>
                  <th>限价</th>
                  <th>数量</th>
                  <th>释放时间</th>
                </tr>
              </thead>
              <tbody>
                {review.orders.map((o) => (
                  <tr key={o.index}>
                    <td>{format(o.price)}</td>
                    <td>{format(o.quantity)}</td>
                    <td>{o.offset_seconds} 秒</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <code>{review.hash}</code>
            <label>
              输入 APPROVE LIVE
              <input
                aria-label="真实交易确认文字"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div>
              <button disabled={busy} onClick={() => setReview(null)}>
                返回审阅
              </button>
              <button
                className="planning-primary"
                disabled={
                  busy ||
                  confirmation !== 'APPROVE LIVE' ||
                  expired(review, clock)
                }
                onClick={approveAndExecute}
              >
                批准并执行真实交易
              </button>
            </div>
          </section>
        </div>
      )}
      {builder && (
        <div className="planning-modal-backdrop">
          <section role="dialog" aria-modal="true" className="planning-modal">
            <h2>自定义订单草案</h2>
            <select
              aria-label="自定义入场方式"
              value={builderIdea.execution.kind}
              onChange={(e) =>
                setBuilderIdea({
                  ...builderIdea,
                  execution: {
                    kind: e.target.value as Idea['execution']['kind'],
                    ...(e.target.value === 'twap'
                      ? { slices: 4, interval_seconds: 30 }
                      : {}),
                  },
                })
              }
            >
              <option value="limit">单笔限价</option>
              <option value="ladder">分批挂单</option>
              <option value="twap">TWAP 固定限价</option>
            </select>
            <select
              aria-label="自定义方向"
              value={builderIdea.side}
              onChange={(e) =>
                setBuilderIdea({
                  ...builderIdea,
                  side: e.target.value as Idea['side'],
                })
              }
            >
              <option value="long">做多</option>
              <option value="short">做空</option>
            </select>
            {(['name', 'entry', 'stop', 'target'] as const).map((k) => (
              <label key={k}>
                {
                  {
                    name: '名称',
                    entry: '入场／TWAP限价',
                    stop: '统一止损',
                    target: '统一止盈',
                  }[k]
                }
                <input
                  value={builderIdea[k]}
                  onChange={(e) =>
                    setBuilderIdea({ ...builderIdea, [k]: e.target.value })
                  }
                />
              </label>
            ))}
            {builderIdea.execution.kind === 'ladder' && (
              <label>
                每行填写价格与数量权重；权重合计 1
                <textarea
                  placeholder={'82000 0.3\n81500 0.3\n81000 0.4'}
                  value={levels}
                  onChange={(e) => setLevels(e.target.value)}
                />
              </label>
            )}
            {builderIdea.execution.kind === 'twap' && (
              <>
                <label>
                  片数
                  <input
                    value={builderIdea.execution.slices}
                    onChange={(e) =>
                      setBuilderIdea({
                        ...builderIdea,
                        execution: {
                          ...builderIdea.execution,
                          slices: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  间隔秒数
                  <input
                    value={builderIdea.execution.interval_seconds}
                    onChange={(e) =>
                      setBuilderIdea({
                        ...builderIdea,
                        execution: {
                          ...builderIdea.execution,
                          interval_seconds: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            <p>这里只生成未批准草案；不会发送订单。</p>
            <button disabled={busy} onClick={() => setBuilder(false)}>
              取消
            </button>
            <button disabled={busy} onClick={saveBuilder}>
              计算草案
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
