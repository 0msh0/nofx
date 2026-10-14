import { expect, it } from 'vitest'
import { validationSummary } from './planningPresentation'

it('explains rounded ratio failures without implying an equal ratio failed', () => {
  expect(validationSummary('net reward/risk 1.999999 is below minimum 2')).toBe(
    'Net R:R is just below 2.00 : 1 after costs.'
  )
  expect(validationSummary('net reward/risk 1.246912 is below minimum 2')).toBe(
    'Net R:R 1.25 : 1 is below the required 2.00 : 1 after costs.'
  )
  expect(validationSummary('invalid stop/target ordering')).toBe('invalid stop/target ordering')
})
