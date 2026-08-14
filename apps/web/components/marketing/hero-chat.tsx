const messages = [
  { side: 'left', text: 'Pause the agent.' },
  { side: 'right', text: 'HITLy is an approval inbox' },
  { side: 'right', text: 'for Mastra, n8n, LangGraph, and Temporal.' },
  { side: 'right', text: 'Frameworks pause' },
  { side: 'left', text: 'Review the action.' },
  { side: 'right', text: 'your team decides or delegates' },
  { side: 'left', text: 'Resume the run.' },
  { side: 'right', text: 'HITLy resumes the original workflow.' },
] as const

export function HeroChat() {
  return (
    <div className="flex max-w-lg flex-col gap-2.5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/50">
      {messages.map((message, index) => {
        const isRight = message.side === 'right'
        return (
          <p
            key={`${index}-${message.text}`}
            className={
              isRight
                ? 'max-w-[85%] self-end rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm leading-6 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'max-w-[85%] self-start rounded-2xl rounded-bl-md bg-white px-4 py-2.5 text-base font-semibold leading-6 text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-50 dark:ring-zinc-700'
            }
          >
            {message.text}
          </p>
        )
      })}
    </div>
  )
}
