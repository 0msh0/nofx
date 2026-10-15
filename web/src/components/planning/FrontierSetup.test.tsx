import { StrictMode } from 'react'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FrontierSetup, feeWalletState } from './FrontierSetup'
const mocks = vi.hoisted(() => ({ api: vi.fn(), create: vi.fn() }))
vi.mock('../../lib/planning', () => ({ planningAPI: mocks.api }))
vi.mock('../../lib/api', () => ({
  api: { createExchangeEncrypted: mocks.create },
}))
vi.mock('../common/HyperliquidWalletConnect', () => ({
  HyperliquidWalletConnect: ({ onSaved }: { onSaved: () => void }) => (
    <button onClick={onSaved}>Mock authorized connection saved</button>
  ),
}))
vi.mock('../trader/ExchangeConfigModal', () => ({
  ExchangeConfigModal: () => null,
}))
const address = '0x1111111111111111111111111111111111111111'
const missing = {
  found: false,
  enabled: false,
  chain: 'base',
  asset: 'USDC',
  balance_status: 'unknown',
}
const refresh = vi.fn().mockResolvedValue(undefined),
  open = vi.fn(),
  state = vi.fn()
beforeEach(() => {
  mocks.api.mockReset()
  refresh.mockClear()
  open.mockClear()
  state.mockClear()
  mocks.api.mockResolvedValue(missing)
})
afterEach(cleanup)
function show(step: 'ai' | 'exchange' | null = 'ai', direct = false) {
  return render(
    <StrictMode>
      <MemoryRouter>
        <FrontierSetup
          models={
            direct
              ? [
                  {
                    id: 'direct',
                    name: 'My AI',
                    provider: 'deepseek',
                    enabled: true,
                    has_api_key: true,
                  },
                ]
              : []
          }
          modelID={direct ? 'direct' : ''}
          accounts={[]}
          accountID=""
          venue="hyperliquid"
          loaded
          open={step}
          onOpen={open}
          onRefresh={refresh}
          onWalletState={state}
        />
      </MemoryRouter>
    </StrictMode>
  )
}
it('creates the fee wallet only after a click and then waits for a verified deposit', async () => {
  let created = false
  mocks.api.mockImplementation(async (_path: string, body: unknown) => {
    if (body) created = true
    return created
      ? {
          ...missing,
          found: true,
          enabled: true,
          address,
          model_id: 'new-model',
          balance_usdc: '0',
          balance_status: 'ok',
        }
      : missing
  })
  show()
  const button = await screen.findByRole('button', { name: 'Create AI wallet' })
  await waitFor(() => expect(button).toBeEnabled())
  expect(mocks.api.mock.calls.every((call) => call.length === 1)).toBe(true)
  fireEvent.click(button)
  await waitFor(() => expect(refresh).toHaveBeenCalledWith('new-model'))
  expect(mocks.api.mock.calls.filter((call) => call.length === 2)).toHaveLength(
    1
  )
  expect(
    screen.getByRole('button', { name: 'Continue to exchange' })
  ).toBeDisabled()
  expect(
    screen.queryByRole('button', { name: /execute|place live order/i })
  ).toBeNull()
})
it('never retries an unconfirmed setup mutation automatically', async () => {
  mocks.api.mockImplementation(async (_path: string, body: unknown) => {
    if (body) throw new Error('request interrupted')
    return missing
  })
  show()
  const button = await screen.findByRole('button', { name: 'Create AI wallet' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'could not be confirmed'
  )
  expect(mocks.api.mock.calls.filter((call) => call.length === 2)).toHaveLength(
    1
  )
})
it('lets an existing direct AI provider continue without a fee-wallet deposit', async () => {
  show('ai', true)
  expect(screen.getByText('Your AI is connected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Continue to exchange' }))
  expect(open).toHaveBeenCalledWith('exchange')
  expect(mocks.api.mock.calls.every((call) => call.length === 1)).toBe(true)
})
it('refreshes a saved exchange in place without starting trading or the model', async () => {
  show('exchange', true)
  fireEvent.click(
    screen.getByRole('button', { name: 'Mock authorized connection saved' })
  )
  await waitFor(() =>
    expect(refresh).toHaveBeenCalledWith(undefined, 'hyperliquid')
  )
  expect(open).toHaveBeenCalledWith(null)
  expect(mocks.create).not.toHaveBeenCalled()
})
it('does not treat an unknown or malformed balance as funded', () => {
  for (const balance of [undefined, '', 'NaN', '-1'])
    expect(
      feeWalletState({
        ...missing,
        found: true,
        enabled: true,
        balance_usdc: balance,
        balance_status: 'ok',
      })
    ).toBe('unknown')
  expect(
    feeWalletState({
      ...missing,
      found: true,
      enabled: true,
      balance_usdc: '0.000001',
      balance_status: 'ok',
    })
  ).toBe('ready')
})
