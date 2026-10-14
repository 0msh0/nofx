export function validationSummary(reason: string): string {
  const ratio = reason.match(
    /net reward\/risk ([\d.]+) is below minimum ([\d.]+)/i
  )
  if (ratio) {
    const value = Number(ratio[1]),
      minimum = Number(ratio[2])
    if (Number.isFinite(value) && Number.isFinite(minimum)) {
      return value.toFixed(2) === minimum.toFixed(2)
        ? `Net R:R is just below ${minimum.toFixed(2)} : 1 after costs.`
        : `Net R:R ${value.toFixed(2)} : 1 is below the required ${minimum.toFixed(2)} : 1 after costs.`
    }
  }
  return reason
}
