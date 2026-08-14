import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import type { AnchorHTMLAttributes, ComponentType } from 'react'
import { Mermaid } from '@/components/mermaid'
import { PhoneGallery, PhoneShot } from '@/components/phone-shot'
import { externalLinkProps } from '@/lib/links'

export function getMDXComponents(components?: MDXComponents) {
  const merged = {
    ...defaultMdxComponents,
    ...components,
    Mermaid,
    PhoneGallery,
    PhoneShot,
  }
  const Anchor = merged.a as ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>>

  return {
    ...merged,
    a: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <Anchor {...props} {...externalLinkProps(typeof props.href === 'string' ? props.href : undefined)} />
    ),
  } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
