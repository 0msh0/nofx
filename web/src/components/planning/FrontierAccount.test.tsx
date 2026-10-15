import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FrontierAccount } from './FrontierAccount'
import type { Exchange } from '../../types'
const mocks = vi.hoisted(() => ({
  traders: vi.fn(),
  positions: vi.fn(),
  close: vi.fn(),
  planning: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: {
    getTraders: mocks.traders,
    getPositions: mocks.positions,
    closePosition: mocks.close,
  },
}))
vi.mock('../../lib/planning', () => ({ planningAPI: mocks.planning }))
vi.mock('../../lib/api/helpers', () => ({
  getAuthHeaders: () => ({}),
  handleJSONResponse: async (r: Response) => {
    if (!r.ok) throw new Error('Exchange read failed')
    return r.json()
  },
}))
const account = {
  id: 'account',
  name: 'My Hyperliquid',
  exchange_type: 'hyperliquid',
  enabled: true,
} as Exchange
const positions = [
  {
    symbol: 'BTCUSDT',
    side: 'short',
    positionAmt: 0.01,
    entryPrice: 83000,
    markPrice: 82000,
    unRealizedProfit: 10,
    leverage: 3,
  },
  {
    symbol: 'ETHUSDT',
    side: 'long',
    positionAmt: 0.1,
    entryPrice: 3000,
    markPrice: 3100,
    unRealizedProfit: 10,
    leverage: 2,
  },
]
beforeEach(() => {
  mocks.traders
    .mockReset()
    .mockResolvedValue([
      { trader_id: 'trader', exchange_id: 'account', is_running: false },
    ])
  mocks.positions.mockReset().mockResolvedValue(positions)
  mocks.close.mockReset().mockResolvedValue({ message: 'accepted' })
  mocks.planning.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              order_id: 'sl',
              symbol: 'BTC',
              side: 'BUY',
              type: 'STOP_MARKET',
              stop_price: 84000,
              quantity: 0.01,
              status: 'NEW',
            },
            {
              order_id: 'tp',
              symbol: 'BTC',
              side: 'BUY',
              type: 'TAKE_PROFIT_MARKET',
              stop_price: 79000,
              quantity: 0.01,
              status: 'NEW',
            },
          ])
        )
    )
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function open(symbol = 'BTC', onManual = vi.fn()) {
  return render(
    <FrontierAccount
      account={account}
      accounts={[account]}
      venue="hyperliquid"
      symbol={symbol}
      runs={[]}
      busy={false}
      onView={vi.fn()}
      onManual={onManual}
      onBusy={vi.fn()}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

it('shows all account positions and native stop/target orders without submitting anything', async () => {
  open()
  await screen.findByText('ETH', { selector: 'strong' })
  expect(screen.getByText('BTC', { selector: 'strong' })).toBeInTheDocument()
  await screen.findByText('Exchange exit orders · BTC')
  expect(screen.getAllByText('84,000')[0]).toBeInTheDocument()
  expect(screen.getAllByText('79,000')[0]).toBeInTheDocument()
  expect(
    screen.getAllByRole('button', { name: 'Close position' })
  ).toHaveLength(2)
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.planning).not.toHaveBeenCalled()
})

it('flags a live position with no reported exit orders without taking action', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('[]'))
  open()
  await screen.findByText(
    /position is open, but no working orders were reported/
  )
  expect(
    screen.getByRole('link', { name: /Check protection at the exchange/ })
  ).toHaveAttribute('href', 'https://app.hyperliquid.xyz/')
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.planning).not.toHaveBeenCalled()
})

it('requires an explicit close click, uses the existing NOFX close API and never repeats a timeout', async () => {
  mocks.close.mockRejectedValue(new Error('timeout'))
  open()
  await screen.findByText('ETH', { selector: 'strong' })
  fireEvent.click(screen.getAllByRole('button', { name: 'Close position' })[0])
  expect(mocks.close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Keep position' }))
  expect(mocks.close).not.toHaveBeenCalled()
  fireEvent.click(screen.getAllByRole('button', { name: 'Close position' })[0])
  fireEvent.click(screen.getByRole('button', { name: 'Confirm market close' }))
  await waitFor(() =>
    expect(mocks.close).toHaveBeenCalledWith('trader', 'BTCUSDT', 'SHORT')
  )
  await screen.findByText(/timeout/)
  expect(
    screen.getByRole('button', { name: 'Verify close at exchange' })
  ).toBeDisabled()
  expect(mocks.close).toHaveBeenCalledTimes(1)
})

it('does not present a failed exchange read as an empty account', async () => {
  mocks.positions.mockRejectedValue(new Error('network unavailable'))
  open()
  await screen.findByRole('alert')
  expect(
    screen.queryByText('No open positions reported by this account.')
  ).toBeNull()
  expect(screen.queryByRole('button', { name: 'Close position' })).toBeNull()
})

it('manual entry opens a review form through its callback, never a model or order request', async () => {
  const manual = vi.fn()
  open('SOL', manual)
  await screen.findByText('ETH', { selector: 'strong' })
  fireEvent.click(screen.getByRole('button', { name: 'Sell / Short' }))
  expect(manual).toHaveBeenCalledWith('short')
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.planning).not.toHaveBeenCalled()
})

it('refuses to close a position that grew after the user reviewed it', async () => {
  open()
  await screen.findByText('ETH', { selector: 'strong' })
  fireEvent.click(screen.getAllByRole('button', { name: 'Close position' })[0])
  mocks.positions.mockResolvedValue([
    { ...positions[0], positionAmt: 1 },
    positions[1],
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Confirm market close' }))
  await screen.findByText(/Position changed/)
  expect(mocks.close).not.toHaveBeenCalled()
})

it('shows position value, visible leverage and explicitly estimated margin without placing orders', async () => {
  render(
    <FrontierAccount
      account={account}
      accounts={[account]}
      venue="hyperliquid"
      symbol="BTC"
      runs={[]}
      busy={false}
      onView={() => {}}
      onManual={() => {}}
      onBusy={() => {}}
      onRefresh={async () => {}}
    />
  )
  expect(await screen.findByText('820.00')).toBeVisible()
  expect(screen.getByText('≈ 273.33')).toBeVisible()
  expect(screen.getByText('3x')).toBeVisible()
  expect(
    screen.getByText('3x').closest('.frontier-position-badge')
  ).toHaveTextContent('Short')
  expect(
    screen.getByRole('columnheader', { name: 'Est. initial margin' })
  ).toBeVisible()
  expect(screen.getByText(/actual exchange margin may differ/)).toBeVisible()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.planning).not.toHaveBeenCalled()
})

it('uses USDT for Binance position amounts', async () => {
  const binance = { ...account, exchange_type: 'binance' }
  render(
    <FrontierAccount
      account={binance}
      accounts={[binance]}
      venue="binance"
      symbol="BTCUSDT"
      runs={[]}
      busy={false}
      onView={() => {}}
      onManual={() => {}}
      onBusy={() => {}}
      onRefresh={async () => {}}
    />
  )
  expect(await screen.findAllByText('USDT notional')).toHaveLength(2)
  expect(screen.queryByText('USDC notional')).toBeNull()
})
