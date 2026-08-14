import { type ReactNode } from 'react'
import { Linking, Pressable, Text, View, StyleSheet } from 'react-native'
import { lexer, type Token, type Tokens } from 'marked'
import type { ApprovalAttachment } from '@hitly/core'
import { colors } from '../../theme'

function openUrl(url?: string) {
  if (!url) return
  void Linking.openURL(url).catch(() => undefined)
}

function Inline({ tokens }: { tokens?: Token[] }) {
  if (!tokens?.length) return null
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`
        if (token.type === 'text') {
          const text = token as Tokens.Text
          return text.tokens ? <Inline key={key} tokens={text.tokens} /> : <Text key={key}>{text.text}</Text>
        }
        if (token.type === 'strong') {
          return (
            <Text key={key} style={styles.strong}>
              <Inline tokens={(token as Tokens.Strong).tokens} />
            </Text>
          )
        }
        if (token.type === 'em') {
          return (
            <Text key={key} style={styles.em}>
              <Inline tokens={(token as Tokens.Em).tokens} />
            </Text>
          )
        }
        if (token.type === 'del') {
          return (
            <Text key={key} style={styles.del}>
              <Inline tokens={(token as Tokens.Del).tokens} />
            </Text>
          )
        }
        if (token.type === 'codespan') {
          return (
            <Text key={key} style={styles.codespan}>
              {(token as Tokens.Codespan).text}
            </Text>
          )
        }
        if (token.type === 'link') {
          const link = token as Tokens.Link
          return (
            <Text key={key} style={styles.link} onPress={() => openUrl(link.href)}>
              {link.tokens ? <Inline tokens={link.tokens} /> : link.text}
            </Text>
          )
        }
        if (token.type === 'br') return <Text key={key}>{'\n'}</Text>
        if (token.type === 'escape' || token.type === 'html') {
          return <Text key={key}>{(token as Tokens.Escape | Tokens.HTML).text}</Text>
        }
        return <Text key={key}>{'raw' in token ? token.raw : ''}</Text>
      })}
    </>
  )
}

function Blocks({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`
        if (token.type === 'space') return <View key={key} style={styles.space} />
        if (token.type === 'hr') return <View key={key} style={styles.hr} />
        if (token.type === 'heading') {
          const heading = token as Tokens.Heading
          return (
            <Text key={key} style={[styles.heading, heading.depth <= 2 ? styles.h1 : heading.depth === 3 ? styles.h3 : styles.h4]}>
              <Inline tokens={heading.tokens} />
            </Text>
          )
        }
        if (token.type === 'paragraph') {
          return (
            <Text key={key} style={styles.paragraph}>
              <Inline tokens={(token as Tokens.Paragraph).tokens} />
            </Text>
          )
        }
        if (token.type === 'blockquote') {
          return (
            <View key={key} style={styles.blockquote}>
              <Blocks tokens={(token as Tokens.Blockquote).tokens} />
            </View>
          )
        }
        if (token.type === 'code') {
          const code = token as Tokens.Code
          return (
            <Text key={key} style={styles.code}>
              {code.text}
            </Text>
          )
        }
        if (token.type === 'list') {
          const list = token as Tokens.List
          return (
            <View key={key} style={styles.list}>
              {list.items.map((item, itemIndex) => (
                <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                  <Text style={styles.bullet}>{list.ordered ? `${itemIndex + 1}.` : '•'}</Text>
                  <View style={styles.listBody}>
                    <Blocks tokens={item.tokens} />
                  </View>
                </View>
              ))}
            </View>
          )
        }
        if (token.type === 'html') {
          return (
            <Text key={key} style={styles.paragraph}>
              {(token as Tokens.HTML).text}
            </Text>
          )
        }
        if (token.type === 'table') {
          const table = token as Tokens.Table
          return (
            <View key={key} style={styles.table}>
              <View style={styles.tableRow}>
                {table.header.map((cell, cellIndex) => (
                  <Text key={`${key}-h-${cellIndex}`} style={[styles.tableCell, styles.tableHead]}>
                    <Inline tokens={cell.tokens} />
                  </Text>
                ))}
              </View>
              {table.rows.map((row, rowIndex) => (
                <View key={`${key}-r-${rowIndex}`} style={styles.tableRow}>
                  {row.map((cell, cellIndex) => (
                    <Text key={`${key}-r-${rowIndex}-${cellIndex}`} style={styles.tableCell}>
                      <Inline tokens={cell.tokens} />
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          )
        }
        return (
          <Text key={key} style={styles.paragraph}>
            {'raw' in token ? token.raw : ''}
          </Text>
        )
      })}
    </>
  )
}

export function ContextMarkdown({
  value,
  externalUrls,
  attachments,
}: {
  value?: string
  externalUrls?: string[]
  attachments?: ApprovalAttachment[]
}) {
  const markdown = value?.trim()
  const urls = externalUrls?.filter((url) => url.trim()) ?? []
  const files = attachments?.filter((file) => file.name.trim()) ?? []
  const empty = !markdown && urls.length === 0 && files.length === 0
  let body: ReactNode = null
  if (markdown) {
    try {
      body = <Blocks tokens={lexer(markdown, { gfm: true })} />
    } catch {
      body = <Text style={styles.paragraph}>{markdown}</Text>
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Context</Text>
      {empty ? <Text style={styles.muted}>No context provided.</Text> : null}
      {body}
      {urls.length > 0 ? (
        <View style={styles.meta}>
          <Text style={styles.metaTitle}>Links</Text>
          {urls.map((url) => (
            <Pressable key={url} onPress={() => openUrl(url)}>
              <Text style={styles.link}>{url}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.meta}>
          <Text style={styles.metaTitle}>Attachments</Text>
          <Text style={styles.muted}>File preview is not implemented yet.</Text>
          {files.map((file) => (
            <Pressable key={`${file.name}:${file.url ?? ''}`} onPress={() => openUrl(file.url)} disabled={!file.url}>
              <Text style={file.url ? styles.link : styles.paragraph}>
                {file.name}
                {file.contentType ? ` · ${file.contentType}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: colors.card,
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 8 },
  muted: { fontSize: 13, color: colors.muted },
  paragraph: { fontSize: 15, lineHeight: 22, color: colors.text, marginBottom: 10 },
  heading: { color: colors.text, fontWeight: '700', marginBottom: 8, marginTop: 4 },
  h1: { fontSize: 20, lineHeight: 26 },
  h3: { fontSize: 17, lineHeight: 23 },
  h4: { fontSize: 15, lineHeight: 21 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  codespan: {
    fontFamily: 'Courier',
    fontSize: 13,
    backgroundColor: colors.bg,
    color: colors.text,
  },
  code: {
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 18,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    overflow: 'hidden',
  },
  link: { color: colors.text, textDecorationLine: 'underline', fontSize: 15, lineHeight: 22 },
  list: { marginBottom: 10 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  bullet: { width: 18, fontSize: 15, lineHeight: 22, color: colors.text },
  listBody: { flex: 1 },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: 10,
    marginBottom: 10,
  },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
  space: { height: 6 },
  table: { marginBottom: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tableCell: { flex: 1, padding: 8, fontSize: 13, color: colors.text },
  tableHead: { fontWeight: '700', backgroundColor: colors.bg },
  meta: { marginTop: 12 },
  metaTitle: { fontSize: 11, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: 6 },
})
