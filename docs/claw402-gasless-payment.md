# Claw402 model payments without Base ETH

The configured **fee wallet** pays in Base USDC using native x402 `upto`.
This wallet is separate from the Hyperliquid trading/agent wallet. No ETH top-up
or user-funded approval transaction is needed when the gateway advertises the
standard `eip2612GasSponsoring` extension.

The client validates the quote, chain, USDC asset, recipient, facilitator,
per-call cap and deadline. If Permit2 allowance is insufficient, it reads the
USDC permit nonce and checks the on-chain domain, then signs a bounded USDC
permit and the separate Permit2 witness. The facilitator submits the permit
with settlement. Existing sufficient allowance skips the extra signature.
No unlimited allowance, exact-price downgrade, or automatic paid retry is used.

Model calls sharing a fee wallet are serialized across client instances in one
process through response/receipt verification. Use separate fee wallets for
separate NOFX processes. Sharing with another process/browser can race USDC's
sequential permit nonce; an ambiguous paid failure must be reconciled, not
blindly re-signed. The client never assumes a successful signature is a payment.

Claw402 quotes and final charges may include the gateway's disclosed settlement
service fee as well as token usage. The total remains within the signed cap;
NOFX records verified actual settlement instead of reconstructing the bill from
an outdated token-price estimate. Keep enough USDC for the quoted ceiling.

Offline tests use generated/unfunded keys and local mock RPCs, including the
same EIP-712 golden vector as the web client. A real zero-ETH, funded-USDC wallet
canary still requires its owner's authorization; compare payer and recipient
balance changes with the verified receipt. Passing unit tests does not prove a
live facilitator transaction or eliminate upstream/settlement failure costs.

References:
- https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md
- https://github.com/x402-foundation/x402/blob/main/specs/extensions/eip2612_gas_sponsoring.md
