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
  exchangesGate: undefined as Promise<void> | undefined,
  exchanges: [] as {
    id: string
    name: string
    exchange_type: string
    enabled: boolean
  }[],
  chartOptions: undefined as
    | undefined
    | {
        onError: (message: string) => void
        onAvailability: (available: boolean) => void
      },
  plot: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/api', () => ({
  api: {
    getExchangeConfigs: async () => {
      await mocks.exchangesGate
      return mocks.exchanges
    },
    getModelConfigs: async () => [
      {
        id: 'model',
        name: 'Configured DeepSeek',
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
      constructor(options: NonNullable<typeof mocks.chartOptions>) {
        mocks.chartOptions = options
      }
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
    name: 'Test plan ' + id,
    side: 'long',
    entry: '80000',
    stop: '79000',
    target: '83000',
    rationale: 'Conditional hypothesis',
    execution: { kind: 'limit' },
  },
  orders: [{ index: 1, price: '80000', quantity: '0.01', offset_seconds: 0 }],
})
beforeEach(() => {
  mocks.exchangesGate = undefined
  mocks.exchanges = [
    {
      id: 'ex',
      name: 'Connected account',
      exchange_type: 'binance',
      enabled: true,
    },
  ]
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
    if (path === 'ai500')
      return {
        coins: [{ pair: 'ETHUSDT', score: 85 }],
        source: 'Claw402 fixture',
        fetched_at: new Date().toISOString(),
      }
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
    const card = await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(card)
    await waitFor(() =>
      expect(screen.getByLabelText('NOFX AI model')).toHaveValue('model')
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Review and approve live trade' })
    )
    const execute = screen.getByRole('button', {
      name: 'Approve and execute live trade',
    })
    expect(execute).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Live trade confirmation text'), {
      target: { value: 'approve live' },
    })
    expect(execute).toBeDisabled()
    expect(
      mocks.api.mock.calls.some(([p]) => p === 'approve' || p === 'execute')
    ).toBe(false)
    fireEvent.change(screen.getByLabelText('Live trade confirmation text'), {
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
    await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(screen.getByRole('button', { name: 'Compare on chart' }))
    await waitFor(() =>
      expect(
        mocks.plot.mock.calls.some(([, , list]) => list?.length === 2)
      ).toBe(true)
    )
    fireEvent.click(screen.getByRole('button', { name: /Test plan two/ }))
    await waitFor(() => {
      const args = mocks.plot.mock.calls.at(-1)!
      expect(args[0].id).toBe('two')
      expect(args[2]).toEqual([])
    })
  })
  it('custom entry mode does not attach TWAP parameters to a ladder', async () => {
    open()
    await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(
      screen.getByText('Risk budget, entry orders and advanced tools')
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Custom limit / ladder / TWAP' })
    )
    fireEvent.change(screen.getByLabelText('Custom entry method'), {
      target: { value: 'ladder' },
    })
    expect(screen.queryByLabelText('Slices')).toBeNull()
    expect(
      screen.getByText(/Enter one price and quantity weight per line/)
    ).toBeInTheDocument()
  })
})

it('shows Binance futures and AI500 even when only a Hyperliquid account is connected', async () => {
  mocks.exchanges = [
    {
      id: 'hl',
      name: 'Hyperliquid wallet',
      exchange_type: 'hyperliquid',
      enabled: true,
    },
  ]
  open()
  await screen.findByRole('button', { name: /ETH/ })
  expect(screen.getByLabelText('Market venue')).toHaveValue('binance')
  expect(screen.getByLabelText('Trading account')).toHaveValue('')
  expect(
    screen.getByText(/Public market planning is available/)
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /ETH/ }))
  expect(screen.getByLabelText('Symbol')).toHaveValue('ETHUSDT')
  fireEvent.change(screen.getByLabelText('Market venue'), {
    target: { value: 'hyperliquid' },
  })
  expect(screen.getByLabelText('Trading account')).toHaveValue('hl')
  expect(screen.getByLabelText('Symbol')).toHaveValue('BTC')
  expect(screen.queryByLabelText('Binance AI500 markets')).toBeNull()
})

it('clears a chart failure after recovery without clearing unrelated errors', async () => {
  render(
    <MemoryRouter>
      <TradingPlanningPage />
    </MemoryRouter>
  )
  await waitFor(() => expect(mocks.chartOptions).toBeDefined())
  const { act } = await import('@testing-library/react')
  act(() => mocks.chartOptions!.onError('Market chart timed out.'))
  expect(screen.getByText('Market chart timed out.')).toBeInTheDocument()
  act(() => mocks.chartOptions!.onAvailability(true))
  expect(screen.queryByText('Market chart timed out.')).not.toBeInTheDocument()
})

it('keeps a venue chosen while account configuration is still loading', async () => {
  let release!: () => void
  mocks.exchanges = [
    {
      id: 'hl',
      name: 'Hyperliquid wallet',
      exchange_type: 'hyperliquid',
      enabled: true,
    },
  ]
  mocks.exchangesGate = new Promise<void>((resolve) => {
    release = resolve
  })
  open()
  fireEvent.change(screen.getByLabelText('Market venue'), {
    target: { value: 'hyperliquid' },
  })
  release()
  await waitFor(() =>
    expect(screen.getByLabelText('Trading account')).toHaveValue('hl')
  )
  expect(screen.getByLabelText('Symbol')).toHaveValue('BTC')
  expect(screen.getByLabelText('Market venue')).toHaveValue('hyperliquid')
})
