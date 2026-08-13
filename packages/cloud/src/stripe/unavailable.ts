import { NextResponse } from 'next/server'

export function billingUnavailable() {
  return NextResponse.json(
    { error: 'Billing is not available in the open-source edition' },
    { status: 404 },
  )
}
