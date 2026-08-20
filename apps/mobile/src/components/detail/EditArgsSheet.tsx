import { useState } from 'react'
import { Modal, Pressable, ScrollView, Switch, Text, TextInput, View, StyleSheet } from 'react-native'
import type { EditableFieldSpec, EditReasonConfig } from '@hitly/core'
import { colors } from '../../theme'
import { buildEditSubmit } from './edit-helpers'

const DEFAULT_EDIT_REASON_OPTIONS = [
  'customer_request',
  'pricing_correction',
  'policy_exception',
  'other',
]

export function EditArgsSheet({
  visible,
  fields,
  originalArgs,
  editReasonConfig,
  onSubmit,
  onClose,
}: {
  visible: boolean
  fields: Record<string, EditableFieldSpec>
  originalArgs: Record<string, unknown>
  editReasonConfig?: EditReasonConfig
  onSubmit: (data: { editedArgs: Record<string, unknown>; editReason?: string; editReasonText?: string }) => void
  onClose: () => void
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

  function handleSubmit() {
    const payload = buildEditSubmit({
      values,
      fields,
      editReason: editReason || undefined,
      editReasonText: editReasonText || undefined,
    })
    onSubmit(payload)
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Edit arguments</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {Object.entries(fields).map(([key, spec]) => {
              const value = values[key]
              const label = spec.label ?? key

              if (spec.type === 'string') {
                return (
                  <View key={key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <TextInput
                      value={String(value ?? '')}
                      onChangeText={(text) => updateValue(key, text)}
                      maxLength={spec.maxLength}
                      style={styles.input}
                    />
                  </View>
                )
              }

              if (spec.type === 'int' || spec.type === 'float') {
                return (
                  <View key={key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <TextInput
                      value={String(value ?? 0)}
                      onChangeText={(text) => {
                        const val = spec.type === 'int' ? parseInt(text, 10) : parseFloat(text)
                        updateValue(key, isNaN(val) ? 0 : val)
                      }}
                      keyboardType="numeric"
                      style={styles.input}
                    />
                  </View>
                )
              }

              if (spec.type === 'bool') {
                return (
                  <View key={key} style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <Switch
                      value={Boolean(value)}
                      onValueChange={(checked) => updateValue(key, checked)}
                    />
                  </View>
                )
              }

              if (spec.type === 'enum') {
                const options = spec.options ?? []
                return (
                  <View key={key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    <View style={styles.enumOptions}>
                      <Pressable
                        onPress={() => updateValue(key, '')}
                        style={[styles.enumOption, value === '' && styles.enumOptionActive]}
                      >
                        <Text style={[styles.enumOptionText, value === '' && styles.enumOptionTextActive]}>
                          Select…
                        </Text>
                      </Pressable>
                      {options.map((opt, idx) => {
                        const optVal = typeof opt === 'string' ? opt : opt.value
                        const optText = typeof opt === 'string' ? opt : opt.text
                        return (
                          <Pressable
                            key={idx}
                            onPress={() => updateValue(key, optVal)}
                            style={[styles.enumOption, value === optVal && styles.enumOptionActive]}
                          >
                            <Text
                              style={[styles.enumOptionText, value === optVal && styles.enumOptionTextActive]}
                            >
                              {optText}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  </View>
                )
              }

              if (spec.type === 'array') {
                const arr = Array.isArray(value) ? value : []
                const itemType = spec.items ?? 'string'
                return (
                  <View key={key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{label}</Text>
                    {arr.map((item, idx) => (
                      <View key={idx} style={styles.arrayRow}>
                        <TextInput
                          value={itemType === 'string' ? String(item ?? '') : String(item ?? 0)}
                          onChangeText={(text) => {
                            if (itemType === 'string') {
                              updateArrayItem(key, idx, text)
                            } else {
                              const val = itemType === 'int' ? parseInt(text, 10) : parseFloat(text)
                              updateArrayItem(key, idx, isNaN(val) ? 0 : val)
                            }
                          }}
                          keyboardType={itemType === 'string' ? 'default' : 'numeric'}
                          style={[styles.input, styles.arrayInput]}
                        />
                        <Pressable onPress={() => removeArrayItem(key, idx)} style={styles.removeButton}>
                          <Text style={styles.removeButtonText}>Remove</Text>
                        </Pressable>
                      </View>
                    ))}
                    <Pressable
                      onPress={() => addArrayItem(key, itemType)}
                      disabled={spec.maxItems !== undefined && arr.length >= spec.maxItems}
                      style={[styles.addButton, spec.maxItems !== undefined && arr.length >= spec.maxItems && styles.addButtonDisabled]}
                    >
                      <Text style={styles.addButtonText}>Add item</Text>
                    </Pressable>
                  </View>
                )
              }

              return null
            })}

            {dropdownConfig ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>
                  {dropdownConfig.label ?? 'Edit reason'}
                  {dropdownConfig.required ? ' *' : ''}
                </Text>
                <View style={styles.enumOptions}>
                  <Pressable
                    onPress={() => setEditReason('')}
                    style={[styles.enumOption, editReason === '' && styles.enumOptionActive]}
                  >
                    <Text style={[styles.enumOptionText, editReason === '' && styles.enumOptionTextActive]}>
                      Select…
                    </Text>
                  </Pressable>
                  {(dropdownConfig.options ?? DEFAULT_EDIT_REASON_OPTIONS).map((opt, idx) => {
                    const optVal = typeof opt === 'string' ? opt : opt.value
                    const optText = typeof opt === 'string' ? opt : opt.text
                    return (
                      <Pressable
                        key={idx}
                        onPress={() => setEditReason(optVal)}
                        style={[styles.enumOption, editReason === optVal && styles.enumOptionActive]}
                      >
                        <Text
                          style={[styles.enumOptionText, editReason === optVal && styles.enumOptionTextActive]}
                        >
                          {optText}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            ) : null}

            {textConfig ? (
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>
                  {textConfig.label ?? 'Edit reason details'}
                  {textConfig.required ? ' *' : ''}
                </Text>
                <TextInput
                  value={editReasonText}
                  onChangeText={setEditReasonText}
                  maxLength={textConfig.maxLength ?? 2000}
                  multiline
                  style={[styles.input, styles.textArea]}
                />
              </View>
            ) : null}

            <View style={styles.previewSection}>
              <Pressable onPress={() => setShowPreview(!showPreview)} style={styles.previewHeader}>
                <Text style={styles.previewHeaderText}>JSON preview (read-only)</Text>
                <Text style={styles.previewHeaderIcon}>{showPreview ? '▼' : '▶'}</Text>
              </Pressable>
              {showPreview ? (
                <ScrollView horizontal style={styles.previewScroll}>
                  <Text style={styles.previewText}>{JSON.stringify(mergedArgs, null, 2)}</Text>
                </ScrollView>
              ) : null}
            </View>
          </ScrollView>

          <Pressable style={styles.button} onPress={handleSubmit}>
            <Text style={styles.label}>Save edit</Text>
          </Pressable>
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    padding: 24,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: '90%',
  },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: colors.text },
  scroll: { maxHeight: 400 },
  scrollContent: { gap: 16 },
  field: { gap: 4 },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { fontSize: 14, fontWeight: '500', color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  enumOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  enumOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  enumOptionActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  enumOptionText: { fontSize: 13, color: colors.text },
  enumOptionTextActive: { color: colors.accentFg },
  arrayRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  arrayInput: { flex: 1 },
  removeButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  removeButtonText: { fontSize: 13, color: colors.text },
  addButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.muted,
    alignItems: 'center',
  },
  addButtonDisabled: { opacity: 0.5 },
  addButtonText: { fontSize: 13, fontWeight: '500', color: colors.text },
  previewSection: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  previewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
    backgroundColor: colors.bg,
  },
  previewHeaderText: { fontSize: 14, fontWeight: '500', color: colors.text },
  previewHeaderIcon: { fontSize: 12, color: colors.muted },
  previewScroll: { maxHeight: 200, borderTopWidth: 1, borderTopColor: colors.border },
  previewText: { fontSize: 11, fontFamily: 'monospace', color: colors.text, padding: 12 },
  button: { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 8, marginTop: 16 },
  label: { color: colors.accentFg, fontWeight: '600', textAlign: 'center' },
  cancel: { marginTop: 12, textAlign: 'center', color: colors.muted },
})
