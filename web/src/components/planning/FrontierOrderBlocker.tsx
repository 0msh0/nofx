import type { LiveRun } from '../../lib/planning'

export function FrontierOrderBlocker({
  run,
  busy,
  onCheck,
  onView,
  onRevoke,
}: {
  run: LiveRun
  busy: boolean
  onCheck: () => void
  onView: () => void
  onRevoke: () => void
}) {
  const approved = run.state === 'approved'
  const checkable = ['needs_attention', 'position_open', 'stopping'].includes(
    run.state
  )
  const label = `${run.plan.snapshot.symbol} ${run.plan.idea.side === 'long' ? 'Long' : 'Short'}`
  return (
    <section
      className="frontier-order-blocker"
      aria-label="Previous trade blocking new orders"
    >
      <div>
        <strong>
          {approved
            ? 'An earlier plan is approved but has not been sent.'
            : `${label}: previous trade status needs checking.`}
        </strong>
        <p>
          {approved
            ? 'View that plan or cancel its unused approval to place a different order.'
            : 'Review a new plan to check this trade automatically. If it is closed, you can continue in the same step.'}
        </p>
        <small>
          {run.plan.idea.name} · {label} · Record {run.id.slice(0, 8)}
        </small>
        {checkable && (
          <p className="frontier-check-hint">
            Status checks do not place or cancel orders. Active positions and
            unconfirmed orders keep this account reserved.
          </p>
        )}
      </div>
      <div className="frontier-blocker-actions">
        {checkable && (
          <button disabled={busy} onClick={onCheck}>
            Check previous trade
          </button>
        )}
        <button disabled={busy} onClick={onView}>
          View previous trade
        </button>
        {approved && (
          <button disabled={busy} onClick={onRevoke}>
            Cancel unused approval
          </button>
        )}
        <a href="#frontier-account">Positions & orders ↓</a>
      </div>
    </section>
  )
}
