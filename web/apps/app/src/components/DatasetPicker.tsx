import { Button, Popover, Tooltip } from '@supabi/ui'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useWorkbench } from '../workbench/context'
import { ResourceTree } from '../workbench/ResourceTree'
import { Icon } from './Icon'
import './DatasetPicker.css'

export interface DatasetPickerProps {
  value?: string
  selectedName?: string
  onChange: (id: string) => void
  defaultOpen?: boolean
  disabled?: boolean
  /** What else can be done with the chosen dataset, at the end of the line it is named on. */
  actions?: ReactNode
}

/**
 * The workbench's dataset tree, opened from a line that reads as text: the
 * place to choose one while none is, then its name, with a button to change
 * it beside what else can be done with it. Choosing another is a step of its
 * own, so the name itself does nothing when clicked. While the tree is open
 * the line is where it is searched.
 */
export function DatasetPicker({ value, selectedName, onChange, defaultOpen = !value, disabled, actions }: DatasetPickerProps) {
  const { t } = useTranslation()
  const { resources, loaded, error, reload } = useWorkbench()
  const [open, setOpen] = useState(defaultOpen)
  const [search, setSearch] = useState('')
  const [retrying, setRetrying] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const focusOnOpen = useRef(false)
  const treeId = useId()
  const selectedLabel = resources.datasets.find((dataset) => dataset.id === value)?.name ?? selectedName ?? value
  const visible = open && !disabled
  // Chosen and not being changed, the name is shown as text; otherwise the line is a field to search in.
  const named = Boolean(value) && !visible
  // Where the focus goes back to when the tree closes: the field is gone once a dataset is named.
  const refocus = () => (value ? change.current : input.current)?.focus()

  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])

  const close = () => {
    setOpen(false)
    setSearch('')
    focusOnOpen.current = false
  }
  const select = (id: string) => {
    close()
    refocus()
    onChange(id)
  }
  const focusTree = () => {
    const rows = panel.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')
    const selected = panel.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
    const target = selected ?? rows?.[0]
    target?.focus()
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (!visible) return
      event.preventDefault()
      event.stopPropagation()
      close()
      refocus()
    } else if (event.key === 'ArrowDown' && event.target === input.current) {
      event.preventDefault()
      if (visible) focusTree()
      else {
        focusOnOpen.current = true
        setOpen(true)
      }
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault()
      if (!visible) setOpen(true)
      else if (search.trim()) panel.current?.querySelector<HTMLButtonElement>('[data-resource-id]')?.click()
      else focusTree()
    }
  }

  return (
    <Popover
      open={visible}
      onOpenChange={(next) => {
        if (next && !disabled) setOpen(true)
        else close()
      }}
      afterOpenChange={(next) => {
        if (next && focusOnOpen.current) {
          focusOnOpen.current = false
          focusTree()
        } else if (!next && (!document.activeElement || document.activeElement === document.body)) {
          // Closed by the panel itself, as Escape is before the field hears of it, the focus went with the field
          // that a chosen dataset's name replaces: it goes back to what opened the panel.
          refocus()
        }
      }}
      content={
        <div className="dataset-picker-panel" ref={panel} onKeyDown={keys}>
          <ResourceTree kind="dataset" id={treeId} filter={search} selection={{ value, onSelect: select }} />
          {error && <div className="dataset-picker-action"><Button size="sm" loading={retrying} onClick={() => {
            setRetrying(true)
            void reload().finally(() => setRetrying(false))
          }}>{t('common.retry')}</Button></div>}
          {loaded && !error && !search.trim() && resources.datasets.length === 0 && <div className="dataset-picker-action"><Link to="/explore">{t('workbench.new.dataset')}</Link></div>}
        </div>
      }
    >
      {/* The whole line opens the tree, except what is told to keep its clicks to itself. */}
      <div className={`dataset-picker${disabled ? ' disabled' : ''}${named ? ' named' : ''}`} onKeyDown={keys}>
        {/* The mark the tree gives a dataset, there whether one is chosen, being searched for or not chosen yet, so the text never moves. */}
        <Icon name="dataset" size={14} />
        {named ? (
          // A click on the name is not a request to change it.
          <span className="dataset-picker-name" title={selectedLabel} onClick={(event) => event.stopPropagation()}>{selectedLabel}</span>
        ) : (
          <input
            ref={input}
            role="combobox"
            aria-label={t('explore.searchDatasets')}
            aria-expanded={visible}
            aria-controls={visible ? treeId : undefined}
            aria-haspopup="tree"
            aria-autocomplete="list"
            autoComplete="off"
            disabled={disabled}
            title={selectedLabel}
            placeholder={selectedLabel || t('explore.chooseDataset')}
            value={search}
            // The field is part of the open panel: a click in it must not toggle the panel shut.
            onClick={(event) => visible && event.stopPropagation()}
            onChange={(event) => {
              setSearch(event.target.value)
              setOpen(true)
            }}
          />
        )}
        {value && (
          <Tooltip title={t('explore.changeDataset')}>
            <button ref={change} type="button" className="wb-icon-button" aria-label={t('explore.changeDataset')} aria-expanded={visible} disabled={disabled}>
              <Icon name="swap" size={14} />
            </button>
          </Tooltip>
        )}
        {value && actions && <span className="dataset-picker-actions" onClick={(event) => event.stopPropagation()}>{actions}</span>}
      </div>
    </Popover>
  )
}
