import type { Plan } from '../../lib/planning'
import { validationSummary } from '../../lib/planningPresentation'
import { structureNames } from './PlanningActivity'
import { PlanFunding } from './PlanFunding'
export interface PlanCheck {
  id: string
  kind: string
  name: string
  status: string
  reason?: string
  plan_id?: string
}
export function PlanStructures({
  checks,
  plans,
  busy,
  selected,
  onSelect,
}: {
  checks: PlanCheck[]
  plans: Plan[]
  busy: boolean
  selected: string
  onSelect: (plan: Plan) => void
}) {
  const price = (value: string) =>
    Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 })
  const money = (value: string) =>
    Number(value).toLocaleString('en-US', {
      maximumFractionDigits: Math.abs(Number(value)) < 0.01 ? 4 : 2,
    })
  if (!checks.length && !busy) return null
  return (
    <section
      className="planning-structures"
      aria-label="Entry structure comparison"
    >
      {['market', 'limit', 'ladder', 'twap'].map((kind) => {
        const plan = plans.find((p) => p.idea.execution.kind === kind)
        const check = checks.filter((row) => row.kind === kind).slice(-1)[0]
        return (
          <article
            key={kind}
            className={plan?.id === selected ? 'selected' : ''}
          >
            <header>
              <strong>{structureNames[kind]}</strong>
              <span
                className={
                  plan
                    ? 'target-text'
                    : check?.status === 'rejected'
                      ? 'stop-text'
                      : ''
                }
              >
                {plan
                  ? 'Validated draft'
                  : check?.status === 'rejected'
                    ? 'Not feasible'
                    : busy
                      ? 'Evaluating'
                      : 'Not proposed'}
              </span>
            </header>
            {plan ? (
              <>
                <b>{plan.idea.name}</b>
                <p>
                  {plan.orders.length}{' '}
                  {kind === 'twap'
                    ? 'timed slices'
                    : kind === 'ladder'
                      ? 'price levels'
                      : 'entry'}{' '}
                  · Net R:R {Number(plan.reward_risk).toFixed(2)} : 1
                </p>
                <dl className="frontier-plan-levels">
                  <div>
                    <dt>{kind === 'market' ? 'Est. entry' : 'Entry'}</dt>
                    <dd>{price(plan.idea.entry)}</dd>
                  </div>
                  <div>
                    <dt>Stop</dt>
                    <dd className="stop-text">{price(plan.idea.stop)}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd className="target-text">{price(plan.idea.target)}</dd>
                  </div>
                </dl>
                {kind === 'market' && (
                  <p>
                    Enter immediately after approval. Actual fill may differ.
                  </p>
                )}
                <PlanFunding plan={plan} compact />
                <div className="frontier-plan-outcomes">
                  <span>
                    Planned loss{' '}
                    <b className="stop-text">−{money(plan.risk)}</b>
                  </span>
                  <span>
                    Target return{' '}
                    <b className="target-text">+{money(plan.reward)}</b>
                  </span>
                  <small>{plan.snapshot.quote_asset} · costs included</small>
                </div>
                <button onClick={() => onSelect(plan)}>
                  {plan.id === selected ? 'Showing on chart' : 'View on chart'}
                </button>
              </>
            ) : (
              <p>
                {(check?.reason ? validationSummary(check.reason) : '') ||
                  (busy
                    ? 'Reading market context and checking this structure.'
                    : 'No candidate of this type was proposed.')}
              </p>
            )}
          </article>
        )
      })}
    </section>
  )
}
