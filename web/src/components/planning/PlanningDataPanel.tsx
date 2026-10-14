import { memo, useEffect, useRef, useState } from 'react'
import { planningAPI } from '../../lib/planning'
import { formatRequestError } from '../../lib/requestErrors'

export interface PluginManifest {
  id: string
  name: string
  description: string
  enabled: boolean
}
interface HeatTotal {
  count: number
  notional: string
}
export interface PluginVisual {
  kind: string
  state: string
  coverage: string
  data_at: string
  window_start?: string
  mark: number
  bins?: {
    px: number
    longCost: number
    shortCost: number
    longLiq: number
    shortLiq: number
  }[]
  cells?: { row: number; column: number; long: HeatTotal; short: HeatTotal }[]
  rows: number
  columns: number
  win_min: number
  win_max: number
  cost_min: number
  cost_max: number
  entries?: {
    rank: number
    address: string
    netPnl: string
    realizedPnl: string
    fees: string
    funding: string
    volume: string
  }[]
}
export interface PluginResult {
  plugin: string
  venue: string
  symbol: string
  source: string
  observed: string
  notice: string
  metrics: { key: string; label: string; value: string; unit: string }[]
  visual?: PluginVisual
}
const num = (n: string | number) =>
  Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const money = (n: string | number) =>
  Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const series = [
  ['longCost', '多仓成本', '#2E8B57'],
  ['shortCost', '空仓成本', '#3575a8'],
  ['longLiq', '多仓估计清算', '#D6433A'],
  ['shortLiq', '空仓估计清算', '#9b6a14'],
] as const

export function PluginVisualization({ visual: v }: { visual: PluginVisual }) {
  const hover = useRef<HTMLDivElement>(null)
  const show = (label: string) => {
    if (hover.current) hover.current.textContent = label
  }

  if (v.kind === 'profit-leaderboard')
    return (
      <>
        <p>
          统计状态：{v.state} · {v.window_start} 至 {v.data_at}
        </p>
        {v.state !== 'ready' ? (
          <p>窗口尚未准备完成，不展示排名。</p>
        ) : (
          <div className="planning-plugin-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">排名</th>
                  <th scope="col">地址</th>
                  <th scope="col">现金净损益 / USDC</th>
                  <th scope="col">已实现盈亏</th>
                  <th scope="col">费用</th>
                  <th scope="col">资金费</th>
                </tr>
              </thead>
              <tbody>
                {v.entries?.map((row) => (
                  <tr key={row.address}>
                    <td>{row.rank}</td>
                    <td title={row.address}>
                      {row.address.slice(0, 8)}…{row.address.slice(-6)}
                    </td>
                    <td>{money(row.netPnl)}</td>
                    <td>{money(row.realizedPnl)}</td>
                    <td>{money(row.fees)}</td>
                    <td>{money(row.funding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    )
  if (v.kind === 'riskbins') {
    const bins = v.bins || [],
      min = bins[0]?.px,
      max = bins[bins.length - 1]?.px
    if (!bins.length) return <p>当前未返回价格桶，不绘制估算数据。</p>
    const peak = Math.max(
      1,
      ...bins.flatMap((b) => series.map(([key]) => b[key]))
    )
    const x = (p: number) => 70 + (860 * (p - min)) / (max - min || 1)
    return (
      <>
        <div className="planning-plugin-legend">
          {series.map(([key, label, color]) => (
            <span key={key}>
              <i style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
        <svg
          role="img"
          aria-label="成本与估计清算金额价格分布"
          viewBox="0 0 1000 270"
        >
          <text x="10" y="15" fill="#6B6557">
            金额 / USDC
          </text>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line
                x1="70"
                x2="930"
                y1={220 - t * 180}
                y2={220 - t * 180}
                stroke="#ddd7cb"
              />
              <text x="2" y={224 - t * 180} fill="#6B6557" fontSize="11">
                {money(peak * t)}
              </text>
            </g>
          ))}
          {bins.map((b) =>
            series.map(([key, label, color], i) => (
              <line
                key={b.px + key}
                x1={x(b.px) + (i - 1.5) * 1.5}
                x2={x(b.px) + (i - 1.5) * 1.5}
                y1="220"
                y2={220 - (b[key] / peak) * 180}
                stroke={color}
                strokeWidth="1.5"
              >
                <title>
                  {label} · 价格 {num(b.px)} · {money(b[key])} USDC
                </title>
              </line>
            ))
          )}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <text
              key={t}
              x={70 + t * 860}
              y="244"
              textAnchor="middle"
              fill="#6B6557"
              fontSize="11"
            >
              {num(min + t * (max - min))}
            </text>
          ))}
          {v.mark >= min && v.mark <= max && (
            <g>
              <line
                x1={x(v.mark)}
                x2={x(v.mark)}
                y1="30"
                y2="220"
                stroke="#9b6a14"
                strokeDasharray="4"
              />
              <text x={x(v.mark)} y="25" fill="#9b6a14" fontSize="12">
                参考价 {num(v.mark)}
              </text>
            </g>
          )}
          <text x="930" y="266" textAnchor="end" fill="#6B6557" fontSize="11">
            价格 / USDC →
          </text>
        </svg>
      </>
    )
  }
  if (v.kind !== 'winrate-map') return <p>没有可展示的图表。</p>
  if (
    !(
      v.rows > 0 &&
      v.rows <= 40 &&
      v.columns >= 3 &&
      v.columns <= 42 &&
      v.win_max > v.win_min &&
      v.cost_max > v.cost_min &&
      v.mark > 0
    )
  )
    return <p>热图坐标不完整，无法可靠显示。</p>
  const cells = v.cells || [],
    actualPeak = Math.max(
      0,
      ...cells.flatMap((c) => [
        Number(c.long.notional),
        Number(c.short.notional),
      ])
    ),
    peak = actualPeak || 1,
    lookup = new Map(cells.map((c) => [c.row + ':' + c.column, c]))
  const bounds = (row: number, col: number) => {
    const step = (v.cost_max - v.cost_min) / (v.columns - 2),
      lo = v.win_min + (row * (v.win_max - v.win_min)) / v.rows,
      hi = v.win_min + ((row + 1) * (v.win_max - v.win_min)) / v.rows
    const cost =
      col === 0
        ? '＜' + num((v.mark * v.cost_min) / 100)
        : col === v.columns - 1
          ? '≥' + num((v.mark * v.cost_max) / 100)
          : num((v.mark * (v.cost_min + (col - 1) * step)) / 100) +
            '–' +
            num((v.mark * (v.cost_min + col * step)) / 100)
    return { lo, hi, cost }
  }
  return (
    <>
      <p>
        颜色越亮，当前持仓金额越大；左右图共用金额刻度。历史胜率不是未来胜率。参考价{' '}
        {num(v.mark)} USDC。
      </p>
      <div className="planning-plugin-heat-pair">
        {(['long', 'short'] as const).map((side) => (
          <section key={side}>
            <b>
              {side === 'long' ? '多仓' : '空仓'} ·
              当前持仓按历史胜率与开仓成本分组
            </b>
            <small>↑ 历史已闭合回合胜率 / %</small>
            <svg
              role="img"
              aria-label={
                (side === 'long' ? '多仓' : '空仓') + '历史胜率持仓热图'
              }
              viewBox="0 0 620 310"
            >
              {[0, 0.5, 1].map((t) => (
                <text
                  key={t}
                  x="2"
                  y={250 - t * 220}
                  fill="#6B6557"
                  fontSize="12"
                >
                  {num(v.win_min + t * (v.win_max - v.win_min))}%
                </text>
              ))}
              {Array.from({ length: v.rows }, (_, r) =>
                Array.from({ length: v.columns }, (_, c) => {
                  const datum = lookup.get(r + ':' + c)?.[side],
                    b = bounds(r, c),
                    label = `${side === 'long' ? '多仓' : '空仓'} · 历史胜率 ${num(b.lo)}–${num(b.hi)}% · 开仓成本 ${b.cost} USDC · ${datum ? money(datum.notional) + ' USDC · ' + datum.count + ' 地址' : '该格未返回数据，不能按零统计'}`
                  return (
                    <rect
                      key={r + ':' + c}
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      x={60 + (c * 550) / v.columns}
                      y={25 + ((v.rows - r - 1) * 220) / v.rows}
                      width={Math.max(1, 550 / v.columns - 1)}
                      height={Math.max(1, 220 / v.rows - 1)}
                      fill={
                        datum
                          ? `rgba(${side === 'long' ? '120,182,251' : '242,140,140'},${0.06 + 0.94 * Math.sqrt(Number(datum.notional) / peak)})`
                          : '#e8e2d7'
                      }
                      onMouseEnter={() => show(label)}
                      onFocus={() => show(label)}
                      onClick={() => show(label)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          show(label)
                        }
                      }}
                    >
                      <title>{label}</title>
                    </rect>
                  )
                })
              )}
              {[0, 0.5, 1].map((t) => (
                <text
                  key={t}
                  x={60 + ((1 + t * (v.columns - 2)) * 550) / v.columns}
                  y="270"
                  textAnchor="middle"
                  fill="#6B6557"
                  fontSize="11"
                >
                  {t === 0 ? '＜' : t === 1 ? '≥' : ''}
                  {num(v.cost_min + t * (v.cost_max - v.cost_min))}%
                </text>
              ))}
              <text
                x="610"
                y="300"
                textAnchor="end"
                fill="#6B6557"
                fontSize="12"
              >
                开仓成本 / 统计参考价 →
              </text>
            </svg>
          </section>
        ))}
      </div>
      <p>
        共同金额刻度：暗色 0 → 最亮 {money(actualPeak)}{' '}
        USDC。最左、最右列为成本范围外的持仓。100% 表示本快照参考价。
      </p>
      <div ref={hover} className="planning-plugin-hover" role="status">
        悬停或点击格子，查看历史胜率、成本价格和持仓金额。
      </div>
    </>
  )
}

export const PlanningDataPanel = memo(function PlanningDataPanel({
  exchangeID,
  symbol,
  venue,
  onWindowChange,
}: {
  exchangeID: string
  symbol: string
  venue: string
  onWindowChange?: (window: string) => void
}) {
  const [opened, setOpened] = useState(false),
    [items, setItems] = useState<PluginManifest[]>([]),
    [error, setError] = useState(''),
    [result, setResult] = useState<PluginResult | null>(null),
    [busy, setBusy] = useState(false),
    [windowDays, setWindow] = useState('7d')
  const serial = useRef(0)
  useEffect(() => {
    serial.current++
    setResult(null)
    setError('')
    setBusy(false)
    return () => {
      serial.current++
    }
  }, [exchangeID, symbol, windowDays])
  useEffect(() => {
    if (!opened) return
    let alive = true
    planningAPI<PluginManifest[]>('data-plugins')
      .then((rows) => {
        if (alive) setItems(rows)
      })
      .catch((e) => alive && setError(formatRequestError(e, 'zh')))
    return () => {
      alive = false
    }
  }, [opened])
  async function toggle(item: PluginManifest) {
    const version = ++serial.current
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const rows = await planningAPI<PluginManifest[]>('data-plugins', {
        id: item.id,
        enabled: !item.enabled,
      })
      if (version === serial.current) setItems(rows)
    } catch (e) {
      if (version === serial.current) setError(formatRequestError(e, 'zh'))
    } finally {
      if (version === serial.current) setBusy(false)
    }
  }
  async function read(item: PluginManifest) {
    const version = ++serial.current
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const q = new URLSearchParams({
        exchange_id: exchangeID,
        symbol,
        plugin: item.id,
        window: windowDays,
      })
      const r = await planningAPI<PluginResult>('plugin-data?' + q)
      if (r.symbol !== symbol || r.venue !== venue)
        throw new Error('组件数据与当前标的不一致')
      if (version === serial.current) setResult(r)
    } catch (e) {
      if (version === serial.current) setError(formatRequestError(e, 'zh'))
    } finally {
      if (version === serial.current) setBusy(false)
    }
  }
  return (
    <details
      className="planning-tools planning-data-panel"
      onToggle={(e) => setOpened(e.currentTarget.open)}
    >
      <summary>数据插件 · 资金费率、持仓量、成本与持仓图</summary>
      {opened && (
        <>
          <p>
            启用后，规划助手才能调用该数据源。这里只读当前标的，不会下单；Hyperdata
            组件仅适用于 Hyperliquid 同名市场。
          </p>
          <label>
            统计窗口
            <select
              aria-label="插件统计窗口"
              value={windowDays}
              onChange={(e) => {
                setWindow(e.target.value)
                onWindowChange?.(e.target.value)
              }}
            >
              <option value="7d">近 7 日</option>
              <option value="30d">近 30 日</option>
            </select>
          </label>
          <div className="planning-plugin-switches">
            {items.map((item) => (
              <div key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    disabled={busy}
                    onChange={() => toggle(item)}
                  />
                  {item.name}
                </label>
                <small>{item.description}</small>
                <button
                  disabled={
                    busy ||
                    !exchangeID ||
                    !item.enabled ||
                    (item.id.startsWith('hyperdata_') &&
                      venue !== 'hyperliquid')
                  }
                  onClick={() => read(item)}
                >
                  读取并显示
                </button>
              </div>
            ))}
          </div>
          {busy && <p role="status">正在读取组件…</p>}
          {error && (
            <p role="alert" className="stop-text">
              {error}
            </p>
          )}
          {result && (
            <section aria-label="当前插件数据">
              <div className="planning-plugin-metrics">
                {result.metrics.map((m) => (
                  <div key={m.key}>
                    <small>{m.label}</small>
                    <b>
                      {m.unit === 'fraction'
                        ? num(Number(m.value) * 100) + '%'
                        : num(m.value) + ' ' + m.unit}
                    </b>
                  </div>
                ))}
              </div>
              {result.visual && <PluginVisualization visual={result.visual} />}
              <p>{result.notice}</p>
              <small>
                来源 {result.source} · 接收时间{' '}
                {new Date(result.observed).toLocaleString()}{' '}
                {result.visual &&
                  ' · 统计截止 ' +
                    result.visual.data_at +
                    ' · 覆盖 ' +
                    result.visual.coverage}
              </small>
            </section>
          )}
        </>
      )}
    </details>
  )
})
