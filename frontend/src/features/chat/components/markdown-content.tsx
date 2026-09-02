import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownCodeBlock } from '@/features/chat/components/markdown-code-block'
import { chatUi, type MarkdownTone } from '@/features/chat/chat-ui'
import '@/features/chat/styles/chat-markdown.css'
import { cn } from '@/lib/utils'

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const isHttp = typeof href === 'string' && /^https?:\/\//i.test(href)
  if (!isHttp) {
    return <span>{children}</span>
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  )
}

/** Renders message text as GFM markdown (XSS-safe via react-markdown AST). */
export function MarkdownContent({
  text,
  tone = 'incoming',
}: {
  text: string
  tone?: MarkdownTone
}) {
  return (
    <div className={cn('chat-markdown', chatUi.markdownRoot)} data-tone={tone}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Block fences render their own <pre>; unwrap default wrapper.
          pre({ children }) {
            return <>{children}</>
          },
          code: MarkdownCodeBlock,
          a: MarkdownLink,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
