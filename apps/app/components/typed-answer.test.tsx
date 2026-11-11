import 'global-jsdom/register'
import fs from 'node:fs'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import type { AnswerSchema } from '@hitly/core'
import { ArgsPayload, TypedAnswerView, WorkItemHeadline } from './typed-answer'

afterEach(() => cleanup())

describe('WorkItemHeadline', () => {
  it('titles the page with the question, not the tool name', () => {
    render(<WorkItemHeadline prompt="Which auth methods?" actionName="ask_user" />)
    assert.equal(screen.getByRole('heading', { level: 1 }).textContent, 'Which auth methods?')
    assert.equal(screen.queryByText('ask_user'), null)
  })

  it('falls back to the action name when there is no question', () => {
    render(<WorkItemHeadline prompt="" actionName="ask_user" />)
    assert.equal(screen.getByRole('heading', { level: 1 }).textContent, 'ask_user')
  })

  it('renders a very long question without crashing (list CSS truncates)', () => {
    const long = `${'Which auth method should we enable for this workspace? '.repeat(40)}end`
    const { container } = render(<WorkItemHeadline prompt={long} actionName="ask_user" />)
    const heading = screen.getByRole('heading', { level: 1 })
    assert.equal(heading.textContent, long)
    assert.equal(container.querySelector('h1 script'), null)
    const listSrc = fs.readFileSync(fileURLToPath(new URL('./work-item-list.tsx', import.meta.url)), 'utf8')
    assert.match(listSrc, /className="truncate font-medium"/, 'inbox list already truncates long titles')
  })
})

describe('ArgsPayload', () => {
  it('hides the payload box when the value is empty', () => {
    const { rerender } = render(<ArgsPayload value={{}} />)
    assert.equal(screen.queryByTestId('args-payload'), null)
    rerender(<ArgsPayload value={null} />)
    assert.equal(screen.queryByTestId('args-payload'), null)
    rerender(<ArgsPayload value={[]} />)
    assert.equal(screen.queryByTestId('args-payload'), null)
  })

  it('renders non-empty args', () => {
    render(<ArgsPayload value={{ amount: 7 }} />)
    const box = screen.getByTestId('args-payload')
    assert.ok(box.textContent?.includes('Action arguments'))
    assert.ok(box.textContent?.includes('7'))
  })
})

describe('TypedAnswerView', () => {
  it('renders a multi-choice answer as option labels', () => {
    const schema: AnswerSchema = {
      type: 'multi',
      options: [
        { value: 'secret', label: 'Secret' },
        { value: 'forms', label: 'Forms' },
        { value: 'push', label: 'Push' },
        { value: 'sso', label: 'SSO' },
      ],
    }
    render(
      <TypedAnswerView answer={{ kind: 'multi', value: ['secret', 'forms', 'push', 'sso'] }} answerSchema={schema} />,
    )
    const view = screen.getByTestId('typed-answer')
    assert.ok(view.textContent?.includes('Secret'))
    assert.ok(view.textContent?.includes('Forms'))
    assert.ok(view.textContent?.includes('Push'))
    assert.ok(view.textContent?.includes('SSO'))
    assert.equal(view.textContent?.includes('secret'), false)
  })

  it('renders nothing when there is no answer', () => {
    render(<TypedAnswerView answer={undefined} answerSchema={{ type: 'text' }} />)
    assert.equal(screen.queryByTestId('typed-answer'), null)
  })

  it('renders an empty multi-choice as an empty list without crashing', () => {
    const schema: AnswerSchema = {
      type: 'multi',
      options: [
        { value: 'secret', label: 'Secret' },
        { value: 'forms', label: 'Forms' },
      ],
    }
    render(<TypedAnswerView answer={{ kind: 'multi', value: [] }} answerSchema={schema} />)
    const view = screen.getByTestId('typed-answer')
    assert.equal(view.querySelectorAll('li').length, 0)
    assert.equal(view.textContent, '')
  })
})

describe('script-like copy is text, not HTML', () => {
  it('renders a question or label containing <script> as text', () => {
    const question = 'Can we enable <script>alert(1)</script>?'
    const { rerender } = render(<WorkItemHeadline prompt={question} actionName="ask_user" />)
    const heading = screen.getByRole('heading', { level: 1 })
    assert.equal(heading.textContent, question)
    assert.equal(heading.querySelector('script'), null)

    const schema: AnswerSchema = {
      type: 'single',
      options: [{ value: 'xss', label: '<script>alert(1)</script>' }],
    }
    rerender(
      <>
        <WorkItemHeadline prompt={question} actionName="ask_user" />
        <TypedAnswerView answer={{ kind: 'single', value: 'xss' }} answerSchema={schema} />
      </>,
    )
    const view = screen.getByTestId('typed-answer')
    assert.equal(view.textContent, '<script>alert(1)</script>')
    assert.equal(view.querySelector('script'), null)
  })
})
