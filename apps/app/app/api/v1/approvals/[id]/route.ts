import { createApprovalDetailGet } from '@/lib/approval-detail-route'
import { getApprovalDetail } from '@/lib/approval-detail'
import { getApprovalForOrigin } from '@/lib/approvals'
import { requireApiWorkspace } from '@/lib/api-session'

export const GET = createApprovalDetailGet({
  requireApiWorkspace,
  getApprovalDetail,
  getApprovalForOrigin,
})
