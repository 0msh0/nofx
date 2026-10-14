# NOFX one-time trade planning

This feature integrates Vergex SI's deterministic mathematics and bounded LLM
harness into NOFX. It is a user-initiated planning workspace, not a continuously
running strategy and not a historical backtesting requirement.

## Open the workspace

1. Initialize the pinned TradingView source before building:
   `git submodule update --init web/vendor/charting`.
2. Build/run NOFX using its existing instructions. `npm run build` and `npm run dev`
   copy vendor assets into generated `web/public/charting_library/`.
3. Log in and open **交易规划** (`/planning`) in the navigation.
4. Select an existing enabled Binance USDT perpetual account or Hyperliquid
   mainnet account. Hyperliquid uses NOFX's existing owner wallet, agent and
   builder authorization. Select an existing enabled NOFX AI configuration.
5. Open a native symbol (`BTCUSDT`, `BTC`, or `xyz:GOOGL` on its matching venue),
   choose a chart timeframe, then describe the trade to compare. Selecting one
   candidate clears the other candidates' chart overlays. Comparison displays
   up to three labeled hypotheses. Drawing positions in time are layout aids,
   not historical signals or future execution timestamps.
6. Review the prices, quantities, schedule, cost assumptions and account. Only
   typing **APPROVE LIVE** and confirming locks and starts that plan. No paper
   execution option exists in this feature.

No new model keys or wallet keys are needed. Model requests use NOFX's registered
provider clients, including their existing billing mechanism. Generating plans
can incur model/provider charges. Private keys never enter prompts or browser
responses. Sessions and discussion preferences are saved per logged-in user.
Preferences cannot lower the submitted hard risk limits.

## Supported execution and actual limits

- Real Binance perpetual limits and conditional exits; real Hyperliquid core
  perpetuals and `xyz` HIP-3 perpetuals. OKX public market data is implemented,
  but this workspace does not offer OKX live execution yet. There is no adapter
  fallback to another exchange or order type.
- **1x leverage**, finite GTC limit orders only. `limit` is one entry; `ladder`
  accepts 2–8 weighted prices; `twap` accepts 2–24 fixed-price slices at 5–300
  second intervals, with total release time at most one hour. It does not chase
  prices or execute arbitrary generated code. Late TWAP slices expire rather
  than being released in a catch-up burst.
- All children share the approved stop/target; each child and the aggregate must
  pass exact-decimal fee/slippage, net reward/risk, tick/step, minimum quantity,
  minimum notional, budget and book-liquidity checks. Partial fills may leave
  quantities too small for an exchange protection order; failures require
  immediate manual intervention. Stops do not guarantee a maximum realized loss.
- Actual equity, available balance, fees (including Hyperliquid builder fees),
  fresh book and account identity are rechecked at execution. Existing positions
  or pending orders on the symbol are blocked. Automatic NOFX traders cannot
  start on a leased planning account, including manager/restoration launch paths.
  Binance identity currently uses its API key; two different API keys for the
  same Binance account require operator coordination.
- Entry fills are observed about every two seconds; corresponding reduce-only
  SL and TP orders are submitted for newly observed filled quantity. This is
  **not an atomic exchange bracket**: there is a fill-to-protection interval and
  a protection submission can fail. An acknowledgement is never a substitute
  for confirming the native exchange order. External position changes pause new
  entries. Inspect the real exchange immediately when the workspace says
  **需要核对**.
- A plan expires after five minutes before execution. Once started, order
  monitoring continues to manage the already approved basket. Unfilled limit
  entries expire after a 15-minute window; TWAP's window ends two minutes after
  its last release. Stopping cancels unsent/pending entries; **it does not close
  filled positions or remove their active protection**.

## Approval, durability and recovery

The immutable approval digest binds the full plan, logged-in owner, configured
account and execution policy. AI tools cannot approve, submit, cancel, transfer,
or change credentials. Database ownership applies to drafts, runs and sessions.
Only one unresolved approved plan leases an account at a time.

Each child has a deterministic client order ID. Intent is persisted **before**
submission. Missing/time-out acknowledgements become `UNKNOWN`; they are queried
by client ID and never blindly resubmitted. Native receipts must match the
locked intent and monotonic filled quantity. Remaining protective orders must be
confirmed or canceled before releasing the lease; an unknown order retains it.

After restart, active runs become `needs_attention`; they do not resume new
entries or replay orders. Open **执行记录 → 核对交易所状态** to resume reconciliation
and protection monitoring. Existing exchange-side stop/target orders continue
independently of the process. An outage/restart can delay protection of new
fills: verify positions and orders directly at the exchange before proceeding.
There is no automatic account unlocking for an unresolved order.

## Harness, chart and plugins

The bounded tool loop reads the selected native market, visible chart range and
comparison timeframes; it may propose, revise, draw, or run read-only data tools.
Data provenance is captured with the draft. History and preferences are scoped
by NOFX user; transient provider reasoning is not saved in chat JSON.

Public funding/open-interest sources and Hyperdata cost/profit/win-rate sources
are available to the harness through the data-plugin registry. Hyperdata is only
used for its matching Hyperliquid market; it is never substituted for Binance
or OKX data. Open **数据插件** to enable or disable individual sources for the same user
registry used by the AI, and explicitly read the selected market. Funding/OI
metrics, cost/liquidation distributions, labeled long/short win-rate heatmaps and
7/30-day profit tables are rendered from bounded typed data. Missing/incomplete
data is shown explicitly. There is no background paid-data polling. Switching
markets discards pending/stale visual responses.

On-site entry calculators use a bounded Starlark runtime, test cases, immutable
source hashes and session-scoped enabling. They can output proposed finite
allocations; they have no networking, shell, keys or order APIs. The normal
mathematical compiler and independent human approval remain mandatory.

TradingView runtime source is the user-requested
`tinkle-community/charting_library` repository, pinned as a Git submodule.
Generated runtime assets are ignored. Distribution of those assets is subject
to the applicable TradingView/library license; the upstream library is not modified.

## Verification boundary

Automated tests use local HTTP exchange fixtures and temporary databases, never
funded wallets or production order submission. Passing tests/builds does not
prove that an account has trading permission or that an actual live order has
succeeded. This integration must not claim such success without an authorized,
observed real transaction. Routine validation must not place real orders.

## Local integration with dev

The feature has been merged locally with upstream dev `294d0641`, including its
payment authorization, gasless approval, receipt verification and model updates.
Unknown paid-call outcomes retain their safe upstream classification and are
shown as requiring payment reconciliation, never as an instruction to resend.
No remote push, PR, deployment or real transaction is part of local validation.

## Builder and Broker routing

The AI and connected-account configuration are NOFX's existing per-user records.
Approved plans now call NOFX's exchange traders through the shared
`trader/execution.Trader` contract. The planning bridge only forwards calls;
it contains no exchange SDK or signing/submission code. The original NOFX
`PlaceLimitOrder` entry points also call the same `SubmitOrder` implementation.
Binance uses the common credential/client factory (including NOFX hooks) without
changing position mode when opening the workspace. Hyperliquid uses the existing
trader, wallet authorization and Builder submission helper.

Single limits, weighted ladders and TWAP remain planning/scheduling choices:
only the approved basket is released into the shared order API. Approval,
durable intent, partial-fill protection, cancellation, account exclusion and
restart reconciliation remain in the finite controller. Existing planning run
JSON and historical client IDs remain readable; this refactor does not merge
planning runs into the automatic strategy decision history.

The existing limit API now retains stable client identity, honors maker-only
and reduce-only flags, fails closed on leverage errors, and returns actual
Hyperliquid order IDs instead of synthetic timestamps. Existing grid labels
are deterministically mapped to 128-bit client IDs; exact plan IDs pass through.
Hyperliquid status queries use native order status and share state decoding
with planning: missing orders are errors, not presumed fills. The status
endpoint does not supply weighted average fill price or commission; those
fields remain zero until filled-trade data supplies them.

Hyperliquid planning entry and protective orders carry the existing NOFX
`defaultBuilder` address and fee (50 tenths of a basis point = 0.05%). Binance
entry and protective orders use the same `x-KzrpZaP9` prefix as NOFX automatic
orders. The prefix is shared as a constant, and a lossless base64url encoding of
the durable 128-bit ID keeps the complete client ID within 32 characters. Native
routing IDs are persisted before sending, and reused for querying/canceling;
historical untagged orders keep their original lookup ID.

These fields establish requested routing, not verified earnings. Builder fees
belong to the configured builder, and Binance rebate eligibility belongs to the
registered Link/Broker account. Neither account ownership nor successful rebate
settlement has been verified here. No real order or fee receipt was produced by
the tests.
