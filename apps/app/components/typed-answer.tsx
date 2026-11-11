import {
  formatTypedAnswer,
  isEmptyPayload,
  typedAnswerFromPayload,
  workItemTitle,
  type AnswerSchema,
  type FormattedAnswer,
} from '@hitly/core'
import { redactedRequestJson } from '@/lib/redact-request-payload'

export { formatTypedAnswer, isEmptyPayload, typedAnswerFromPayload, workItemTitle }

export function WorkItemHeadline({
  prompt,
  actionName,
}: {
  prompt?: string | null
  actionName: string
}) {
  return <h1 className="text-2xl font-semibold">{workItemTitle(prompt, actionName)}</h1>
}

export function ArgsPayload({ value }: { value: unknown }) {
  if (isEmptyPayload(value)) return null
  return (
    <div data-testid="args-payload">
      <h2 className="mt-4 max-w-2xl text-sm font-semibold">Action arguments</h2>
      <p className="mt-1 max-w-2xl text-xs text-zinc-500">Original request args from the stored create-once record.</p>
      <pre className="mt-2 max-w-2xl overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {redactedRequestJson(value)}
      </pre>
    </div>
  )
}

export function TypedAnswerView({
  answer,
  answerSchema,
}: {
  answer: unknown
  answerSchema?: AnswerSchema | null
}) {
  const formatted = formatTypedAnswer(answer, answerSchema)
  if (!formatted) return null
  return (
    <div className="mt-2" data-testid="typed-answer">
      <FormattedAnswerBody formatted={formatted} />
    </div>
  )
}

function FormattedAnswerBody({ formatted }: { formatted: FormattedAnswer }) {
  if (formatted.kind === 'list') {
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-800 dark:text-zinc-200">
        {formatted.items.map((item, index) => (
          <li key={`${index}:${item}`}>{item}</li>
        ))}
      </ul>
    )
  }
  if (formatted.kind === 'json') {
    return (
      <pre className="overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {formatted.text}
      </pre>
    )
  }
  return <p className="text-sm text-zinc-800 dark:text-zinc-200">{formatted.text}</p>
}
