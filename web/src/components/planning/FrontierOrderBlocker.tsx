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
            : `${label}: check the previous trade before placing another.`}
        </strong>
        <p>
          {approved
            ? 'View that plan or cancel its unused approval to place a different order.'
            : 'New orders are paused until this trade is resolved. You can still generate and compare plans.'}
        </p>
        <small>
          {run.plan.idea.name} · {label} · Record {run.id.slice(0, 8)}
        </small>
        {checkable && (
          <p className="frontier-check-hint">
            Check status reads the exchange. If the position and all orders are
            closed, it unlocks this account. It does not place or cancel orders.
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
