import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import type { AIModel, Exchange } from '../../types'
import { api } from '../../lib/api'
import { planningAPI } from '../../lib/planning'
import { HyperliquidWalletConnect } from '../common/HyperliquidWalletConnect'
import { ExchangeConfigModal } from '../trader/ExchangeConfigModal'

export type FeeWalletState =
  | 'checking'
  | 'missing'
  | 'empty'
  | 'unknown'
  | 'ready'
type Wallet = {
  found: boolean
  enabled: boolean
  address?: string
  model_id?: string
  chain: string
  asset: string
  balance_usdc?: string
  balance_status: string
}
export function feeWalletState(wallet: Wallet): FeeWalletState {
  if (!wallet.found || !wallet.enabled) return 'missing'
  if (
    wallet.balance_status !== 'ok' ||
    !wallet.balance_usdc?.trim() ||
    !Number.isFinite(Number(wallet.balance_usdc)) ||
    Number(wallet.balance_usdc) < 0
  )
    return 'unknown'
  return Number(wallet.balance_usdc) > 0 ? 'ready' : 'empty'
}
export function FrontierSetup({
  models,
  modelID,
  accounts,
  accountID,
  venue,
  loaded,
  open,
  onOpen,
  onRefresh,
  onWalletState,
}: {
  models: AIModel[]
  modelID: string
  accounts: Exchange[]
  accountID: string
  venue: string
  loaded: boolean
  open: 'ai' | 'exchange' | null
  onOpen: (step: 'ai' | 'exchange' | null) => void
  onRefresh: (modelID?: string, venue?: string) => Promise<void>
  onWalletState: (state: FeeWalletState) => void
}) {
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [binance, setBinance] = useState(false)
  const [choice, setChoice] = useState(venue)
  const dialog = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  const request = useRef(0)
  const pending = useRef(false)
  const selectedModel = models.find((m) => m.id === modelID)
  const status = wallet ? feeWalletState(wallet) : 'checking'
  const aiReady =
    !!selectedModel &&
    (selectedModel.provider !== 'claw402' || status === 'ready')
  const exchangeReady = accounts.some(
    (a) =>
      a.id === accountID &&
      a.exchange_type === venue &&
      !a.testnet &&
      (a.exchange_type === 'binance'
        ? a.has_api_key && a.has_secret_key
        : a.hyperliquidWalletAddr &&
          a.hyperliquidBuilderApproved &&
          a.hyperliquidAgentAddress &&
          (a.has_hyperliquid_secret || a.has_api_key))
  )
  const refreshWallet = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    const revision = ++request.current
    try {
      const next = await planningAPI<Wallet>(
        'setup-wallet' +
          (selectedModel?.provider === 'claw402'
            ? '?model_id=' + encodeURIComponent(modelID)
            : '')
      )
      if (mounted.current && revision === request.current) {
        setWallet(next)
        onWalletState(feeWalletState(next))
        setError('')
      }
    } catch {
      if (mounted.current && revision === request.current) {
        onWalletState('unknown')
        setWallet(null)
        setError(
          'Could not check the AI wallet. Retry without creating another wallet.'
        )
      }
    } finally {
      if (revision === request.current) pending.current = false
    }
  }, [onWalletState, selectedModel?.provider, modelID])
  useEffect(() => {
    mounted.current = true
    setWallet(null)
    setCopied(false)
    onWalletState('checking')
    void refreshWallet()
    return () => {
      mounted.current = false
      request.current++
      pending.current = false
    }
  }, [refreshWallet, onWalletState])
  useEffect(() => {
    if (!open || !wallet?.found || status === 'ready') return
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshWallet()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [open, wallet?.found, status, refreshWallet])
  useEffect(() => {
    if (open === 'exchange') setChoice(venue)
  }, [open, venue])
  useEffect(() => {
    if (!open || binance) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpen(null)
      if (event.key !== 'Tab') return
      const items = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)'
        ) || []
      )
      const first = items[0],
        last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.body.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [open, binance, onOpen])
  async function createWallet() {
    if (working || pending.current) return
    setWorking(true)
    setError('')
    try {
      const next = await planningAPI<Wallet>('setup-wallet', {
        model_id:
          wallet?.model_id ||
          (selectedModel?.provider === 'claw402' ? modelID : ''),
      })
      if (!mounted.current) return
      setWallet(next)
      onWalletState(feeWalletState(next))
      await onRefresh(selectedModel?.id || next.model_id)
      await refreshWallet()
    } catch {
      if (mounted.current)
        setError(
          'AI setup could not be confirmed. Check the wallet status before retrying.'
        )
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  async function savedExchange() {
    await onRefresh(undefined, choice)
    setBinance(false)
    // Return to Frontier with the idea intact; no model call or order is started.
    onOpen(null)
  }
  return (
    <>
      {loaded && (!aiReady || !exchangeReady) && (
        <section className="frontier-setup-strip" aria-label="Frontier setup">
          <div>
            <b>Get ready in two steps</b>
            <span>
              Explore charts now. Connect what you need when you’re ready.
            </span>
          </div>
          <span className={aiReady ? 'setup-done' : ''}>
            {aiReady ? '✓' : '1'} AI {aiReady ? 'ready' : 'setup'}
          </span>
          <span className={exchangeReady ? 'setup-done' : ''}>
            {exchangeReady ? '✓' : '2'}{' '}
            {venue === 'binance' ? 'Binance' : 'Hyperliquid'}{' '}
            {exchangeReady ? 'connected' : 'account'}
          </span>
          <button
            className="planning-primary"
            onClick={() => onOpen(aiReady ? 'exchange' : 'ai')}
          >
            Continue setup
          </button>
        </section>
      )}
      {open && !binance && (
        <div className="frontier-setup-backdrop">
          <section
            ref={dialog}
            className="frontier-setup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="frontier-setup-title"
          >
            <header>
              <div>
                <small>FRONTIER SETUP</small>
                <h2 id="frontier-setup-title">
                  {open === 'ai'
                    ? 'Enable your AI'
                    : 'Connect your trading account'}
                </h2>
              </div>
              <button
                autoFocus
                aria-label="Close setup"
                onClick={() => onOpen(null)}
              >
                ×
              </button>
            </header>
            <nav aria-label="Setup steps">
              <button
                aria-current={open === 'ai' ? 'step' : undefined}
                onClick={() => onOpen('ai')}
              >
                1 · AI {aiReady ? '✓' : ''}
              </button>
              <button
                aria-current={open === 'exchange' ? 'step' : undefined}
                onClick={() => onOpen('exchange')}
              >
                2 · Exchange {exchangeReady ? '✓' : ''}
              </button>
            </nav>
            {error && (
              <p role="alert" className="frontier-setup-error">
                {error}
              </p>
            )}
            {open === 'ai' ? (
              <>
                {selectedModel?.provider !== 'claw402' && selectedModel ? (
                  <div className="frontier-setup-success">
                    <b>Your AI is connected</b>
                    <p>
                      {selectedModel.name} uses your existing provider
                      configuration. An AI fee wallet is optional for paid
                      market data.
                    </p>
                  </div>
                ) : (
                  <p>
                    One wallet pays for AI requests and paid market data. Your
                    trading funds stay in your exchange account.
                  </p>
                )}
                {wallet?.found ? (
                  <div className="frontier-wallet-card">
                    <QRCodeSVG value={wallet.address || ''} size={140} />
                    <div>
                      <b>USDC · Base network</b>
                      <p>
                        Deposit USDC on Base to this address. This funds AI
                        usage only.
                      </p>
                      <code>{wallet.address}</code>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              wallet.address || ''
                            )
                            setCopied(true)
                          } catch {
                            setError(
                              'Copy failed. Select and copy the address instead.'
                            )
                          }
                        }}
                      >
                        {copied ? 'Address copied' : 'Copy address'}
                      </button>
                      <p>
                        <strong>
                          {wallet.balance_status === 'ok'
                            ? `${wallet.balance_usdc} USDC`
                            : 'Balance not verified'}
                        </strong>{' '}
                        ·{' '}
                        {status === 'ready'
                          ? 'Funded'
                          : status === 'empty'
                            ? 'Waiting for deposit'
                            : 'Check balance'}
                      </p>
                      <button
                        disabled={working}
                        onClick={() => void refreshWallet()}
                      >
                        Check balance
                      </button>
                      {!wallet.enabled && (
                        <button
                          disabled={working}
                          onClick={() => void createWallet()}
                        >
                          Enable existing AI wallet
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="frontier-setup-start">
                    <b>AI, without entering an API key</b>
                    <p>
                      Create a NOFX AI fee wallet, then fund it with Base USDC.
                      Model calls are paid per request; setup itself sends no
                      payment.
                    </p>
                    <button
                      className="planning-primary"
                      disabled={working || !!error || status === 'checking'}
                      onClick={() => void createWallet()}
                    >
                      {working ? 'Setting up AI…' : 'Create AI wallet'}
                    </button>
                    {error && (
                      <button onClick={() => void refreshWallet()}>
                        Check wallet status
                      </button>
                    )}
                  </div>
                )}
                <p className="frontier-setup-note">
                  NOFX stores this wallet locally; back up your NOFX data before
                  funding. A positive balance is not a price guarantee. Each
                  paid request is checked by the gateway before use.
                </p>
                <Link
                  target="_blank"
                  rel="noopener noreferrer"
                  to="/settings?tab=models&returnTo=frontier"
                >
                  Use my own AI provider instead ↗
                </Link>
                <button
                  disabled={working}
                  onClick={async () => {
                    try {
                      await onRefresh()
                      await refreshWallet()
                    } catch {
                      setError(
                        'Could not refresh AI configuration. Please retry.'
                      )
                    }
                  }}
                >
                  Refresh AI configuration
                </button>
                <footer>
                  <button onClick={() => onOpen(null)}>
                    Explore charts first
                  </button>
                  <button
                    className="planning-primary"
                    disabled={!aiReady}
                    onClick={() => onOpen(exchangeReady ? null : 'exchange')}
                  >
                    {exchangeReady
                      ? 'Return to Frontier'
                      : 'Continue to exchange'}
                  </button>
                </footer>
              </>
            ) : (
              <>
                <p>
                  Choose one. Frontier uses your existing NOFX account and order
                  execution.
                </p>
                <div className="frontier-exchange-choices">
                  <button
                    aria-pressed={choice === 'hyperliquid'}
                    onClick={() => setChoice('hyperliquid')}
                  >
                    <b>Hyperliquid</b>
                    <span>Connect a wallet and approve trading access.</span>
                  </button>
                  <button
                    aria-pressed={choice === 'binance'}
                    onClick={() => setChoice('binance')}
                  >
                    <b>Binance Futures</b>
                    <span>
                      Connect a Futures API key. No withdrawals needed.
                    </span>
                  </button>
                </div>
                {choice === 'hyperliquid' ? (
                  <HyperliquidWalletConnect
                    language="en"
                    isLoggedIn
                    variant="inline"
                    onSaved={savedExchange}
                  />
                ) : (
                  <div className="frontier-setup-start">
                    <b>Use your Binance USDT Futures account</b>
                    <p>
                      Enable Futures trading permission and restrict your API
                      key to this server’s IP. Keep withdrawals disabled.
                    </p>
                    <button
                      className="planning-primary"
                      onClick={() => setBinance(true)}
                    >
                      Connect Binance
                    </button>
                  </div>
                )}
                <p className="frontier-setup-note">
                  Connecting an account does not place a trade or start
                  Autopilot. Exchange permissions and available margin are
                  verified when you review an order.
                </p>
                <footer>
                  <button onClick={() => onOpen(null)}>
                    Plan without an exchange
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await onRefresh()
                        onOpen(null)
                      } catch {
                        setError('Could not refresh accounts. Please retry.')
                      }
                    }}
                  >
                    I’ve connected my account
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
      {binance && (
        <ExchangeConfigModal
          allExchanges={accounts}
          editingExchangeId={null}
          initialExchangeType="binance"
          allowedExchangeTypes={['binance']}
          language="en"
          onClose={() => setBinance(false)}
          onDelete={() => {}}
          onSave={async (_id, type, name, key, secret, _pass, testnet) => {
            if (type !== 'binance' || testnet)
              throw new Error(
                'Frontier requires a Binance mainnet Futures account'
              )
            await api.createExchangeEncrypted({
              exchange_type: 'binance',
              account_name: name,
              enabled: true,
              api_key: key,
              secret_key: secret || '',
              testnet: false,
            })
            await savedExchange()
          }}
        />
      )}
    </>
  )
}
