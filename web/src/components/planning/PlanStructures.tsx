import type { Plan } from '../../lib/planning'
import { structureNames } from './PlanningActivity'
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
  if (!checks.length && !busy) return null
  return (
    <section
      className="planning-structures"
      aria-label="Entry structure comparison"
    >
      {['limit', 'ladder', 'twap'].map((kind) => {
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
                <button onClick={() => onSelect(plan)}>
                  {plan.id === selected ? 'Showing on chart' : 'View on chart'}
                </button>
              </>
            ) : (
              <p>
                {check?.reason ||
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
