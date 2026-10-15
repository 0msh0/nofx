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
  stream: vi.fn(),
  exchangesGate: undefined as Promise<void> | undefined,
  models: [] as {
    id: string
    name: string
    provider: string
    enabled: boolean
    has_api_key: boolean
  }[],
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
    getTraders: async () => [],
    getModelConfigs: async () => mocks.models,
  },
}))
vi.mock('../lib/planning', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planningAPI: mocks.api,
  streamPlanning: mocks.stream,
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
  mocks.models = [
    {
      id: 'model',
      name: 'Configured DeepSeek',
      provider: 'deepseek',
      enabled: true,
      has_api_key: true,
    },
  ]
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
  mocks.stream
    .mockReset()
    .mockRejectedValue(new Error('Account sizing unavailable'))
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
    if (path.startsWith('setup-wallet'))
      return {
        found: true,
        enabled: true,
        address: '0x1111111111111111111111111111111111111111',
        model_id: 'model',
        chain: 'base',
        asset: 'USDC',
        balance_usdc: '1',
        balance_status: 'ok',
      }
    if (path === 'ai500')
      return {
        coins: [{ pair: 'ETHUSDT', score: 85 }],
        source: 'Claw402 fixture',
        fetched_at: new Date().toISOString(),
      }
    if (path === 'preferences') return { text: '' }
    if (path === 'conversations') return []
    if (path === 'compile')
      return { ...plan('resized'), constraints: { leverage: 5 } }
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
  it('refreshes account sizing and executes only after the explicit review click', async () => {
    open()
    fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
    const card = await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(card)
    await waitFor(() =>
      expect(screen.getByLabelText('NOFX AI model')).toHaveValue('model')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    const execute = await screen.findByRole('button', {
      name: 'Confirm and place live order',
    })
    expect(execute).toBeEnabled()
    expect(screen.queryByLabelText('Live trade confirmation text')).toBeNull()
    expect(mocks.api).toHaveBeenCalledWith(
      'compile',
      expect.objectContaining({ auto_size: true, exchange_id: 'ex' })
    )
    expect(
      mocks.api.mock.calls.some(([p]) => p === 'approve' || p === 'execute')
    ).toBe(false)
    fireEvent.click(execute)
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith('execute', {
        id: 'run',
        hash: 'locked',
      })
    )
    expect(mocks.api).toHaveBeenCalledWith('approve', {
      plan_id: 'resized',
      hash: 'resized'.repeat(4),
      confirmed: true,
    })
  })
  it('selecting a plan exits comparison and displays only that plan on the chart', async () => {
    open()
    fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
    await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(
      screen.getByRole('button', { name: 'Compare plans', exact: true })
    )
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
    fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
    await screen.findByRole('button', { name: /Test plan one/ })
    fireEvent.click(screen.getByText('Chart data & advanced tools'))
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

it('opens the only connected account by default and keeps Binance AI500 reachable', async () => {
  mocks.exchanges = [
    {
      id: 'hl',
      name: 'Hyperliquid wallet',
      exchange_type: 'hyperliquid',
      enabled: true,
    },
  ]
  open()
  await waitFor(() =>
    expect(screen.getByLabelText('Trading account')).toHaveValue('hl')
  )
  expect(screen.getByLabelText('Market venue')).toHaveValue('hyperliquid')
  fireEvent.change(screen.getByLabelText('Market venue'), {
    target: { value: 'binance' },
  })
  expect(screen.getByLabelText('Quick market selection')).toBeVisible()
  await screen.findByRole('button', { name: /ETH/ })
  expect(screen.getByLabelText('Market venue')).toHaveValue('binance')
  expect(screen.getByLabelText('Trading account')).toHaveValue('')
  expect(
    screen.getByRole('region', { name: 'Frontier setup' })
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

it('preflight failure clears busy state without accumulating phantom user messages', async () => {
  open()
  fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
  await screen.findByRole('button', { name: /Test plan one/ })
  const generate = screen.getByRole('button', { name: 'Generate plans' })
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(generate)
    await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(attempt + 1))
    await waitFor(() => expect(generate).toBeEnabled())
  }
  expect(
    screen.queryByText(
      'Compare single-limit, weighted ladder and TWAP plans for this market.'
    )
  ).toBeNull()
  expect(screen.getAllByText('Account sizing unavailable')).toHaveLength(1)
  expect(screen.getByLabelText('Trade idea')).toBeEnabled()
})

it('account review does not restart model activity or show a planning stop button', async () => {
  let finish!: (value: unknown) => void
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const base = mocks.api.getMockImplementation()!
  mocks.api.mockImplementation((path: string, body?: unknown) =>
    path === 'compile' ? pending : base(path, body)
  )
  open()
  fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
  fireEvent.click(await screen.findByRole('button', { name: /Test plan one/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
  await screen.findByText('Validating account and order details…')
  expect(screen.queryByText('Live activity')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stop planning' })).toBeNull()
  finish({ ...plan('resized'), constraints: { leverage: 5 } })
  await screen.findByRole('dialog')
})

it('opens setup before a paid request and retains the original idea when AI is missing', async () => {
  mocks.models = []
  open()
  await screen.findByRole('region', { name: 'Frontier setup' })
  const idea = screen.getByRole('textbox', { name: 'Trade idea' })
  fireEvent.change(idea, {
    target: { value: 'Compare a ladder and TWAP for BTC' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByRole('dialog', { name: 'Enable your AI' })
  ).toBeVisible()
  expect(idea).toHaveValue('Compare a ladder and TWAP for BTC')
  expect(mocks.stream).not.toHaveBeenCalled()
})

it('offers a safe starting point, keeps real account activity separate and supports keyboard views', async () => {
  open()
  await waitFor(() =>
    expect(screen.getByLabelText('NOFX AI model')).toHaveValue('model')
  )
  const positions = screen.getByRole('region', {
    name: 'Account positions and orders',
  })
  expect(positions.closest('.planning-workspace')).toBeNull()
  expect(
    screen.getByText('Chart data & advanced tools').closest('details')
  ).not.toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: /Find a pullback entry/ }))
  expect(screen.getByLabelText('Trade idea')).toHaveValue(
    'Find a pullback entry with clear risk and exits.'
  )
  expect(mocks.stream).not.toHaveBeenCalled()
  expect(
    mocks.api.mock.calls.some(
      ([path]) => path === 'approve' || path === 'execute'
    )
  ).toBe(false)
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Assistant' }), {
    key: 'ArrowRight',
  })
  expect(screen.getByRole('tab', { name: /^Plans/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(screen.getByLabelText('Trade idea')).toHaveValue(
    'Find a pullback entry with clear risk and exits.'
  )
  fireEvent.keyDown(screen.getByRole('tab', { name: /^Plans/ }), {
    key: 'Home',
  })
  expect(screen.getByRole('tab', { name: 'Assistant' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

it('shows generated plans automatically and uses the user idea instead of a generic prompt', async () => {
  mocks.stream.mockImplementation(async (_body, _signal, onEvent) => {
    onEvent({
      type: 'plans',
      data: { plans: [plan('one'), plan('two')], checks: [] },
    })
  })
  open()
  await waitFor(() =>
    expect(screen.getByLabelText('NOFX AI model')).toHaveValue('model')
  )
  fireEvent.change(screen.getByLabelText('Trade idea'), {
    target: { value: 'Compare timed entries for a pullback.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Generate plans' }))
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: /^Plans/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  )
  expect(mocks.stream).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Compare timed entries for a pullback.',
    }),
    expect.anything(),
    expect.any(Function)
  )
  expect(
    mocks.api.mock.calls.some(
      ([path]) => path === 'approve' || path === 'execute'
    )
  ).toBe(false)
})

it('starts a separate draft from a locked trade without revising or executing that trade', async () => {
  const base = mocks.api.getMockImplementation()!
  mocks.api.mockImplementation((path: string, body?: unknown) =>
    path === 'state'
      ? {
          records: { one: { plan: plan('one'), state: 'approved' } },
          accounts: { one: 'ex' },
          runs: [],
          mode: 'live',
          now: new Date().toISOString(),
        }
      : base(path, body)
  )
  mocks.stream.mockResolvedValue(undefined)
  open()
  await waitFor(() =>
    expect(screen.getByLabelText('NOFX AI model')).toHaveValue('model')
  )
  fireEvent.click(screen.getByRole('tab', { name: /^Plans/ }))
  fireEvent.click(await screen.findByText('Past plans · 1'))
  fireEvent.click(await screen.findByRole('button', { name: /Test plan one/ }))
  fireEvent.change(screen.getByLabelText('Trade idea'), {
    target: { value: 'Generate a new independent entry plan.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Generate plans' }))
  await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(1))
  const input = mocks.stream.mock.calls[0][0]
  expect(input.plan_id).toBeUndefined()
  expect(input.history).toEqual([])
  expect(input.message).toBe('Generate a new independent entry plan.')
  expect(
    mocks.api.mock.calls.some(([path]) =>
      ['approve', 'execute', 'stop'].includes(path)
    )
  ).toBe(false)
  expect(screen.queryByText(/AI cannot modify a locked plan/)).toBeNull()
})
