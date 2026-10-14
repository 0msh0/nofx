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
import { formatRequestError } from '../lib/requestErrors'
import { PlanningDataPanel } from '../components/planning/PlanningDataPanel'
import { PlanningAI500 } from '../components/planning/PlanningAI500'
import './TradingPlanningPage.css'
const format = (n: string | number) =>
  Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 })
const states: Record<string, string> = {
  draft: 'Awaiting approval',
  approved: 'Approved',
  running: 'Running',
  position_open: 'Position open · protected',
  stopping: 'Stop further entries',
  needs_attention: 'Needs reconciliation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}
const orderStates: Record<string, string> = {
  scheduled: 'Scheduled',
  submitting: 'Submitting',
  UNKNOWN: 'Unconfirmed receipt',
  NEW: 'Open',
  PARTIALLY_FILLED: 'Partially filled',
  FILLED: 'Filled',
  CANCELED: 'Cancelled',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  TRIGGERED: 'Triggered · verify fills',
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
      name: 'Custom plan',
      side: 'long',
      entry: '',
      stop: '',
      target: '',
      rationale:
        'User-defined conditional prices, subject to mathematical validation; neither approved nor executed.',
      execution: { kind: 'limit' },
    }),
    [levels, setLevels] = useState('')
  const [pluginWindow, setPluginWindow] = useState('7d')
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
            if (!cancelled && !available)
              setStatus('Chart is loading or temporarily unavailable')
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
      setError(
        'Connect a trading account and enable an AI model in NOFX settings first.'
      )
      return
    }
    const context = chart.current?.context()
    if (!context || context.venue !== venue || context.symbol !== symbol) {
      setError(
        'The chart is still switching markets. Try again once it is ready.'
      )
      return
    }
    if (current && current.state !== 'draft') {
      setError(
        'AI cannot modify a locked plan. Start a new idea or revoke its approval first.'
      )
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
          plugin_window: pluginWindow,
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
          if (event.type === 'iteration')
            setStatus(
              `Planning round ${event.data.round} of ${event.data.max_rounds}`
            )
          if (event.type === 'outcome' && Number(event.data.drafts) === 0)
            setStatus(
              'Planning completed without a validated draft. Review the explanation.'
            )
          if (event.type === 'tool_start')
            setTrace((t) => [
              ...t,
              'Reading / calculating · ' + String(event.data.name),
            ])
          if (event.type === 'tool_result')
            setTrace((t) => [
              ...t,
              (event.data.ok ? 'Completed · ' : 'Failed · ') +
                String(event.data.name),
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
      setStatus(
        controller.signal.aborted ? 'Planning stopped' : 'Planning finished'
      )
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
      <div className="planning-heading">
        <div>
          <h1>Trade Planning</h1>
          <p>Explore the market. Compare plans. Decide every trade.</p>
        </div>
        <Link to={ROUTES.settings}>Manage accounts and AI →</Link>
      </div>
      <div className="planning-toolbar">
        <select
          aria-label="Trading account"
          value={exchangeID}
          onChange={(e) => changeAccount(e.target.value)}
          disabled={busy}
        >
          {accounts.length === 0 && <option>No connected accounts</option>}
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
            aria-label="Symbol"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            disabled={busy}
          />
          <button disabled={busy}>Open market</button>
        </form>
        <span className="planning-live">Live trading · approval required</span>
      </div>
      {error && (
        <div className="planning-error" role="alert">
          {formatRequestError(error, 'en')}
          <button onClick={() => setError('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {!exchangeID && (
        <div className="planning-empty">
          Connect a Binance futures account in NOFX settings, or complete
          Hyperliquid Agent and Builder authorization. Your existing NOFX wallet
          and AI configuration are reused.
        </div>
      )}
      <PlanningAI500
        venue={venue}
        disabled={busy}
        onSelect={(next) => {
          setSymbol(next)
          setSymbolInput(next)
          setSelected('')
          setCompare([])
        }}
      />
      <div className="planning-workspace">
        <section className="planning-chart-pane">
          <div className="planning-market">
            <div>
              <b>{symbol}</b>
              <strong>{price === '—' ? price : format(price)}</strong>
              <small>{interval} · Live public market data</small>
            </div>
            <div>
              <button onClick={() => chart.current?.focusPlan()}>
                Focus plan
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
                Compare on chart
              </button>
            </div>
          </div>
          <div className="planning-chart" id="chart-container" />
          <div className="planning-legend">
            Entry <i className="entry" /> Stop loss <i className="stop" /> Take
            profit <i className="target" />
            {compare.length > 1 && (
              <button onClick={() => setCompare([])}>
                Exit comparison · select one plan to focus
              </button>
            )}
          </div>
          {current && (
            <div className="planning-selected">
              <b>
                {current.plan.idea.name} ·{' '}
                {current.plan.idea.side === 'long' ? 'Long' : 'Short'}
              </b>
              <div className="planning-price-row">
                <span>
                  Entry <strong>{format(current.plan.idea.entry)}</strong>
                </span>
                <span>
                  Stop loss{' '}
                  <strong className="stop-text">
                    {format(current.plan.idea.stop)}
                  </strong>
                </span>
                <span>
                  Target{' '}
                  <strong className="target-text">
                    {format(current.plan.idea.target)}
                  </strong>
                </span>
                <span>
                  Planned loss{' '}
                  <strong>
                    {format(current.plan.risk)}{' '}
                    {current.plan.snapshot.quote_asset}
                  </strong>
                </span>
              </div>
              <details>
                <summary>
                  {current.plan.orders.length || 1} child orders · Inspect
                  prices, quantities and release times
                </summary>
                <table>
                  <thead>
                    <tr>
                      <th>Child order</th>
                      <th>Limit price</th>
                      <th>Quantity</th>
                      <th>Release time</th>
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
                            ? 'At start'
                            : o.offset_seconds + ' seconds later'}
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
              <b>Candidate plans {records.length}</b>
              <button
                className="planning-primary"
                disabled={busy}
                onClick={() =>
                  send(
                    'Read current market data and candles. Propose multiple one-time plans including single-limit, weighted ladder and finite TWAP entries within the risk constraints. Explain conditional assumptions.'
                  )
                }
              >
                Generate plans
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
                    {r.plan.idea.side === 'long' ? '↗ Long' : '↘ Short'} ·{' '}
                    {r.plan.idea.execution.kind === 'ladder'
                      ? 'Price ladder'
                      : r.plan.idea.execution.kind === 'twap'
                        ? 'TWAP'
                        : 'Single limit'}
                  </span>
                  <strong>{r.plan.idea.name}</strong>
                  <span>Entry {format(r.plan.idea.entry)}</span>
                  <div>
                    <span>
                      Planned loss <b>{format(r.plan.risk)}</b>
                    </span>
                    <span>
                      Net reward/risk{' '}
                      <b>{Number(r.plan.reward_risk).toFixed(2)} : 1</b>
                    </span>
                  </div>
                  <small>
                    {expired(r.plan, clock) && r.state === 'draft'
                      ? 'Expired · replan'
                      : states[r.state] || r.state}
                  </small>
                </button>
              ))}
            </div>
            {records.length === 0 && (
              <p>
                Describe your idea or generate plans. If none is feasible, no
                trade is a valid decision.
              </p>
            )}
          </div>
          <PlanningDataPanel
            exchangeID={exchangeID}
            symbol={symbol}
            venue={venue}
            onWindowChange={setPluginWindow}
          />
          <details className="planning-tools">
            <summary>Risk budget, entry orders and advanced tools</summary>
            <div className="planning-limit-grid">
              {(Object.keys(limits) as (keyof Constraints)[]).map((key) => (
                <label key={key}>
                  {
                    {
                      equity: 'Equity budget',
                      max_risk: 'Maximum planned loss',
                      max_notional: 'Maximum notional (1x)',
                      min_reward_risk: 'Minimum net reward/risk',
                      fee_bps: 'Fee assumption / bps',
                      slippage_bps: 'Slippage assumption / bps',
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
              Budgets cannot exceed the live account balance. Hyperliquid costs
              must include Builder fees. Gaps, failed protection and slippage
              may cause losses beyond the estimate.
            </p>
            <button disabled={busy} onClick={() => setBuilder(true)}>
              Custom limit / ladder / TWAP
            </button>
            <label>
              Discussion preferences
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
                  setStatus(
                    'Preferences saved; hard risk constraints are unchanged'
                  )
                } catch (e) {
                  setError(String(e))
                }
              }}
            >
              Save preferences
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
              Inspect entry calculators
            </button>
            {tools.length > 0 && <pre>{JSON.stringify(tools, null, 2)}</pre>}
          </details>
          <details className="planning-tools">
            <summary>Execution history {data.runs.length}</summary>
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
                        <th>Type</th>
                        <th>Native order ID</th>
                        <th>State</th>
                        <th>Filled quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.orders.map((o) => (
                        <tr key={o.client_id}>
                          <td>{o.role}</td>
                          <td>{o.order_id || 'Unconfirmed'}</td>
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
                    Reconcile exchange state
                  </button>
                  <button disabled={busy} onClick={() => runAction('stop', r)}>
                    Stop entries / cancel unfilled orders
                  </button>
                </div>
              ))}
          </details>
        </section>
        <aside className="planning-assistant">
          <div className="planning-assistant-title">
            <b>NOFX Planning Assistant</b>
            <button onClick={newSession} disabled={busy}>
              New idea
            </button>
          </div>
          <select
            aria-label="NOFX AI model"
            value={modelID}
            onChange={(e) => setModelID(e.target.value)}
            disabled={busy}
          >
            {models.length === 0 && (
              <option>Enable AI in NOFX settings first</option>
            )}
            {models.map((m) => (
              <option value={m.id} key={m.id}>
                {m.name} · {m.customModelName || m.provider}
              </option>
            ))}
          </select>
          {busy && (
            <div className="planning-progress" role="status" aria-live="polite">
              <span className="planning-spinner" />
              {status || 'Preparing plans…'}
              <button onClick={() => abort.current?.abort()}>Stop</button>
            </div>
          )}
          <div className="planning-messages" ref={chatBox}>
            {messages.length === 0 && (
              <p>
                Start with the market, then build a plan. Plans appear on the
                chart. AI cannot approve or place trades.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={'planning-message ' + m.role}>
                {m.content}
              </div>
            ))}
          </div>
          <details className="planning-process">
            <summary>
              Activity {trace.length ? `· ${trace.length}` : ''}
            </summary>
            {trace.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </details>

          <form
            className="planning-composer"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <textarea
              aria-label="Trade idea"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Compare single-limit, pyramidal ladder and TWAP entries for a pullback long…"
              maxLength={8000}
              disabled={busy}
            />
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  send(
                    'Mark potential support and resistance on the current chart. Explain assumptions without generating trade plans yet.'
                  )
                }
              >
                Mark support / resistance
              </button>
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()}>
                  Stop planning
                </button>
              ) : (
                <button type="submit" disabled={!instruction.trim()}>
                  Send
                </button>
              )}
            </div>
          </form>
          <div className="planning-review">
            {current ? (
              <>
                <b>{current.plan.idea.name}</b>
                <p>
                  {states[run?.state || current.state] || current.state} · Live
                  trading ·{' '}
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
                      ? 'Expired; generate a new plan'
                      : 'Review and approve live trade'}
                  </button>
                ) : run?.state === 'approved' ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => runAction('execute', run)}
                    >
                      Execute this approved plan
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => runAction('stop', run)}
                    >
                      Revoke approval
                    </button>
                  </>
                ) : (
                  run && (
                    <button
                      disabled={busy}
                      onClick={() => runAction('stop', run)}
                    >
                      Stop remaining entries
                    </button>
                  )
                )}
                <small>
                  AI Revisions are not approval. Unknown orders are not
                  resubmitted. Check live positions immediately if protection
                  fails.
                </small>
              </>
            ) : (
              <p>Select a plan and review it on the chart before approval.</p>
            )}
          </div>
          <details className="planning-history">
            <summary>Planning conversations {history.length}</summary>
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
            <h2 id="planning-approval-title">Approve live trade</h2>
            <p>
              {account?.name} · {review.snapshot.venue} ·{' '}
              {review.snapshot.symbol} ·{' '}
              {review.idea.side === 'long' ? 'Long' : 'Short'}
            </p>
            <div className="planning-price-row">
              <span>Entry {format(review.idea.entry)}</span>
              <span>Stop loss {format(review.idea.stop)}</span>
              <span>Target {format(review.idea.target)}</span>
            </div>
            <p>
              Total quantity {format(review.quantity)} · Planned loss{' '}
              {format(review.risk)} {review.snapshot.quote_asset} ·{' '}
              {review.orders.length || 1} child orders · 1x leverage
            </p>
            <p>
              Only the locked, fixed-limit basket will be submitted. Ladder
              entries are released immediately; TWAP slices follow the schedule.
              Partial fills receive matching reduce-only protection. Protection
              failures stop further entries and require manual review. Stopping
              entries does not close filled positions. Actual loss can exceed
              the estimate.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Limit price</th>
                  <th>Quantity</th>
                  <th>Release time</th>
                </tr>
              </thead>
              <tbody>
                {review.orders.map((o) => (
                  <tr key={o.index}>
                    <td>{format(o.price)}</td>
                    <td>{format(o.quantity)}</td>
                    <td>{o.offset_seconds} seconds</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <code>{review.hash}</code>
            <label>
              Type APPROVE LIVE
              <input
                aria-label="Live trade confirmation text"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div>
              <button disabled={busy} onClick={() => setReview(null)}>
                Back to review
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
                Approve and execute live trade
              </button>
            </div>
          </section>
        </div>
      )}
      {builder && (
        <div className="planning-modal-backdrop">
          <section role="dialog" aria-modal="true" className="planning-modal">
            <h2>Custom order draft</h2>
            <select
              aria-label="Custom entry method"
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
              <option value="limit">Single limit</option>
              <option value="ladder">Price ladder</option>
              <option value="twap">TWAP fixed limit</option>
            </select>
            <select
              aria-label="Custom direction"
              value={builderIdea.side}
              onChange={(e) =>
                setBuilderIdea({
                  ...builderIdea,
                  side: e.target.value as Idea['side'],
                })
              }
            >
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
            {(['name', 'entry', 'stop', 'target'] as const).map((k) => (
              <label key={k}>
                {
                  {
                    name: 'Name',
                    entry: 'Entry / TWAP limit',
                    stop: 'Shared stop loss',
                    target: 'Shared take profit',
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
                Enter one price and quantity weight per line; weights must sum
                to 1
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
                  Slices
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
                  Interval / seconds
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
            <p>This creates an unapproved draft only. No orders are sent.</p>
            <button disabled={busy} onClick={() => setBuilder(false)}>
              Cancel
            </button>
            <button disabled={busy} onClick={saveBuilder}>
              Validate draft
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
