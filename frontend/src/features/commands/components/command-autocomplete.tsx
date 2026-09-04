import { useEffect, useState } from 'react'
import { commandsUi } from '@/features/commands/commands-ui'
import { cn } from '@/lib/utils'
import type { CommandBundle, CommandInfo } from '@/features/commands/types'

type CommandAutocompleteProps = {
  /** The slash name typed so far (without the leading `/`). */
  query: string
  commands: CommandInfo[]
  bundles: CommandBundle[]
  onSelect: (name: string) => void
  visible: boolean
  /** Index of the keyboard-highlighted row; owned by the parent so the
   * composer's own `onKeyDown` (which must stay on the input for typing to
   * work) can drive ArrowUp/ArrowDown/Enter without focus ever leaving the
   * input. See `useCommandAutocompleteKeys`. */
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}

export type SuggestionRow = {
  name: string
  description: string
  argsHint: string
  kind: 'command' | 'bundle'
}

/** Display order of the dropdown — bundles first, then commands. The
 * composer uses this same helper to translate a keyboard-picked index
 * back to a name, so the two can never disagree. */
export function suggestionRows(commands: CommandInfo[], bundles: CommandBundle[]): SuggestionRow[] {
  return [
    ...bundles.map((b) => ({ name: b.name, description: b.description, argsHint: '', kind: 'bundle' as const })),
    ...commands.map((c) => ({
      name: c.name,
      description: c.description,
      argsHint: c.argsHint,
      kind: 'command' as const,
    })),
  ]
}

/**
 * Same small, fully-local dropdown recipe as `ModelPicker` (not a base-ui
 * `Menu`): a positioned list above the composer pill, native buttons, no
 * portal. Keyboard handling lives on the composer's input (see
 * `useCommandAutocompleteKeys` below) because the input must keep focus
 * while the user keeps typing to narrow the list.
 */
export function CommandAutocomplete({
  query,
  commands,
  bundles,
  onSelect,
  visible,
  activeIndex,
  onActiveIndexChange,
}: CommandAutocompleteProps) {
  const rows = suggestionRows(commands, bundles)

  // Clamp the highlight whenever the list shrinks under it.
  useEffect(() => {
    if (rows.length === 0) return
    if (activeIndex >= rows.length) onActiveIndexChange(rows.length - 1)
    else if (activeIndex < 0) onActiveIndexChange(0)
  }, [rows.length, activeIndex, onActiveIndexChange])

  if (!visible || rows.length === 0) return null

  return (
    <div className={commandsUi.menu} role="listbox" aria-label={`Commands matching /${query}`}>
      {rows.map((row, index) => (
        <button
          key={`${row.kind}:${row.name}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={cn(commandsUi.item, index === activeIndex && commandsUi.itemActive)}
          onMouseEnter={() => onActiveIndexChange(index)}
          // mousedown, not click: a click would first blur the input, and
          // the composer would lose caret position before the pick lands.
          // Preventing default keeps focus in the input.
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(row.name)
          }}
        >
          <span className={commandsUi.itemHeader}>
            <span className={commandsUi.itemName}>/{row.name}</span>
            {row.argsHint ? <span className={commandsUi.itemArgs}>{row.argsHint}</span> : null}
            {row.kind === 'bundle' ? <span className={commandsUi.itemBadge}>bundle</span> : null}
          </span>
          {row.description ? <span className={commandsUi.itemDescription}>{row.description}</span> : null}
        </button>
      ))}
    </div>
  )
}

/**
 * Keyboard state for `CommandAutocomplete`, owned by whichever component
 * renders the text input. Returns the active index plus a `handleKeyDown`
 * the input's own `onKeyDown` should call FIRST; it returns `true` when it
 * consumed the key (so the caller must not also treat Enter as submit).
 */
export function useCommandAutocompleteKeys(
  rowCount: number,
  onPick: (index: number) => void,
  onDismiss: () => void,
) {
  const [activeIndex, setActiveIndex] = useState(0)

  function handleKeyDown(e: { key: string; preventDefault: () => void }): boolean {
    if (rowCount === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % rowCount)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + rowCount) % rowCount)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      onPick(Math.min(activeIndex, rowCount - 1))
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
      return true
    }
    return false
  }

  return { activeIndex, setActiveIndex, handleKeyDown }
}
