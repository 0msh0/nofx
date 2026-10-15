import type { Plan } from '../../lib/planning'

const money = (value: number) =>
  value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

export function planNotional(plan: Plan) {
  return plan.orders?.length
    ? plan.orders.reduce(
        (sum, order) => sum + Number(order.price) * Number(order.quantity),
        0
      )
    : Number(plan.idea.entry) * Number(plan.quantity)
}

export function PlanFunding({
  plan,
  compact = false,
}: {
  plan: Plan
  compact?: boolean
}) {
  const notional = planNotional(plan)
  const leverage = plan.constraints.leverage || 1
  const margin = notional / leverage
  const quote = plan.snapshot.quote_asset
  const available = Number(plan.constraints.available_margin)
  if (compact)
    return (
      <p className="frontier-funding-compact">
        <b>{leverage}x</b> · Position {money(notional)} {quote}
        <small>
          Est. margin {money(margin)} {quote}
        </small>
      </p>
    )
  return (
    <section className="frontier-funding" aria-label="Plan funding">
      <div className="frontier-funding-equation">
        <div>
          <span>Est. margin</span>
          <strong>
            {money(margin)} <small>{quote}</small>
          </strong>
        </div>
        <span aria-hidden="true">×</span>
        <div>
          <span>Leverage</span>
          <strong>{leverage}x</strong>
        </div>
        <span aria-hidden="true">=</span>
        <div>
          <span>Position value</span>
          <strong>
            {money(notional)} <small>{quote}</small>
          </strong>
        </div>
      </div>
      {Number.isFinite(available) && available > 0 ? (
        <p>
          Available margin at sizing: {money(available)} {quote} · This plan
          uses {money((margin / available) * 100)}% before costs. Fees and
          slippage are reserved separately.
        </p>
      ) : (
        <p>
          Saved plan size. Review again to size a new order from current
          available margin.
        </p>
      )}
      {plan.sizing_limit === 'liquidity' && (
        <p className="stop-text">
          Size reduced by order-book liquidity: participation is capped at 10%
          of the visible top level.
        </p>
      )}
      {plan.sizing_limit === 'risk' && (
        <p>Size reduced by this plan’s maximum loss budget.</p>
      )}
    </section>
  )
}
