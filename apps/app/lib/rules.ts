import type { ApprovalEnvelope, ChannelType, OriginRef, RuleActions, RuleMatch } from '@hitly/core'

function matchGlob(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current !== null && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key]
    }
    return undefined
  }, source)
}

export function ruleMatches(
  match: RuleMatch,
  envelope: ApprovalEnvelope,
  origin: OriginRef,
): boolean {
  if (match.plugin && match.plugin !== origin.plugin) return false
  if (match.actionName && !matchGlob(match.actionName, envelope.action.name)) return false
  const workflowId = String(origin.resumeHandle.workflowId ?? '')
  if (match.workflowId && !matchGlob(match.workflowId, workflowId)) return false
  if (match.args) {
    for (const [path, expected] of Object.entries(match.args)) {
      const actual = getPath(envelope.action.args, path)
      if (typeof actual !== 'string' && typeof actual !== 'number' && typeof actual !== 'boolean') {
        return false
      }
      if (!matchGlob(expected, String(actual))) return false
    }
  }
  return true
}

export function parseRuleMatch(value: Record<string, unknown>): RuleMatch {
  return {
    actionName: typeof value.actionName === 'string' ? value.actionName : undefined,
    workflowId: typeof value.workflowId === 'string' ? value.workflowId : undefined,
    plugin: typeof value.plugin === 'string' ? (value.plugin as RuleMatch['plugin']) : undefined,
    args:
      value.args && typeof value.args === 'object' && !Array.isArray(value.args)
        ? Object.fromEntries(
            Object.entries(value.args as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : undefined,
  }
}

export function parseRuleActions(value: Record<string, unknown>): RuleActions {
  const channelTypes = Array.isArray(value.channelTypes)
    ? value.channelTypes.filter((item): item is ChannelType => item === 'email' || item === 'slack' || item === 'telegram')
    : undefined
  return {
    slaMinutes: typeof value.slaMinutes === 'number' ? value.slaMinutes : undefined,
    channelTypes,
    assigneeUserId: typeof value.assigneeUserId === 'string' ? value.assigneeUserId : undefined,
  }
}
