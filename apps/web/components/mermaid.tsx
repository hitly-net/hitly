'use client'

import { useEffect, useId, useState } from 'react'

export function Mermaid({ chart }: { chart: string }) {
  const rawId = useId()
  const id = `mermaid-${rawId.replace(/:/g, '')}`
  const [svg, setSvg] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const mermaid = (await import('mermaid')).default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'neutral',
      })
      const { svg: rendered } = await mermaid.render(id, chart.replaceAll('\\n', '\n'))
      if (!cancelled) setSvg(rendered)
    })()
    return () => {
      cancelled = true
    }
  }, [chart, id])

  if (!svg) {
    return <pre className="my-6 overflow-x-auto text-sm text-fd-muted-foreground">{chart}</pre>
  }

  return (
    <div className="my-6 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
  )
}
