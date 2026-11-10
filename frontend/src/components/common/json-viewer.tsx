import { json } from '@codemirror/lang-json'
import { HighlightStyle, foldAll, foldGutter, syntaxHighlighting, unfoldAll } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { ChevronsDownUp, ChevronsUpDown, WrapText } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn, formatBytes } from '@/lib/utils'
import { CopyButton } from './copy-button'

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--code-key)' },
  { tag: t.string, color: 'var(--code-string)' },
  { tag: t.number, color: 'var(--code-number)' },
  { tag: [t.bool, t.null], color: 'var(--code-literal)' },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket], color: 'var(--code-punct)' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--foreground)', fontSize: '12.5px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontVariationSettings: "'wdth' 87.5",
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--faint)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '34px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer', color: 'var(--muted)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--primary-soft) !important' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-hover)',
    border: '1px solid var(--border-strong)',
    color: 'var(--muted)',
    borderRadius: '4px',
    padding: '0 6px',
    margin: '0 2px',
  },
})

interface JsonViewerProps {
  value: unknown
  className?: string
  maxHeight?: number
  title?: string
}

/** Read-only JSON viewer: syntax highlighting, folding, copy, wrap toggle. */
export function JsonViewer({ value, className, maxHeight = 520, title = 'JSON' }: JsonViewerProps) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const [wrap, setWrap] = useState(false)
  const text = useMemo(() => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)), [value])
  const size = useMemo(() => new Blob([text]).size, [text])

  const extensions = useMemo(
    () => [
      json(),
      syntaxHighlighting(highlight),
      foldGutter({
        markerDOM(open) {
          const el = document.createElement('span')
          el.textContent = open ? '▾' : '▸'
          el.setAttribute('aria-label', open ? 'Collapse' : 'Expand')
          return el
        },
      }),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': title, tabindex: '0' }),
      theme,
      ...(wrap ? [EditorView.lineWrapping] : []),
    ],
    [wrap, title],
  )

  /**
   * Re-measure once the mono webfont has loaded: CodeMirror measures line heights when
   * it's created, and the font only starts loading once text uses it. (Editors that
   * start off-screen measure themselves when scrolled into view.)
   */
  const onCreateEditor = (view: EditorView) => {
    const remeasure = () => {
      if (view.dom.isConnected) view.requestMeasure()
    }
    document.fonts?.load?.('12.5px "Martian Mono Variable"').then(remeasure, remeasure)
  }

  const run = (cmd: typeof foldAll) => {
    const view = ref.current?.view
    if (view) cmd(view)
  }

  return (
    <div className={cn('min-w-0 overflow-hidden rounded-md border border-border bg-sunken', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-3">
        <span className="tabular text-sm text-muted">{formatBytes(size)}</span>
        <div className="flex items-center">
          <Button variant="ghost" size="icon-sm" aria-label="Collapse all" title="Collapse all" onClick={() => run(foldAll)}>
            <ChevronsDownUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Expand all" title="Expand all" onClick={() => run(unfoldAll)}>
            <ChevronsUpDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Wrap long lines"
            aria-pressed={wrap}
            title="Wrap long lines"
            className={cn(wrap && 'text-primary')}
            onClick={() => setWrap((w) => !w)}
          >
            <WrapText />
          </Button>
          <CopyButton value={text} label="Copy JSON" />
        </div>
      </div>
      <div style={{ maxHeight }} className="overflow-auto">
        <CodeMirror
          ref={ref}
          value={text}
          theme="none"
          extensions={extensions}
          onCreateEditor={onCreateEditor}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            highlightSelectionMatches: false,
            searchKeymap: true,
            syntaxHighlighting: false,
            bracketMatching: false,
            autocompletion: false,
            closeBrackets: false,
            drawSelection: true,
          }}
        />
      </div>
    </div>
  )
}

/** Plain-text body (e.g. an HTML error page from a destination). Rendered as text, never as HTML. */
export function TextBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('relative min-w-0 rounded-md border border-border bg-sunken', className)}>
      <CopyButton value={text} label="Copy" className="absolute top-1 right-1" />
      <pre className="max-h-80 overflow-auto px-3.5 py-3 pr-10 text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
        {text}
      </pre>
    </div>
  )
}
