import { docs, integrations } from '@/.source/server'
import { loader } from 'fumadocs-core/source'
import type * as PageTree from 'fumadocs-core/page-tree'

/** Treat the section index as a named folder so sibling pages indent underneath it. */
function nestIndexFolder(baseUrl: string, name: string) {
  const indexUrl = baseUrl.replace(/\/$/, '') || '/'
  return {
    root(root: PageTree.Root): PageTree.Root {
      const index = root.children.find(
        (node): node is PageTree.Item =>
          node.type === 'page' && node.url.replace(/\/$/, '') === indexUrl,
      )
      if (!index) return root
      const children = root.children.filter((node) => node !== index)
      if (children.length === 0) return root
      return {
        ...root,
        children: [
          {
            type: 'folder',
            name,
            index,
            defaultOpen: true,
            collapsible: true,
            children,
          },
        ],
      }
    },
  }
}

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [nestIndexFolder('/docs', 'Docs')],
  },
})

export const integrationsSource = loader({
  baseUrl: '/integrations',
  source: integrations.toFumadocsSource(),
  pageTree: {
    transformers: [nestIndexFolder('/integrations', 'Integrations')],
  },
})

/** One sidebar: Docs and Integrations as nested folders, used by both layouts. */
export function getNavTree(): PageTree.Root {
  return {
    name: 'HITLy',
    children: [...source.getPageTree().children, ...integrationsSource.getPageTree().children],
  }
}
