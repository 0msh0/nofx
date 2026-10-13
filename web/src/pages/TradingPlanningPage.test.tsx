import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { TradingPlanningPage } from './TradingPlanningPage'
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  plot: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/api', () => ({
  api: {
    getExchangeConfigs: async () => [
      { id: 'ex', name: '已连接账户', exchange_type: 'binance', enabled: true },
    ],
    getModelConfigs: async () => [
      {
        id: 'model',
        name: '已有 DeepSeek',
        provider: 'deepseek',
        enabled: true,
        has_api_key: true,
      },
    ],
  },
}))
vi.mock('../lib/planning', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planningAPI: mocks.api,
  loadPlanningChart: async () => {
    window.WorkspaceChart = class {
      context() {
        return {
          venue: 'binance',
          symbol: 'BTCUSDT',
          interval: '1h',
          resolution: '60',
        }
      }
      async whenReady() {}
      async setContext() {}
      plot = mocks.plot
      focusPlan = mocks.focus
      async draw() {}
      dispose() {}
    }
  },
}))
const plan = (id: string) => ({
  id,
  hash: id.repeat(4),
  created: new Date().toISOString(),
  expires: new Date(Date.now() + 300000).toISOString(),
  quantity: '0.01',
  risk: '10',
  reward: '25',
  reward_risk: '2.5',
  constraints: {},
  snapshot: {
    venue: 'binance',
    symbol: 'BTCUSDT',
    kind: 'perpetual',
    base_asset: 'BTC',
    quote_asset: 'USDT',
  },
  idea: {
    name: '测试方案 ' + id,
    side: 'long',
    entry: '80000',
    stop: '79000',
    target: '83000',
    rationale: '条件假设',
    execution: { kind: 'limit' },
  },
  orders: [{ index: 1, price: '80000', quantity: '0.01', offset_seconds: 0 }],
})
beforeEach(() => {
  mocks.api.mockReset()
  mocks.plot.mockClear()
  mocks.api.mockImplementation(async (path: string) => {
    if (path === 'state')
      return {
        records: {
          one: { plan: plan('one'), state: 'draft' },
          two: { plan: plan('two'), state: 'draft' },
        },
        accounts: { one: 'ex', two: 'ex' },
        runs: [],
        mode: 'live',
        now: new Date().toISOString(),
      }
    if (path.startsWith('account?'))
      return { equity: '1000', available: '1000', fee_bps: '5' }
    if (path === 'preferences') return { text: '' }
    if (path === 'conversations') return []
    if (path === 'approve') return { id: 'run', approval_hash: 'locked' }
    return {}
  })
})
afterEach(cleanup)
function open() {
  return render(
    <MemoryRouter>
      <TradingPlanningPage />
    </MemoryRouter>
  )
}
describe('NOFX live planning', () => {
  it('reuses configured model and requires exact human approval before execution', async () => {
    open()
    const card = await screen.findByRole('button', { name: /测试方案 one/ })
    fireEvent.click(card)
    await waitFor(() =>
      expect(screen.getByLabelText('NOFX AI 模型')).toHaveValue('model')
    )
    fireEvent.click(screen.getByRole('button', { name: '审阅并批准真实交易' }))
    const execute = screen.getByRole('button', { name: '批准并执行真实交易' })
    expect(execute).toBeDisabled()
    fireEvent.change(screen.getByLabelText('真实交易确认文字'), {
      target: { value: 'approve live' },
    })
    expect(execute).toBeDisabled()
    expect(
      mocks.api.mock.calls.some(([p]) => p === 'approve' || p === 'execute')
    ).toBe(false)
    fireEvent.change(screen.getByLabelText('真实交易确认文字'), {
      target: { value: 'APPROVE LIVE' },
    })
    fireEvent.click(execute)
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith('execute', {
        id: 'run',
        hash: 'locked',
      })
    )
    expect(mocks.api).toHaveBeenCalledWith('approve', {
      plan_id: 'one',
      hash: 'one'.repeat(4),
      confirmation: 'APPROVE LIVE',
    })
  })
  it('selecting a plan exits comparison and displays only that plan on the chart', async () => {
    open()
    await screen.findByRole('button', { name: /测试方案 one/ })
    fireEvent.click(screen.getByRole('button', { name: '在图上比较' }))
    await waitFor(() =>
      expect(
        mocks.plot.mock.calls.some(([, , list]) => list?.length === 2)
      ).toBe(true)
    )
    fireEvent.click(screen.getByRole('button', { name: /测试方案 two/ }))
    await waitFor(() => {
      const args = mocks.plot.mock.calls.at(-1)!
      expect(args[0].id).toBe('two')
      expect(args[2]).toEqual([])
    })
  })
  it('custom entry mode does not attach TWAP parameters to a ladder', async () => {
    open()
    await screen.findByRole('button', { name: /测试方案 one/ })
    fireEvent.click(screen.getByText('风险预算、分批订单与高级工具'))
    fireEvent.click(
      screen.getByRole('button', { name: '自定义单笔／分批／TWAP' })
    )
    fireEvent.change(screen.getByLabelText('自定义入场方式'), {
      target: { value: 'ladder' },
    })
    expect(screen.queryByLabelText('片数')).toBeNull()
    expect(screen.getByText(/每行填写价格与数量权重/)).toBeInTheDocument()
  })
})
