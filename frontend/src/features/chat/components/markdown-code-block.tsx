import { useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import {
  formatLanguageLabel,
  highlightCode,
  normalizePrismLanguage,
} from '@/features/chat/lib/prism-languages'
import { cn } from '@/lib/utils'

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  node?: unknown
}

export function MarkdownCodeBlock({ className, children, ...props }: MarkdownCodeProps) {
  const raw = String(children ?? '').replace(/\n$/, '')
  const match = /language-([\w-]+)/.exec(className ?? '')
  const lang = match?.[1] ?? ''

  if (!lang) {
    return (
      <code className={cn('chat-md-inline', className)} {...props}>
        {raw}
      </code>
    )
  }

  const grammarLang = normalizePrismLanguage(lang)
  const highlighted = highlightCode(raw, lang)

  return (
    <div className="chat-md-code-wrap">
      <div className="chat-md-pre-header">
        <span className="chat-md-pre-label">{formatLanguageLabel(lang)}</span>
        <CopyCodeButton text={raw} />
      </div>
      <pre className={cn('chat-md-pre', grammarLang && `language-${grammarLang}`)}>
        <code
          className={cn(className, grammarLang && `language-${grammarLang}`)}
          {...props}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  )
}

function CopyCodeButton({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setLabel('Copied')
      window.setTimeout(() => setLabel('Copy'), 1500)
    } catch {
      setLabel('Failed')
      window.setTimeout(() => setLabel('Copy'), 1500)
    }
  }

  return (
    <button type="button" className="chat-md-copy-btn" onClick={copy}>
      {label}
    </button>
  )
}
