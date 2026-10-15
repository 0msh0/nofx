import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { AITradersPage } from './AITradersPage'
const mocks = vi.hoisted(() => ({
  user: { id: 'user' },
  models: vi.fn(),
  accounts: vi.fn(),
  states: vi.fn(),
  update: vi.fn(),
  launch: vi.fn(),
}))
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, token: 'fixture' }),
}))
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en' }),
}))
vi.mock('swr', () => ({
  default: () => ({ data: [], mutate: vi.fn(), isLoading: false }),
}))
vi.mock('../../lib/api', () => ({
  api: {
    getModelConfigs: mocks.models,
    getExchangeConfigs: mocks.accounts,
    getExchangeAccountState: mocks.states,
    getSupportedModels: async () => [],
    updateModelConfigs: mocks.update,
    createTrader: mocks.update,
  },
}))
vi.mock('./AutopilotLaunchPanel', () => ({
  AutopilotLaunchPanel: () => {
    mocks.launch()
    return <div>Guided setup panel</div>
  },
}))
vi.mock('./TradersList', () => ({
  TradersList: () => <div>Saved Autopilots</div>,
}))
vi.mock('./ModelConfigModal', () => ({
  ModelConfigModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="AI connection">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))
vi.mock('./ExchangeConfigModal', () => ({
  ExchangeConfigModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Trading account">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))
vi.mock('./TraderConfigModal', () => ({
  TraderConfigModal: () => <div role="dialog">Create Autopilot</div>,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.models.mockResolvedValue([
    {
      id: 'ai',
      name: 'My AI',
      provider: 'deepseek',
      enabled: true,
      has_api_key: true,
      customModelName: 'configured-model',
    },
  ])
  mocks.accounts.mockResolvedValue([
    {
      id: 'exchange',
      name: 'My account',
      exchange_type: 'binance',
      enabled: true,
      type: 'cex',
    },
  ])
  mocks.states.mockResolvedValue({ states: {} })
})
afterEach(cleanup)
const open = (path = '/traders') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AITradersPage />
    </MemoryRouter>
  )
it('starts with connections without mounting automated launch or writing configuration', async () => {
  open()
  expect(
    await screen.findByRole('button', { name: 'Edit My AI' })
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Edit My account' })).toBeVisible()
  expect(screen.getByText('Not checked')).toBeVisible()
  expect(screen.getByText('Not available')).toBeVisible()
  expect(screen.queryByText(/Telegram|Notifications/)).toBeNull()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Add AI', exact: true }))
  expect(screen.getByRole('dialog', { name: 'AI connection' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }))
  fireEvent.click(
    screen.getByRole('button', { name: 'Add account', exact: true })
  )
  expect(screen.getByRole('dialog', { name: 'Trading account' })).toBeVisible()
  expect(mocks.update).not.toHaveBeenCalled()
})
it('opens guided Autopilot setup only on request and preserves saved connections', async () => {
  open()
  await screen.findByRole('button', { name: 'Edit My AI' })
  fireEvent.click(
    screen.getByRole('button', { name: /Autopilot Optional automated trading/ })
  )
  expect(screen.getByText('Saved Autopilots')).toBeVisible()
  expect(mocks.launch).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: 'Guided setup', exact: true })
  )
  expect(screen.getByText('Guided setup panel')).toBeVisible()
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: /Connections AI & trading accounts/ })
  )
  expect(screen.getByRole('button', { name: 'Edit My AI' })).toBeVisible()
})
it('keeps disabled saved AI connections editable and treats failed balances as unknown', async () => {
  mocks.models.mockResolvedValue([
    {
      id: 'ai',
      name: 'Disabled AI',
      provider: 'deepseek',
      enabled: false,
      has_api_key: true,
    },
  ])
  mocks.states.mockRejectedValue(new Error('fixture unavailable'))
  open()
  expect(
    await screen.findByRole('button', { name: 'Edit Disabled AI' })
  ).toBeVisible()
  expect(screen.getByText('Disabled')).toBeVisible()
  expect(screen.getByText('Not available')).toBeVisible()
  expect(mocks.update).not.toHaveBeenCalled()
})
it('shows a read failure instead of inventing an empty successful configuration', async () => {
  mocks.models.mockRejectedValue(new Error('fixture unavailable'))
  open()
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connections could not be loaded'
    )
  )
  expect(mocks.update).not.toHaveBeenCalled()
})
