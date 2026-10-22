import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { LISTED_PLUGIN_IDS, PLUGIN_IDS, isListedPluginId, isPluginId } from '@hitly/core'
import { PluginBadge } from '@hitly/ui'

/**
 * The project-create plugin picker offers only listed plugins, while projects
 * that already use an unlisted plugin (OpenShell) stay valid and still render.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { CreateProjectModal } from './create-project-modal'
import { PluginSelect } from './plugin-select'
import { ProjectList } from './project-list'
import { getPlugin } from '@/lib/plugins'

// Components from @hitly/ui are compiled outside this app's tsconfig when run
// under tsx, with the classic JSX runtime, so they expect a global React.
Object.assign(globalThis, { React })

afterEach(() => cleanup())

describe('plugin picker', () => {
  it('does not offer OpenShell', () => {
    render(<PluginSelect />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    assert.equal(values.includes('openshell'), false)
    assert.deepEqual(values, [...LISTED_PLUGIN_IDS])
    assert.equal(
      Array.from(select.options).some((option) => /openshell/i.test(option.textContent ?? '')),
      false,
    )
    assert.equal(select.value, 'mastra')
  })

  it('lists every other plugin', () => {
    assert.deepEqual(
      PLUGIN_IDS.filter((id) => id !== 'openshell'),
      [...LISTED_PLUGIN_IDS],
    )
  })

  it('refuses OpenShell as a new choice but keeps it a valid plugin id', () => {
    assert.equal(isListedPluginId('openshell'), false)
    assert.equal(isPluginId('openshell'), true)
    for (const id of LISTED_PLUGIN_IDS) assert.equal(isListedPluginId(id), true, id)
    assert.equal(isListedPluginId('nope'), false)
  })
})

describe('create project dialog', () => {
  it('uses the plugin picker, so OpenShell is not offered', () => {
    const { container } = render(<CreateProjectModal />)
    const form = container.querySelector('form')
    assert.ok(form, 'the dialog has a form')
    const selects = form.querySelectorAll('select')
    assert.equal(selects.length, 1, 'the form has one plugin field')
    const select = selects[0]
    assert.equal(select.name, 'plugin')
    const values = Array.from(select.options).map((option) => option.value)
    assert.deepEqual(values, [...LISTED_PLUGIN_IDS])
    assert.equal(
      Array.from(select.options).some((option) => /openshell/i.test(`${option.value} ${option.textContent ?? ''}`)),
      false,
    )
    assert.equal(select.value, 'mastra')
  })

  it('renders the same field as PluginSelect', () => {
    const dialog = render(<CreateProjectModal />).container.querySelector('form select')
    const picker = render(<PluginSelect />).container.querySelector('select')
    assert.ok(dialog && picker)
    assert.equal(dialog.closest('label')?.outerHTML, picker.closest('label')?.outerHTML)
  })
})

describe('existing OpenShell project', () => {
  it('still loads its plugin', () => {
    assert.equal(getPlugin('openshell').id, 'openshell')
  })

  it('still renders in the project list', () => {
    render(
      <ProjectList
        canCreate={false}
        projects={[{ id: 'prj_existing', name: 'Sandbox drafts', description: null, plugin: 'openshell' }]}
      />,
    )
    const link = screen.getByRole('link', { name: /Sandbox drafts/ })
    assert.equal(link.getAttribute('href'), '/projects/prj_existing')
    assert.ok(link.textContent?.includes('OpenShell'))
  })

  it('still renders its plugin badge', () => {
    render(<PluginBadge plugin="openshell" />)
    assert.ok(screen.getByText('OpenShell'))
  })
})
