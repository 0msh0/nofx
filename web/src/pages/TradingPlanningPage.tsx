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
import { preservePlanningPlans } from '../lib/planningPresentation'
import { PlanningDataPanel } from '../components/planning/PlanningDataPanel'
import { FrontierMarkets } from '../components/planning/FrontierMarkets'
import { ExecutionSchedule } from '../components/planning/ExecutionSchedule'
import {
  PlanningActivity,
  recordActivity,
  type ActivityItem,
} from '../components/planning/PlanningActivity'
import {
  PlanStructures,
  type PlanCheck,
} from '../components/planning/PlanStructures'
import { FrontierAccount } from '../components/planning/FrontierAccount'
import {
  FrontierSetup,
  type FeeWalletState,
} from '../components/planning/FrontierSetup'
import { nativeMarket } from '../lib/frontierAccount'
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
  const [assistantView, setAssistantView] = useState<'chat' | 'plans'>('chat')
  const [setupOpen, setSetupOpen] = useState<'ai' | 'exchange' | null>(null)
  const [walletState, setWalletState] = useState<FeeWalletState>('checking')
  const [configsLoaded, setConfigsLoaded] = useState(false)
  const [accounts, setAccounts] = useState<Exchange[]>([]),
    [models, setModels] = useState<AIModel[]>([]),
    [exchangeID, setExchangeID] = useState(''),
    [modelID, setModelID] = useState('')
  const [venue, setVenue] = useState('binance')
  const requestedVenue = useRef('binance')
  const marketChosen = useRef(false)
  const [symbol, setSymbol] = useState('BTCUSDT'),
    [symbolInput, setSymbolInput] = useState('BTCUSDT'),
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
    [planningBusy, setPlanningBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [price, setPrice] = useState('—'),
    [interval, setInterval] = useState('1h')
  const [trace, setTrace] = useState<ActivityItem[]>([]),
    [review, setReview] = useState<Plan | null>(null),
    [leverage, setLeverage] = useState(5),
    [extrasOpen, setExtrasOpen] = useState(false),
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
    chatFollow = useRef(true),
    active = useRef(true)
  const account = accounts.find((a) => a.id === exchangeID)
  const records = useMemo(
    () =>
      Object.values(data.records)
        .filter(
          (r) =>
            data.accounts[r.plan.id] === exchangeID &&
            r.plan.snapshot.symbol === symbol &&
            r.plan.snapshot.venue === venue
        )
        .sort(
          (a, b) => Date.parse(b.plan.created) - Date.parse(a.plan.created)
        ),
    [data, exchangeID, symbol, venue]
  )
  const [checks, setChecks] = useState<PlanCheck[]>([])
  const [turnPlanIDs, setTurnPlanIDs] = useState<string[]>([])
  function resetTurn() {
    setAssistantView('chat')
    setChecks([])
    setTurnPlanIDs([])
    setTrace([])
  }
  const selectedRun = data.runs.find(
    (r) => r.plan_id === selected && r.exchange_id === exchangeID
  )
  const current = useMemo(
    () =>
      data.records[selected] ||
      (selectedRun
        ? { plan: selectedRun.plan, state: selectedRun.state }
        : undefined),
    [data.records, selected, selectedRun?.plan, selectedRun?.state]
  )
  const run = selectedRun
  const clock = Date.parse(data.now) || Date.now()
  const reload = useCallback(async () => {
    const next = await planningAPI<PlanningState>('state')
    if (active.current)
      setData((old) =>
        JSON.stringify({ ...old, now: '' }) ===
        JSON.stringify({ ...next, now: '' })
          ? { ...old, now: next.now }
          : preservePlanningPlans(old, next)
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
            !a.testnet &&
            ['binance', 'hyperliquid'].includes(a.exchange_type || '')
        )
        const enabled = ai.filter((m) => m.enabled && m.has_api_key)
        setAccounts(supported)
        setModels(enabled)
        const preferred =
          supported.find((a) => a.exchange_type === requestedVenue.current) ||
          (!marketChosen.current && supported.length === 1
            ? supported[0]
            : undefined)
        setExchangeID(preferred?.id || '')
        if (
          preferred &&
          !marketChosen.current &&
          preferred.exchange_type !== requestedVenue.current
        ) {
          requestedVenue.current = preferred.exchange_type
          setVenue(preferred.exchange_type)
          const native =
            preferred.exchange_type === 'binance' ? 'BTCUSDT' : 'BTC'
          setSymbol(native)
          setSymbolInput(native)
        }
        setModelID(enabled[0]?.id || '')
        setConfigsLoaded(true)
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
    let chartFailure = ''
    const reportChartFailure = (message: string) => {
      if (cancelled) return
      chartFailure = message
      setError(message)
    }
    loadPlanningChart()
      .then(() => {
        if (cancelled) return
        chart.current?.dispose()
        chart.current = new window.WorkspaceChart({
          venue,
          symbol,
          onStatus: () => {},
          onPrice: (c: { close: string }) => !cancelled && setPrice(c.close),
          onContext: (c: ChartContext) => !cancelled && setInterval(c.interval),
          onError: reportChartFailure,
          onAvailability: (available: boolean) => {
            if (cancelled) return
            if (available && chartFailure)
              setError((message) => (message === chartFailure ? '' : message))
          },
        })
        chart.current
          .setContext(venue, symbol, '60')
          .catch((e) => reportChartFailure(e.message))
      })
      .catch((e) => reportChartFailure(e.message))
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
        run?.state || current?.state || 'draft',
        list.length >= 2 ? list : []
      )
      .catch((e) => setError(e.message))
  }, [current, compare, data.records, symbol, venue, run?.state])
  useEffect(() => {
    const box = chatBox.current
    if (box && chatFollow.current) box.scrollTop = box.scrollHeight
  }, [messages, trace])
  async function refreshSetup(
    preferredModel?: string,
    preferredVenue?: string
  ) {
    const [ex, ai] = await Promise.all([
      api.getExchangeConfigs(),
      api.getModelConfigs(),
    ])
    if (!active.current) return
    const supported = ex.filter(
      (a) =>
        a.enabled &&
        !a.testnet &&
        ['binance', 'hyperliquid'].includes(a.exchange_type || '')
    )
    const enabled = ai.filter((m) => m.enabled && m.has_api_key)
    setAccounts(supported)
    setModels(enabled)
    setModelID((old) =>
      preferredModel && enabled.some((m) => m.id === preferredModel)
        ? preferredModel
        : enabled.some((m) => m.id === old)
          ? old
          : enabled[0]?.id || ''
    )
    const nextVenue = preferredVenue || venue
    const matching = supported.filter((a) => a.exchange_type === nextVenue)
    const nextAccountID = matching.some((a) => a.id === exchangeID)
      ? exchangeID
      : matching[0]?.id || ''
    setExchangeID(nextAccountID)
    if (nextAccountID !== exchangeID) {
      setSelected('')
      setCompare([])
      resetTurn()
    }
    if (preferredVenue && preferredVenue !== venue) {
      requestedVenue.current = preferredVenue
      setVenue(preferredVenue)
      const native = preferredVenue === 'binance' ? 'BTCUSDT' : 'BTC'
      setSymbol(native)
      setSymbolInput(native)
      setSelected('')
      setCompare([])
    }
    setConfigsLoaded(true)
  }
  function openMarket(next: string) {
    marketChosen.current = true
    requestedVenue.current = venue
    setPrice('—')
    setSymbol(next)
    setSymbolInput(next)
    setSelected('')
    resetTurn()
    setCompare([])
    setMessages([])
    setTrace([])
    setError('')
    session.current = crypto.randomUUID()
  }
  async function choose(p: Plan) {
    setSelected(p.id)
    setCompare([])
    setError('')
    await chart.current?.plot(p, data.records[p.id].state, [])
    await chart.current?.focusPlan()
  }
  function changeAccount(id: string) {
    marketChosen.current = true
    abort.current?.abort()
    setExchangeID(id)
    if (!id) setLimits(defaultLimits)
    const a = accounts.find((v) => v.id === id)
    const nextVenue = a?.exchange_type || venue
    requestedVenue.current = nextVenue
    setVenue(nextVenue)
    const native = nextVenue === 'binance' ? 'BTCUSDT' : 'BTC'
    setSymbol(native)
    setSymbolInput(native)
    setSelected('')
    resetTurn()
    setCompare([])
    setMessages([])
    session.current = crypto.randomUUID()
    setPrice('—')
  }
  function viewTrade(trade: LiveRun) {
    marketChosen.current = true
    requestedVenue.current = trade.plan.snapshot.venue
    setVenue(trade.plan.snapshot.venue)
    setExchangeID(trade.exchange_id)
    setSymbol(
      nativeMarket(trade.plan.snapshot.symbol, trade.plan.snapshot.venue)
    )
    setSymbolInput(
      nativeMarket(trade.plan.snapshot.symbol, trade.plan.snapshot.venue)
    )
    setSelected(trade.plan_id)
    setCompare([])
    resetTurn()
    setMessages([])
  }
  function manualEntry(side: 'long' | 'short') {
    setBuilderIdea({
      name: `Manual ${symbol} ${side}`,
      rationale: 'User-created manual limit entry',
      side,
      entry: price === '—' ? '' : price,
      stop: '',
      target: '',
      execution: { kind: 'limit' },
    })
    setBuilder(true)
  }
  async function send(text = instruction) {
    if (busy || !text.trim()) return
    if (
      !modelID ||
      (models.find((m) => m.id === modelID)?.provider === 'claw402' &&
        walletState !== 'ready')
    ) {
      setInstruction(text)
      setSetupOpen('ai')
      return
    }
    const context = chart.current?.context()
    if (!context || context.venue !== venue || context.symbol !== symbol) {
      setError(
        'The chart is still switching markets. Try again once it is ready.'
      )
      return
    }
    // A locked trade is immutable, but it must not lock the whole workspace.
    const separateDraft = Boolean(current && current.state !== 'draft')
    const revisionID = current?.state === 'draft' ? selected : undefined
    const historyMessages = separateDraft
      ? []
      : messages.filter((m) => m.role !== 'error').slice(-16)
    if (separateDraft) {
      session.current = crypto.randomUUID()
      setSelected('')
      setCompare([])
      setMessages([])
    }
    setBusy(true)
    setPlanningBusy(true)
    setAssistantView('chat')
    setError('')
    setInstruction('')
    resetTurn()
    chatFollow.current = true
    setStatus('Reading current market context…')
    setMessages((m) => [
      ...(separateDraft ? [] : m),
      { role: 'user', content: text },
    ])
    const controller = new AbortController()
    abort.current = controller
    let streamStarted = false
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
          plan_id: revisionID,
          execution_kind: 'auto',
          plugin_window: pluginWindow,
          session_id: session.current,
          turn_id: crypto.randomUUID(),
          history: historyMessages,
          constraints: { ...limits, leverage },
          auto_size: Boolean(exchangeID),
        },
        controller.signal,
        (event) => {
          streamStarted = true
          setTrace((items) => recordActivity(items, event))
          if (event.type === 'assistant')
            setMessages((m) => [
              ...m,
              { role: 'assistant', content: String(event.data.message) },
            ])
          if (event.type === 'error') {
            const message = formatRequestError(String(event.data.message), 'en')
            setError(message)
          }
          if (event.type === 'status') setStatus(String(event.data.message))
          if (event.type === 'iteration')
            setStatus(
              `Planning round ${event.data.round} of ${event.data.max_rounds}`
            )
          if (event.type === 'outcome' && Number(event.data.drafts) === 0)
            setStatus(
              'Planning completed without a validated draft. Review the explanation.'
            )
          const mergeChecks = (incoming: PlanCheck[]) =>
            setChecks((previous) => {
              const merged = new Map(previous.map((check) => [check.id, check]))
              incoming.forEach((check) => merged.set(check.id, check))
              return [...merged.values()]
            })
          if (event.type === 'candidate_result')
            mergeChecks([event.data as unknown as PlanCheck])
          if (event.type === 'plans') {
            if (Array.isArray(event.data.checks))
              mergeChecks(event.data.checks as PlanCheck[])
            const plans = event.data.plans as Plan[]
            if (plans?.length) {
              setLimits(plans[0].constraints)
              setTurnPlanIDs((ids) => [
                ...new Set([...ids, ...plans.map((plan) => plan.id)]),
              ])
              setSelected(plans[0].id)
              setAssistantView('plans')
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
      if (!controller.signal.aborted) {
        if (!streamStarted) setMessages(separateDraft ? [] : messages)
        const message = formatRequestError(e, 'en')
        setError(message)
        setTrace((items) =>
          recordActivity(items, { type: 'error', data: { message } })
        )
      }
    } finally {
      if (controller.signal.aborted)
        setTrace((items) =>
          recordActivity(items, { type: 'cancelled', data: {} })
        )
      setBusy(false)
      setPlanningBusy(false)
      setStatus(
        controller.signal.aborted ? 'Planning stopped' : 'Planning finished'
      )
      await reload().catch(() => {})
      await refreshHistory().catch(() => {})
    }
  }
  async function reviewWithAccount(plan: Plan) {
    setBusy(true)
    setError('')
    try {
      const sized = await planningAPI<Plan>('compile', {
        exchange_id: exchangeID,
        venue,
        symbol,
        idea: plan.idea,
        constraints: { ...plan.constraints, leverage },
        auto_size: true,
      })
      await reload()
      setSelected(sized.id)
      setCompare([])
      setLimits(sized.constraints)
      setReview(sized)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function approveAndExecute() {
    if (!review || busy) return
    const locked = review
    setBusy(true)
    setError('')
    try {
      const approved = await planningAPI<LiveRun>('approve', {
        plan_id: locked.id,
        hash: locked.hash,
        confirmed: true,
      })
      setReview(null)
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
        venue,
        symbol,
        idea,
        constraints: { ...limits, leverage },
        auto_size: Boolean(exchangeID),
      })
      setBuilder(false)
      await reload()
      setSelected(p.id)
      setCompare([])
      setReview(p)
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
    resetTurn()
    setCompare([])
    setTrace([])
    setError('')
  }
  const readyRecords = records.filter(
    (r) => r.state === 'draft' && !expired(r.plan, clock)
  )
  const archivedRecords = records.filter((r) => !readyRecords.includes(r))
  const renderPlanCard = (r: PlanningState['records'][string]) => (
    <button
      key={r.plan.id}
      className={'planning-card ' + (selected === r.plan.id ? 'selected' : '')}
      onClick={() => choose(r.plan)}
    >
      <span
        className={r.plan.idea.side === 'long' ? 'target-text' : 'stop-text'}
      >
        {compare.includes(r.plan.id)
          ? String.fromCharCode(65 + compare.indexOf(r.plan.id)) + ' · '
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
          Net reward/risk <b>{Number(r.plan.reward_risk).toFixed(2)} : 1</b>
        </span>
      </div>
      <small>
        {expired(r.plan, clock) && r.state === 'draft'
          ? 'Expired · replan'
          : states[r.state] || r.state}
      </small>
    </button>
  )
  return (
    <div className="planning-page">
      <div className="planning-heading">
        <div>
          <h1>Frontier</h1>
          <p>Your market. Your next move.</p>
        </div>
        <nav className="frontier-workflow" aria-label="How Frontier works">
          <span data-active={!current && !turnPlanIDs.length}>
            <b>1</b> Explore the market
          </span>
          <span data-active={!current && turnPlanIDs.length > 0}>
            <b>2</b> Compare plans
          </span>
          <span data-active={Boolean(current)}>
            <b>3</b> Review & trade
          </span>
        </nav>
        <a className="frontier-account-link" href="#frontier-account">
          Positions & orders ↓
        </a>
        <Link to={ROUTES.settings}>Settings ↗</Link>
      </div>
      <div className="planning-toolbar">
        <div className="frontier-toolbar-field">
          <span>Exchange</span>
          <select
            aria-label="Market venue"
            value={venue}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value
              marketChosen.current = true
              requestedVenue.current = next
              setVenue(next)
              setLimits(defaultLimits)
              setExchangeID(
                accounts.find((a) => a.exchange_type === next)?.id || ''
              )
              const native = next === 'binance' ? 'BTCUSDT' : 'BTC'
              setSymbol(native)
              setSymbolInput(native)
              setSelected('')
              resetTurn()
              setCompare([])
              setMessages([])
              setError('')
              setPrice('—')
              session.current = crypto.randomUUID()
            }}
          >
            <option value="binance">Binance · USDT perpetual</option>
            <option value="hyperliquid">Hyperliquid · perpetual</option>
          </select>
        </div>
        <div className="frontier-toolbar-field">
          <span>Account</span>
          <select
            aria-label="Trading account"
            value={exchangeID}
            onChange={(e) => changeAccount(e.target.value)}
            disabled={busy}
          >
            <option value="">Explore without an account</option>
            {accounts
              .filter((a) => a.exchange_type === venue)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.exchange_type}
                </option>
              ))}
          </select>
        </div>
        <div className="frontier-toolbar-field">
          <span>Market</span>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              openMarket(
                symbolInput.trim().includes(':')
                  ? symbolInput.trim()
                  : symbolInput.trim().toUpperCase()
              )
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
        </div>
        <span className="planning-live">
          <i /> Live trading · You’re in control
        </span>
      </div>
      <FrontierSetup
        models={models}
        modelID={modelID}
        accounts={accounts}
        accountID={exchangeID}
        venue={venue}
        loaded={configsLoaded}
        open={setupOpen}
        onOpen={setSetupOpen}
        onRefresh={refreshSetup}
        onWalletState={setWalletState}
      />
      {
        <FrontierMarkets
          venue={venue}
          disabled={busy}
          selected={symbol}
          walletReady={walletState === 'ready'}
          walletChecking={walletState === 'checking'}
          onSetup={() => setSetupOpen('ai')}
          onSelect={openMarket}
        />
      }
      {error &&
        !trace.some(
          (item) => item.state === 'failed' && item.detail === error
        ) && (
          <div className="planning-error" role="alert">
            {formatRequestError(error, 'en')}
            <button onClick={() => setError('')} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      <div className="planning-workspace">
        <section className="planning-chart-pane">
          <div className="planning-market">
            <div>
              <b>{symbol}</b>
              <strong>{price === '—' ? price : format(price)}</strong>
              <small>
                <i className="frontier-live-dot" /> Live market · {interval}
              </small>
            </div>
            <div>
              <button
                disabled={!current}
                onClick={() => chart.current?.focusPlan()}
              >
                Fit selected plan
              </button>
              <button
                disabled={busy || readyRecords.length < 2}
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
                Compare plans
              </button>
            </div>
          </div>
          <div className="frontier-sizing">
            <label>
              Leverage{' '}
              <select
                aria-label="Planning leverage"
                value={leverage}
                disabled={busy}
                onChange={(e) => setLeverage(Number(e.target.value))}
              >
                {[1, 2, 3, 5, 10, 20].map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </select>
            </label>
            <span>
              {exchangeID
                ? 'Auto size · current free margin · 1% equity risk cap · 5% margin reserve'
                : 'Connect an account for automatic sizing'}
            </span>
          </div>
          <div className="planning-chart-frame">
            <div className="planning-chart" id="chart-container" />
            {current && compare.length < 2 && (
              <ExecutionSchedule plan={current.plan} />
            )}
          </div>
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
                {current.state === 'draft'
                  ? 'Draft · not submitted · '
                  : 'Trade · '}
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
          <details className="frontier-advanced">
            <summary>Chart data & advanced tools</summary>
            <div>
              <details
                className="planning-tools"
                onToggle={(e) => setExtrasOpen(e.currentTarget.open)}
              >
                <summary>Market data and indicators</summary>
                {extrasOpen && (
                  <PlanningDataPanel
                    exchangeID={exchangeID}
                    symbol={symbol}
                    venue={venue}
                    onWindowChange={setPluginWindow}
                  />
                )}
              </details>
              <details className="planning-tools">
                <summary>Risk budget, entry orders and advanced tools</summary>
                <div className="planning-limit-grid">
                  {(
                    Object.keys(defaultLimits) as Exclude<
                      keyof Constraints,
                      'leverage'
                    >[]
                  )
                    .filter(
                      (key) =>
                        !exchangeID ||
                        !['equity', 'max_risk', 'max_notional'].includes(key)
                    )
                    .map((key) => (
                      <label key={key}>
                        {
                          {
                            equity: 'Equity budget',
                            max_risk: 'Maximum planned loss',
                            max_notional: 'Maximum notional',
                            min_reward_risk: 'Minimum net reward/risk',
                            fee_bps: 'Fee assumption / bps',
                            slippage_bps: 'Slippage assumption / bps',
                          }[key]
                        }
                        <input
                          value={limits[key]}
                          inputMode="decimal"
                          disabled={
                            busy ||
                            (Boolean(exchangeID) &&
                              ['equity', 'max_risk', 'max_notional'].includes(
                                key
                              ))
                          }
                          onChange={(e) =>
                            setLimits({ ...limits, [key]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                </div>
                <p>
                  Live sizing refreshes before planning and review. Leverage is
                  a ceiling; stop risk and liquidity can reduce size.
                  Hyperliquid costs must include Builder fees. Gaps, failed
                  protection and slippage may cause losses beyond the estimate.
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
                {tools.length > 0 && (
                  <pre>{JSON.stringify(tools, null, 2)}</pre>
                )}
              </details>
            </div>
          </details>
        </section>
        <aside className="planning-assistant">
          <div className="planning-assistant-title">
            <div>
              <span className="frontier-eyebrow">YOUR TRADING COPILOT</span>
              <b>Trade assistant</b>
            </div>
            <button onClick={newSession} disabled={busy}>
              New idea
            </button>
          </div>
          <details className="frontier-model-settings">
            <summary>
              {models.find((m) => m.id === modelID)?.customModelName ||
                models.find((m) => m.id === modelID)?.name ||
                'Choose AI'}{' '}
              <span>Change model</span>
            </summary>
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
          </details>
          <div className="frontier-assistant-action">
            <button
              className="planning-primary"
              disabled={busy}
              onClick={() =>
                send(
                  instruction.trim() ||
                    'Compare single-limit, weighted ladder and TWAP plans for this market.'
                )
              }
            >
              Generate plans
            </button>
          </div>
          <div
            className="frontier-view-tabs"
            role="tablist"
            aria-label="Trade assistant views"
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return
              event.preventDefault()
              const view =
                event.key === 'Home' || event.key === 'ArrowLeft'
                  ? 'chat'
                  : 'plans'
              setAssistantView(view)
              event.currentTarget
                .querySelector<HTMLButtonElement>(`#frontier-${view}-tab`)
                ?.focus()
            }}
          >
            <button
              id="frontier-chat-tab"
              role="tab"
              aria-selected={assistantView === 'chat'}
              tabIndex={assistantView === 'chat' ? 0 : -1}
              aria-controls="frontier-chat-panel"
              onClick={() => setAssistantView('chat')}
            >
              Assistant
            </button>
            <button
              id="frontier-plans-tab"
              role="tab"
              aria-selected={assistantView === 'plans'}
              tabIndex={assistantView === 'plans' ? 0 : -1}
              aria-controls="frontier-plans-panel"
              onClick={() => setAssistantView('plans')}
            >
              Plans{' '}
              <span>
                {
                  records.filter(
                    (r) => r.state === 'draft' && !expired(r.plan, clock)
                  ).length
                }
              </span>
            </button>
          </div>
          {busy && (
            <div className="planning-progress" role="status" aria-live="polite">
              <span className="planning-spinner" />
              {planningBusy
                ? status || 'Preparing plans…'
                : 'Validating account and order details…'}
              {planningBusy && (
                <button onClick={() => abort.current?.abort()}>Stop</button>
              )}
            </div>
          )}
          <div
            className="planning-thread"
            ref={chatBox}
            onScroll={() => {
              const box = chatBox.current
              if (box)
                chatFollow.current =
                  box.scrollHeight - box.scrollTop - box.clientHeight < 80
            }}
          >
            <div
              className="planning-candidates"
              hidden={assistantView !== 'plans'}
              id="frontier-plans-panel"
              role="tabpanel"
              aria-labelledby="frontier-plans-tab"
            >
              <div className="planning-section-title">
                <b>
                  {busy || checks.length
                    ? `Entry alternatives · ${turnPlanIDs.length} saved`
                    : `Ready plans ${records.filter((r) => r.state === 'draft' && !expired(r.plan, clock)).length}`}
                </b>
              </div>
              <PlanStructures
                checks={checks}
                plans={records
                  .filter((record) => turnPlanIDs.includes(record.plan.id))
                  .map((record) => record.plan)}
                busy={planningBusy}
                selected={selected}
                onSelect={choose}
              />
              {!checks.length && readyRecords.length > 0 && (
                <div className="planning-card-list frontier-ready-plans">
                  {readyRecords.map(renderPlanCard)}
                </div>
              )}
              {archivedRecords.length > 0 && (
                <details className="planning-all-plans">
                  <summary>Past plans · {archivedRecords.length}</summary>
                  <div className="planning-card-list">
                    {archivedRecords.map(renderPlanCard)}
                  </div>
                </details>
              )}
              {readyRecords.length === 0 && !busy && !checks.length && (
                <p>
                  No active plans yet. Generate fresh plans for this market.
                </p>
              )}
            </div>
            <div
              className="planning-messages"
              hidden={assistantView !== 'chat'}
              id="frontier-chat-panel"
              role="tabpanel"
              aria-labelledby="frontier-chat-tab"
            >
              {messages.length === 0 && (
                <div className="frontier-welcome">
                  <span className="frontier-welcome-icon" aria-hidden="true">
                    ✳
                  </span>
                  <h2>
                    Turn a market view
                    <br />
                    into a clear plan.
                  </h2>
                  <p>
                    Tell me what you’re considering. I’ll map out entries, risk
                    and exits for you to review.
                  </p>
                  <div className="frontier-welcome-note">
                    <span>01 Explore</span>
                    <span>02 Compare</span>
                    <span>03 Review & trade</span>
                  </div>
                  <div
                    className="frontier-starters"
                    aria-label="Trade idea suggestions"
                  >
                    <button
                      onClick={() =>
                        setInstruction(
                          'Find a pullback entry with clear risk and exits.'
                        )
                      }
                    >
                      Find a pullback entry <span>↗</span>
                    </button>
                    <button
                      onClick={() =>
                        setInstruction(
                          'Compare a single entry, a price ladder and a timed entry for this market.'
                        )
                      }
                    >
                      Compare ways to enter <span>↗</span>
                    </button>
                    <button
                      onClick={() =>
                        setInstruction(
                          'Mark support and resistance, without creating orders.'
                        )
                      }
                    >
                      Explore key price levels <span>↗</span>
                    </button>
                  </div>
                </div>
              )}
              {messages
                .filter(
                  (m, i) =>
                    m.role !== 'user' ||
                    i === 0 ||
                    messages[i - 1].role !== 'user' ||
                    messages[i - 1].content !== m.content
                )
                .map((m, i) => (
                  <div key={i} className={'planning-message ' + m.role}>
                    {m.content}
                  </div>
                ))}
            </div>
            <div hidden={assistantView !== 'chat'}>
              <PlanningActivity items={trace} busy={planningBusy} />
            </div>
          </div>

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
              placeholder="Ask about this market, or describe a trade…"
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
                Support / resistance
              </button>
              {planningBusy ? (
                <button type="button" onClick={() => abort.current?.abort()}>
                  Stop planning
                </button>
              ) : (
                <button type="submit" disabled={busy || !instruction.trim()}>
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
                      (!!exchangeID && data.accounts[selected] !== exchangeID)
                    }
                    onClick={() => {
                      if (!exchangeID) setSetupOpen('exchange')
                      else void reviewWithAccount(current.plan)
                    }}
                  >
                    {expired(current.plan, clock)
                      ? 'Expired; generate a new plan'
                      : !exchangeID
                        ? 'Connect account to trade'
                        : 'Review order'}
                  </button>
                ) : run?.state === 'approved' ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => runAction('execute', run)}
                    >
                      Place approved orders
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
              <p className="frontier-no-orders">
                <span aria-hidden="true">○</span> Plans are drafts. You approve
                every trade.
              </p>
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
                  resetTurn()
                }}
              >
                {h.symbol} · {h.id.slice(0, 8)}
              </button>
            ))}
          </details>
        </aside>
      </div>
      <div className="frontier-portfolio" id="frontier-account">
        <FrontierAccount
          account={account}
          accounts={accounts}
          venue={venue}
          symbol={symbol}
          runs={data.runs}
          busy={busy}
          onView={viewTrade}
          onManual={manualEntry}
          onBusy={setBusy}
          onRefresh={reload}
        />
        <details className="planning-tools">
          <summary>
            Previous executions ·{' '}
            {
              data.runs.filter(
                (r) =>
                  r.exchange_id === exchangeID &&
                  ['completed', 'cancelled', 'expired'].includes(r.state)
              ).length
            }
          </summary>
          {data.runs
            .filter(
              (r) =>
                r.exchange_id === exchangeID &&
                ['completed', 'cancelled', 'expired'].includes(r.state)
            )
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
              </div>
            ))}
        </details>{' '}
      </div>
      {review && (
        <div className="planning-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="planning-approval-title"
            className="planning-modal"
          >
            <h2 id="planning-approval-title">
              Place {review.idea.side === 'long' ? 'Long' : 'Short'} ·{' '}
              {review.snapshot.symbol}
            </h2>
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
              {review.orders.length || 1} child orders ·{' '}
              {review.constraints.leverage || 1}x leverage
            </p>
            <p>
              Estimated initial margin{' '}
              {format(
                String(
                  (review.orders.length
                    ? review.orders.reduce(
                        (sum, order) =>
                          sum + Number(order.price) * Number(order.quantity),
                        0
                      )
                    : Number(review.idea.entry) * Number(review.quantity)) /
                    (review.constraints.leverage || 1)
                )
              )}{' '}
              {review.snapshot.quote_asset} · fees reserved separately. Quantity
              is locked at this review; balance changes require a new review.
            </p>
            <details>
              <summary>Execution and protection details</summary>
              <p>
                Only the locked, fixed-limit basket will be submitted. Ladder
                entries are released immediately; TWAP slices follow the
                schedule. Partial fills receive matching reduce-only protection.
                Protection failures stop further entries and require manual
                review. Stopping entries does not close filled positions. Actual
                loss can exceed the estimate.
              </p>
            </details>
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
            <details>
              <summary>Locked order reference</summary>
              <code>{review.hash}</code>
            </details>
            <div>
              <button disabled={busy} onClick={() => setReview(null)}>
                Back to review
              </button>
              <button
                className="planning-primary"
                disabled={busy || expired(review, clock)}
                onClick={approveAndExecute}
              >
                Confirm and place live order
              </button>
            </div>
          </section>
        </div>
      )}
      {builder && (
        <div className="planning-modal-backdrop">
          <section role="dialog" aria-modal="true" className="planning-modal">
            <h2>Manual entry · {symbol}</h2>
            <p>
              {account?.name} · {venue} · {leverage}x · automatically sized from
              free margin. Review before submitting.
            </p>
            <label>
              Leverage
              <select
                aria-label="Manual leverage"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
              >
                {[1, 2, 3, 5, 10, 20].map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </select>
            </label>
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
            {(['entry', 'stop', 'target'] as const).map((k) => (
              <label key={k}>
                {
                  {
                    name: 'Name',
                    entry: 'Limit price',
                    stop: 'Stop loss',
                    target: 'Take profit',
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
              Review order
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
