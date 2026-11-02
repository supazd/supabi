import { Button, DataTable, Dialog, Field, Input, MultiSelect, Segmented, Select, TextArea, Tooltip } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { useSession } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { loadDirectory, type Directory } from '../../components/SubjectPicker'
import { type Attribute } from '../dataset/PolicyCondition'
import { ConfirmDialog, found, KeptAsync, Person, RowMenu, SearchBox, SettingsPage, useAction } from './shared'

/** An attribute being added, or one being renamed. */
type Definition = { key: string; name: string; existing: boolean }

function AttributeManager({ attributes, directory, reload, definition, onDefinitionChange }: { attributes: Attribute[]; directory: Directory; reload: () => void; definition?: Definition; onDefinitionChange: (definition?: Definition) => void }) {
  const { t } = useTranslation()
  const admin = useSession().atLeast('admin')
  const [kind, setKind] = useState<'user' | 'group'>('user')
  const [search, setSearch] = useState('')
  // `one` when it is a single value, opened from its cell.
  const [assignment, setAssignment] = useState<{ key: string; ids: string[]; text: string; remove: boolean; one: boolean }>()
  const [removing, setRemoving] = useState<Attribute>()
  const action = useAction()
  const custom = attributes.filter((a) => !a.builtin)
  const people = kind === 'user' ? directory.users.map((u) => ({ id: u.id, name: u.displayName, email: u.email })) : directory.groups.map((g) => ({ id: g.id, name: g.name, email: '' }))
  const rows = people.filter((p) => found(search, p.name, p.email))
  const effective = (a: Attribute, id: string) => {
    const explicit = a.assignments.find((v) => v.subject[kind] === id)
    if (explicit) return { values: explicit.values, inherited: false }
    const groups = kind === 'user' ? directory.groups.filter((g) => g.userIds.includes(id)).map((g) => g.id) : []
    return { values: [...new Set(a.assignments.filter((v) => v.subject.group && groups.includes(v.subject.group)).flatMap((v) => v.values))], inherited: kind === 'user' }
  }
  const saveAssignment = () => {
    if (!assignment) return
    const a = custom.find((a) => a.key === assignment.key)
    if (!a) return
    const values = [...new Set(assignment.text.split('\n').filter((v) => v.trim() !== ''))]
    const assignments = a.assignments.filter((v) => !assignment.ids.includes(v.subject[kind] ?? ''))
    if (!assignment.remove) assignments.push(...assignment.ids.map((id) => ({ subject: { [kind]: id }, values })))
    void action.run(() => unwrap(api.PUT('/user-attributes/{key}', { params: { path: { key: a.key } }, body: { name: a.name, assignments } })), () => { setAssignment(undefined); reload() })
  }
  const saveDefinition = () => {
    if (!definition) return
    const existing = attributes.find((a) => a.key === definition.key)
    void action.run(() => unwrap(api.PUT('/user-attributes/{key}', { params: { path: { key: definition.key } }, body: { name: definition.name, assignments: existing?.assignments ?? [] } })), () => { onDefinitionChange(undefined); reload() })
  }
  const definable = Boolean(definition?.name.trim()) && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(definition?.key ?? '') && (definition?.existing || !attributes.some((a) => a.key === definition?.key))
  const single = assignment?.one ? { name: people.find((p) => p.id === assignment.ids[0])?.name ?? '', attribute: custom.find((a) => a.key === assignment.key)?.name ?? '' } : undefined

  return <>
    <div className="settings-toolbar spread">
      <div className="settings-toolbar">
        <Segmented<'user' | 'group'> aria-label={t('attribute.subjectType')} value={kind} onChange={setKind} options={[{ value: 'user', label: t('member.users') }, { value: 'group', label: t('settings.groups') }]} />
        <SearchBox label={t('attribute.search')} value={search} onChange={setSearch} />
      </div>
      {admin && <Button disabled={!custom.length} onClick={() => setAssignment({ key: custom[0]!.key, ids: [], text: '', remove: false, one: false })}>{t('attribute.bulk')}</Button>}
    </div>
    {action.error && !definition && !assignment && <ErrorAlert error={action.error} />}
    <DataTable aria-label={t('attribute.title')} rows={rows} rowKey={(r) => r.id} pageSize={20} empty={t('common.none')} columns={[
      { key: 'name', title: t('common.name'), render: (r) => <Person name={r.name} email={r.email || undefined} /> },
      ...custom.map((a) => ({
        key: a.key,
        // An attribute's own menu is on its heading; the key rules know it by is in the heading's tooltip.
        title: (
          <span className="settings-column-title">
            <Tooltip title={t('attribute.keyOf', { key: a.key })}><span>{a.name}</span></Tooltip>
            {admin && <RowMenu label={t('settings.actionsOf', { name: a.name })} items={[
              { key: 'edit', label: t('attribute.edit'), onSelect: () => onDefinitionChange({ key: a.key, name: a.name, existing: true }) },
              { key: 'delete', label: t('attribute.delete'), danger: true, separated: true, onSelect: () => setRemoving(a) },
            ]} />}
          </span>
        ),
        render: (r: { id: string; name: string }) => {
          const { values, inherited } = effective(a, r.id)
          const text = <><span>{values.join('、') || '—'}</span>{inherited && values.length > 0 && <span className="note small">{t('attribute.inherited')}</span>}</>
          if (!admin) return <span className="settings-person">{text}</span>
          // The value is what is clicked to change it.
          return (
            <button type="button" className="settings-cell-edit" aria-label={t('attribute.editValue', { name: r.name, attribute: a.name })} onClick={() => {
              const explicit = a.assignments.find((v) => v.subject[kind] === r.id)
              setAssignment({ key: a.key, ids: [r.id], text: explicit?.values.join('\n') ?? '', remove: !explicit, one: true })
            }}>{text}</button>
          )
        },
      })),
    ]} />
    {!custom.length && <p className="note">{t(admin ? 'attribute.empty' : 'attribute.emptyReadOnly')}</p>}
    <Dialog open={!!definition} title={t(definition?.existing ? 'attribute.edit' : 'attribute.add')} onClose={() => !action.busy && onDefinitionChange(undefined)} actions={<><Button disabled={action.busy} onClick={() => onDefinitionChange(undefined)}>{t('common.cancel')}</Button><Button variant="primary" loading={action.busy} disabled={!definable} onClick={saveDefinition}>{t('common.save')}</Button></>}>
      {definition && <div className="stack">
        <Field label={t('common.name')} htmlFor="attribute-name"><Input id="attribute-name" maxLength={100} value={definition.name} onChange={(name) => onDefinitionChange({ ...definition, name })} /></Field>
        <Field label={t('attribute.key')} htmlFor="attribute-key"><Input id="attribute-key" maxLength={64} disabled={definition.existing} value={definition.key} onChange={(key) => onDefinitionChange({ ...definition, key })} /></Field>
        <p className="note small">{t('attribute.keyHint')}</p>{action.error && <ErrorAlert error={action.error} />}
      </div>}
    </Dialog>
    <Dialog open={!!assignment} title={single ? t('attribute.editValue', single) : t('attribute.bulk')} onClose={() => !action.busy && setAssignment(undefined)} actions={<><Button disabled={action.busy} onClick={() => setAssignment(undefined)}>{t('common.cancel')}</Button><Button variant="primary" loading={action.busy} disabled={!assignment?.ids.length || !assignment.key} onClick={saveAssignment}>{t('common.save')}</Button></>}>
      {assignment && <div className="stack">
        {!assignment.one && <>
          <Field label={t('attribute.title')}><Select<string> block aria-label={t('attribute.title')} value={assignment.key} options={custom.map((a) => ({ value: a.key, label: a.name }))} onChange={(key) => setAssignment({ ...assignment, key, text: '', remove: false })} /></Field>
          <Field label={t(kind === 'user' ? 'member.users' : 'settings.groups')}><MultiSelect<string> aria-label={t('attribute.assignTo')} value={assignment.ids} options={people.map((p) => ({ value: p.id, label: p.email ? `${p.name} (${p.email})` : p.name }))} onChange={(ids) => setAssignment({ ...assignment, ids })} /></Field>
        </>}
        <Segmented<'set' | 'remove'> aria-label={t('attribute.assignmentMode')} value={assignment.remove ? 'remove' : 'set'} options={[{ value: 'set', label: t('attribute.setValues') }, { value: 'remove', label: t('attribute.removeValues') }]} onChange={(mode) => setAssignment({ ...assignment, remove: mode === 'remove' })} />
        {!assignment.remove && <Field label={t('attribute.values')} htmlFor="attribute-values"><TextArea id="attribute-values" rows={5} value={assignment.text} onChange={(text) => setAssignment({ ...assignment, text })} /></Field>}
        <p className="note small">{t(assignment.remove ? 'attribute.removeHint' : 'attribute.valuesHint')}</p>{action.error && <ErrorAlert error={action.error} />}
      </div>}
    </Dialog>
    {removing && (
      <ConfirmDialog
        title={t('attribute.deleteNamed', { name: removing.name })}
        confirmLabel={t('common.confirmDelete')}
        onConfirm={() => unwrap(api.DELETE('/user-attributes/{key}', { params: { path: { key: removing.key } } }))}
        onClose={(done) => { setRemoving(undefined); if (done) reload() }}
      >
        {t('attribute.deleteHint', { name: removing.name })}
      </ConfirmDialog>
    )}
  </>
}

export function UserAttributes() {
  const { t } = useTranslation()
  const admin = useSession().atLeast('admin')
  const [definition, setDefinition] = useState<Definition>()
  const loaded = useAsync(async () => {
    const [attributes, directory] = await Promise.all([unwrap(api.GET('/user-attributes')), loadDirectory()])
    return { attributes, directory }
  }, [], { keepData: true })
  return (
    <SettingsPage title={t('attribute.title')} hint={t('attribute.hint')} actions={admin && <Button variant="primary" disabled={loaded.status !== 'ok'} onClick={() => setDefinition({ key: '', name: '', existing: false })}>{t('attribute.add')}</Button>}>
      <KeptAsync state={loaded} reload={loaded.reload}>
        {({ attributes, directory }) => <AttributeManager attributes={attributes} directory={directory} reload={loaded.reload} definition={definition} onDefinitionChange={setDefinition} />}
      </KeptAsync>
    </SettingsPage>
  )
}
