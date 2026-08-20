'use client'

import { useState } from 'react'
import type { EditableFieldSpec, EditReasonConfig } from '@hitly/core'

const DEFAULT_EDIT_REASON_OPTIONS = [
  'customer_request',
  'pricing_correction',
  'policy_exception',
  'other',
]

export function EditableFieldsForm({
  fields,
  originalArgs,
  editReasonConfig,
}: {
  fields: Record<string, EditableFieldSpec>
  originalArgs: Record<string, unknown>
  editReasonConfig?: EditReasonConfig
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {}
    for (const [key, spec] of Object.entries(fields)) {
      const orig = originalArgs[key]
      if (spec.type === 'array' && Array.isArray(orig)) {
        initial[key] = [...orig]
      } else if (orig !== undefined) {
        initial[key] = orig
      } else if (spec.type === 'bool') {
        initial[key] = false
      } else if (spec.type === 'array') {
        initial[key] = []
      } else if (spec.type === 'int' || spec.type === 'float') {
        initial[key] = spec.min ?? 0
      } else {
        initial[key] = ''
      }
    }
    return initial
  })

  const [editReason, setEditReason] = useState('')
  const [editReasonText, setEditReasonText] = useState('')
  const [showPreview, setShowPreview] = useState(false)

  const dropdownConfig = editReasonConfig?.dropdown === false ? null : editReasonConfig?.dropdown ?? {}
  const textConfig = editReasonConfig?.text === false ? null : editReasonConfig?.text ?? {}

  function updateValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  function updateArrayItem(key: string, index: number, value: unknown) {
    setValues((prev) => {
      const arr = Array.isArray(prev[key]) ? [...(prev[key] as unknown[])] : []
      arr[index] = value
      return { ...prev, [key]: arr }
    })
  }

  function addArrayItem(key: string, itemType: 'string' | 'int' | 'float') {
    setValues((prev) => {
      const arr = Array.isArray(prev[key]) ? [...(prev[key] as unknown[])] : []
      if (itemType === 'string') arr.push('')
      else arr.push(0)
      return { ...prev, [key]: arr }
    })
  }

  function removeArrayItem(key: string, index: number) {
    setValues((prev) => {
      const arr = Array.isArray(prev[key]) ? [...(prev[key] as unknown[])] : []
      arr.splice(index, 1)
      return { ...prev, [key]: arr }
    })
  }

  const mergedArgs = { ...originalArgs, ...values }

  return (
    <div className="space-y-4">
      {Object.entries(fields).map(([key, spec]) => {
        const value = values[key]
        const label = spec.label ?? key

        if (spec.type === 'string') {
          return (
            <div key={key}>
              <label htmlFor={`field-${key}`} className="block text-sm font-medium">
                {label}
              </label>
              <input
                type="text"
                id={`field-${key}`}
                name={`editedArgs.${key}`}
                value={String(value ?? '')}
                onChange={(e) => updateValue(key, e.target.value)}
                minLength={spec.minLength}
                maxLength={spec.maxLength}
                className="mt-1 h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          )
        }

        if (spec.type === 'int' || spec.type === 'float') {
          return (
            <div key={key}>
              <label htmlFor={`field-${key}`} className="block text-sm font-medium">
                {label}
              </label>
              <input
                type="number"
                id={`field-${key}`}
                name={`editedArgs.${key}`}
                value={Number(value ?? 0)}
                onChange={(e) => {
                  const val = spec.type === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
                  updateValue(key, isNaN(val) ? 0 : val)
                }}
                step={spec.type === 'int' ? 1 : spec.step ?? 'any'}
                min={spec.min}
                max={spec.max}
                className="mt-1 h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          )
        }

        if (spec.type === 'bool') {
          return (
            <div key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`field-${key}`}
                name={`editedArgs.${key}`}
                checked={Boolean(value)}
                onChange={(e) => updateValue(key, e.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor={`field-${key}`} className="text-sm font-medium">
                {label}
              </label>
            </div>
          )
        }

        if (spec.type === 'enum') {
          const options = spec.options ?? []
          return (
            <div key={key}>
              <label htmlFor={`field-${key}`} className="block text-sm font-medium">
                {label}
              </label>
              <select
                id={`field-${key}`}
                name={`editedArgs.${key}`}
                value={String(value ?? '')}
                onChange={(e) => updateValue(key, e.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Select…</option>
                {options.map((opt, idx) => {
                  const optVal = typeof opt === 'string' ? opt : opt.value
                  const optText = typeof opt === 'string' ? opt : opt.text
                  return (
                    <option key={idx} value={optVal}>
                      {optText}
                    </option>
                  )
                })}
              </select>
            </div>
          )
        }

        if (spec.type === 'array') {
          const arr = Array.isArray(value) ? value : []
          const itemType = spec.items ?? 'string'
          return (
            <div key={key}>
              <label className="block text-sm font-medium">{label}</label>
              <div className="mt-2 space-y-2">
                {arr.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    {itemType === 'string' ? (
                      <input
                        type="text"
                        name={`editedArgs.${key}[${idx}]`}
                        value={String(item ?? '')}
                        onChange={(e) => updateArrayItem(key, idx, e.target.value)}
                        className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    ) : (
                      <input
                        type="number"
                        name={`editedArgs.${key}[${idx}]`}
                        value={Number(item ?? 0)}
                        onChange={(e) => {
                          const val = itemType === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
                          updateArrayItem(key, idx, isNaN(val) ? 0 : val)
                        }}
                        step={itemType === 'int' ? 1 : 'any'}
                        className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeArrayItem(key, idx)}
                      className="rounded-md border border-zinc-300 px-3 text-sm dark:border-zinc-600"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addArrayItem(key, itemType)}
                  disabled={spec.maxItems !== undefined && arr.length >= spec.maxItems}
                  className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm dark:bg-zinc-700 disabled:opacity-50"
                >
                  Add item
                </button>
              </div>
            </div>
          )
        }

        return null
      })}

      {dropdownConfig ? (
        <div>
          <label htmlFor="editReason" className="block text-sm font-medium">
            {dropdownConfig.label ?? 'Edit reason'}
            {dropdownConfig.required ? ' *' : ''}
          </label>
          <select
            id="editReason"
            name="editReason"
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            required={dropdownConfig.required}
            className="mt-1 h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Select…</option>
            {(dropdownConfig.options ?? DEFAULT_EDIT_REASON_OPTIONS).map((opt, idx) => {
              const optVal = typeof opt === 'string' ? opt : opt.value
              const optText = typeof opt === 'string' ? opt : opt.text
              return (
                <option key={idx} value={optVal}>
                  {optText}
                </option>
              )
            })}
          </select>
        </div>
      ) : null}

      {textConfig ? (
        <div>
          <label htmlFor="editReasonText" className="block text-sm font-medium">
            {textConfig.label ?? 'Edit reason details'}
            {textConfig.required ? ' *' : ''}
          </label>
          <textarea
            id="editReasonText"
            name="editReasonText"
            value={editReasonText}
            onChange={(e) => setEditReasonText(e.target.value)}
            required={textConfig.required}
            maxLength={textConfig.maxLength ?? 2000}
            className="mt-1 min-h-20 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      ) : null}

      <input type="hidden" name="editedArgs" value={JSON.stringify(values)} />

      <details className="rounded-md border border-zinc-200 dark:border-zinc-800" open={showPreview}>
        <summary
          className="cursor-pointer select-none px-4 py-2 text-sm font-medium"
          onClick={(e) => {
            e.preventDefault()
            setShowPreview(!showPreview)
          }}
        >
          JSON preview (read-only)
        </summary>
        <pre className="overflow-auto border-t border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
          {JSON.stringify(mergedArgs, null, 2)}
        </pre>
      </details>
    </div>
  )
}
