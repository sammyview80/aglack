import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Renders assistant/user message text as markdown (bold, italics, lists,
 * code blocks, tables, links, blockquotes — GFM via remark-gfm). Before
 * this, message text was a raw `<p>` — literal `**bold**`/`` `code` ``
 * markup showed up unrendered in the transcript. react-markdown never uses
 * `dangerouslySetInnerHTML`; it walks a parsed AST into React elements, so
 * this stays XSS-safe by construction without a separate sanitizer step. */
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
