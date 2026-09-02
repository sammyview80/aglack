import Prism from 'prismjs'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markup'

/** Map common fence aliases to a registered Prism grammar id. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function normalizePrismLanguage(lang: string): string {
  const key = lang.trim().toLowerCase()
  const aliases: Record<string, string> = {
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    js: 'javascript',
    ts: 'typescript',
    yml: 'yaml',
    html: 'markup',
    xml: 'markup',
  }
  return aliases[key] ?? key
}

export function highlightCode(code: string, lang: string): string {
  const grammarLang = normalizePrismLanguage(lang)
  const grammar = Prism.languages[grammarLang]
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, grammarLang)
}

export function formatLanguageLabel(lang: string): string {
  const normalized = normalizePrismLanguage(lang)
  if (normalized === 'markup') return 'HTML'
  return normalized.toUpperCase()
}
