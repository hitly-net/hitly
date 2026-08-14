const steps = [
  {
    title: 'Pause',
    body: 'Your workflow hits a Hitly step. Mastra suspends, Hermes prompts or blocks a kanban card, HTTP waits on a resume URL, LangGraph interrupts, Temporal signals.',
  },
  {
    title: 'Review',
    body: 'The action lands in the Hitly inbox with context, editable args, and the decisions you allow.',
  },
  {
    title: 'Resume',
    body: 'Accept, edit, or reject. Hitly maps the decision back to resume(), a webhook, Command, or a Temporal signal.',
  },
]

export function HowItWorks() {
  return (
    <section className="border-y border-zinc-200 bg-zinc-50 py-20 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 md:grid-cols-3">
        {steps.map((step, index) => (
          <div key={step.title}>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">0{index + 1}</p>
            <h2 className="mt-2 text-xl font-semibold">{step.title}</h2>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
