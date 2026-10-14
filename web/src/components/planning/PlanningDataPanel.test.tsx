import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PlanningDataPanel,
  PluginVisualization,
  type PluginVisual,
  type PluginResult,
} from './PlanningDataPanel'
const api = vi.hoisted(() => vi.fn())
vi.mock('../../lib/planning', () => ({ planningAPI: api }))
const manifests = [
  {
    id: 'funding',
    name: '资金费率',
    description: 'public funding',
    enabled: true,
  },
]
const result: PluginResult = {
  plugin: 'funding',
  venue: 'binance',
  symbol: 'BTCUSDT',
  source: 'fixture',
  observed: new Date().toISOString(),
  notice: '当前快照',
  metrics: [
    { key: 'funding_rate', label: '费率', value: '0.0001', unit: 'fraction' },
  ],
}
afterEach(cleanup)
beforeEach(() => {
  api.mockReset()
})
it('loads read-only plugins only on opening and fetches data only on explicit click', async () => {
  api.mockImplementation(async (path: string, body?: unknown) =>
    path === 'data-plugins'
      ? body
        ? [{ ...manifests[0], enabled: false }]
        : manifests
      : result
  )
  render(
    <PlanningDataPanel exchangeID="account" symbol="BTCUSDT" venue="binance" />
  )
  expect(api).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('数据插件 · 资金费率、持仓量、成本与持仓图'))
  const details = screen.getByText('数据插件 · 资金费率、持仓量、成本与持仓图')
    .parentElement! as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
  await screen.findByLabelText('资金费率')
  expect(api.mock.calls.some(([p]) => p.startsWith('plugin-data'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '读取并显示' }))
  await screen.findByText('0.01%')
  fireEvent.click(screen.getByLabelText('资金费率'))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '读取并显示' })).toBeDisabled()
  )
  expect(api).toHaveBeenCalledWith('data-plugins', {
    id: 'funding',
    enabled: false,
  })
  expect(
    api.mock.calls.every(
      ([p]) => p === 'data-plugins' || p.startsWith('plugin-data?')
    )
  ).toBe(true)
})
it('drops a pending response when the market changes', async () => {
  let resolve!: (r: PluginResult) => void
  api.mockImplementation((path: string) =>
    path === 'data-plugins'
      ? Promise.resolve(manifests)
      : new Promise((r) => {
          resolve = r
        })
  )
  const view = render(
    <PlanningDataPanel exchangeID="account" symbol="BTCUSDT" venue="binance" />
  )
  const details = screen.getByText('数据插件 · 资金费率、持仓量、成本与持仓图')
    .parentElement! as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
  await screen.findByLabelText('资金费率')
  fireEvent.click(screen.getByRole('button', { name: '读取并显示' }))
  view.rerender(
    <PlanningDataPanel exchangeID="account" symbol="ETHUSDT" venue="binance" />
  )
  resolve(result)
  await waitFor(() =>
    expect(screen.queryByLabelText('当前插件数据')).toBeNull()
  )
})
it('shows complete zero-based heatmap axes and distinguishes missing cells from zero amounts', () => {
  const visual: PluginVisual = {
    kind: 'winrate-map',
    state: 'observed',
    coverage: 'partial',
    data_at: '2026-10-14T00:00:00Z',
    mark: 100,
    rows: 2,
    columns: 4,
    win_min: 0,
    win_max: 100,
    cost_min: 60,
    cost_max: 140,
    cells: [
      {
        row: 0,
        column: 1,
        long: { count: 2, notional: '100' },
        short: { count: 0, notional: '0' },
      },
    ],
  }
  render(<PluginVisualization visual={visual} />)
  expect(screen.getAllByText('0%')).toHaveLength(2)
  expect(screen.getByText(/历史胜率不是未来胜率/)).toBeInTheDocument()
  expect(
    screen.getAllByRole('button', { name: /该格未返回数据，不能按零统计/ })
      .length
  ).toBeGreaterThan(0)
  fireEvent.click(
    screen.getByRole('button', {
      name: /多仓 · 历史胜率 0–50% · 开仓成本 60–100 USDC · 100 USDC · 2 地址/,
    })
  )
  expect(screen.getByRole('status')).toHaveTextContent('2 地址')
})
it('does not present incomplete profit data as a ranking', () => {
  render(
    <PluginVisualization
      visual={{
        kind: 'profit-leaderboard',
        state: 'building',
        coverage: 'partial',
        data_at: 'now',
        mark: 1,
        rows: 0,
        columns: 0,
        win_min: 0,
        win_max: 100,
        cost_min: 60,
        cost_max: 140,
        entries: [
          {
            rank: 1,
            address: '0x123',
            netPnl: '10000',
            realizedPnl: '10000',
            fees: '0',
            funding: '0',
            volume: '0',
          },
        ],
      }}
    />
  )
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByText('窗口尚未准备完成，不展示排名。')).toBeInTheDocument()
})
