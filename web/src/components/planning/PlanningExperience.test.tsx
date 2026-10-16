import { afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Plan, PlanningEvent } from '../../lib/planning'
import { defaultLimits } from '../../lib/planning'
import { ExecutionSchedule } from './ExecutionSchedule'
import { PlanningActivity, recordActivity } from './PlanningActivity'
import { PlanStructures } from './PlanStructures'
afterEach(cleanup)
const plan = (kind: 'market' | 'limit' | 'ladder' | 'twap'): Plan => ({
  id: kind,
  hash: kind,
  created: new Date().toISOString(),
  expires: new Date(Date.now() + 60000).toISOString(),
  quantity: '0.002',
  risk: '2',
  reward: '5',
  reward_risk: '2.5',
  constraints: defaultLimits,
  snapshot: {
    venue: 'hyperliquid',
    symbol: 'BTC',
    kind: 'perpetual',
    tick: '1',
    step: '0.00001',
    quote_asset: 'USDC',
    base_asset: 'BTC',
  },
  idea: {
    name: kind + ' candidate',
    side: 'long',
    entry: '83000',
    stop: '82000',
    target: '86000',
    rationale: 'Conditional fixture',
    execution: { kind, slices: 2, interval_seconds: 30 },
  },
  orders: [
    { index: 1, price: '83000', quantity: '0.001', offset_seconds: 0 },
    {
      index: 2,
      price: kind === 'ladder' ? '82900' : '83000',
      quantity: '0.001',
      offset_seconds: kind === 'twap' ? 30 : 0,
    },
  ],
})
it('shows each TWAP release on a seconds axis before execution', () => {
  render(<ExecutionSchedule plan={plan('twap')} />)
  expect(
    screen.getByRole('region', { name: 'TWAP release schedule' })
  ).toBeInTheDocument()
  expect(screen.getByText('T+0s')).toBeInTheDocument()
  expect(screen.getByText('T+30s')).toBeInTheDocument()
  expect(screen.getAllByText(/0.001 BTC/)).toHaveLength(2)
  expect(screen.getByText(/starts only after approval/)).toBeInTheDocument()
  expect(screen.getByText(/separate from candle time/)).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /execute/i })
  ).not.toBeInTheDocument()
})
it('shows ladder prices without fake time staggering', () => {
  render(<ExecutionSchedule plan={plan('ladder')} />)
  expect(screen.getByText('Limit 83,000')).toBeInTheDocument()
  expect(screen.getByText('Limit 82,900')).toBeInTheDocument()
  expect(screen.getAllByText('Placed together at start')).toHaveLength(2)
  expect(screen.queryByText('T+30s')).not.toBeInTheDocument()
})
it('shows four structure outcomes without inventing missing valid drafts', () => {
  const select = vi.fn()
  render(
    <PlanStructures
      checks={[
        {
          id: 'rejected',
          kind: 'ladder',
          name: 'Ladder',
          status: 'rejected',
          reason: 'Child order below venue minimum',
        },
      ]}
      plans={[plan('limit'), plan('twap')]}
      busy={false}
      selected="twap"
      onSelect={select}
    />
  )
  expect(screen.getByText('Weighted ladder')).toBeInTheDocument()
  expect(
    screen.getByText('Child order below venue minimum')
  ).toBeInTheDocument()
  expect(screen.getAllByText('Validated draft')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'View on chart' }))
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'limit' }))
})
const event = (type: string, data: Record<string, unknown>): PlanningEvent => ({
  type,
  data,
})
it('updates a live task row with actual timeframe, candle count and measured duration', () => {
  let rows = recordActivity(
    [],
    event('tool_start', { id: 'context', name: 'get_candles' }),
    1000
  )
  rows = recordActivity(
    rows,
    event('tool_result', {
      id: 'context',
      name: 'get_candles',
      ok: true,
      interval: '1h',
      count: 1200,
      scope: 'Visible range',
    }),
    4000
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'done', started: 1000, ended: 4000 })
  render(<PlanningActivity items={rows} busy={false} />)
  expect(
    screen.getByText('1h · 1200 candles · Visible range')
  ).toBeInTheDocument()
  expect(screen.getByText('3s')).toBeInTheDocument()
})
it('streams heartbeats into one waiting row and preserves compiler rejection details', () => {
  let rows = recordActivity([], event('iteration', { round: 1 }), 1000)
  rows = recordActivity(rows, event('status', { elapsed_seconds: 12 }), 13000)
  expect(rows).toHaveLength(1)
  expect(rows[0].detail).toContain('12s')
  rows = recordActivity(
    rows,
    event('candidate_start', {
      id: 'candidate_1_0',
      kind: 'ladder',
      name: 'Weighted entry',
    }),
    14000
  )
  rows = recordActivity(
    rows,
    event('candidate_result', {
      id: 'candidate_1_0',
      kind: 'ladder',
      name: 'Weighted entry',
      status: 'rejected',
      reason: 'Net reward/risk below minimum',
    }),
    14100
  )
  expect(rows[0].state).toBe('done')
  expect(rows[1]).toMatchObject({
    state: 'failed',
    detail: 'Net reward/risk below minimum',
  })
})
it('updates plugin observations without duplicate rows and identifies cancellation', () => {
  let rows = recordActivity(
    [],
    event('tool_start', { id: 'plugin_funding', name: 'get_data_plugin' }),
    1000
  )
  rows = recordActivity(
    rows,
    event('plugin_data', {
      plugin: 'funding',
      metrics: [
        { label: 'Hourly funding', value: '0.00001', unit: 'fraction' },
      ],
    }),
    3000
  )
  expect(rows).toHaveLength(1)
  expect(rows[0].detail).toContain('0.00100%')
  rows = recordActivity(rows, event('iteration', { round: 1 }), 4000)
  rows = recordActivity(rows, event('cancelled', {}), 6000)
  expect(rows.find((row) => row.id === 'model_1')?.state).toBe('failed')
  expect(rows.find((row) => row.id === 'outcome')?.label).toBe(
    'Planning stopped'
  )
})

it('puts market first regardless of model order and labels the estimate', () => {
  const select = vi.fn()
  render(
    <PlanStructures
      checks={[
        { id: 'market', kind: 'market', name: 'Market', status: 'saved' },
      ]}
      plans={[plan('twap'), plan('limit'), plan('market'), plan('ladder')]}
      selected=""
      busy={false}
      onSelect={select}
    />
  )
  const cards = screen.getAllByRole('article')
  expect(cards).toHaveLength(4)
  expect(cards[0]).toHaveTextContent('Market')
  expect(cards[1]).toHaveTextContent('Single limit')
  expect(cards[2]).toHaveTextContent('Weighted ladder')
  expect(cards[3]).toHaveTextContent('TWAP')
  expect(cards[0]).toHaveTextContent('Est. entry')
  expect(cards[0]).toHaveTextContent('Actual fill may differ')
  fireEvent.click(screen.getAllByRole('button', { name: 'View on chart' })[0])
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'market' }))
})
it('does not mislabel immediate market entry as a ladder or timed schedule', () => {
  const { container } = render(<ExecutionSchedule plan={plan('market')} />)
  expect(container).toBeEmptyDOMElement()
})
