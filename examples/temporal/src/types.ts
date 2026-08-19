export interface RefundInput {
  orderId: string
  amount: number
}

export interface NotifyHitlyInput extends RefundInput {
  workflowId: string
}

export interface HitlyDecision {
  decision: 'accept' | 'reject' | 'edit'
  args?: {
    orderId?: string
    amount?: number
  }
}
