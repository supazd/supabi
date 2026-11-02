import { Button, DataTable, Dialog, Field, MultiSelect, Select, Tabs, type MenuItem } from '@supabi/ui'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Group, type GroupMember, type Member, type User } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { roles, useSession, type Role } from '../../auth/session'
import { ErrorAlert } from '../../components/ErrorAlert'
import { FieldLabel } from '../../components/FieldLabel'
import { Icon } from '../../components/Icon'
import { ConfirmDialog, found, KeptAsync, Person, RowMenu, SearchBox, SettingsPage, useAction, useRoleOptions } from './shared'

/** Adds existing global users or groups to this workspace, all with the same role. */
function AddDialog({ title, label, candidates, onAdd, onClose }: { title: string; label: string; candidates: { id: string; name: string }[]; onAdd: (id: string, role: Role) => Promise<unknown>; onClose: (added: boolean) => void }) {
  const { t } = useTranslation()
  const roleOptions = useRoleOptions()
  const [ids, setIds] = useState<string[]>([])
  const [role, setRole] = useState<Role>('viewer')
  // Each is added on its own: when one fails, those before it are in already.
  const added = useRef(0)
  const action = useAction()
  const add = () => void action.run(async () => {
    for (const id of ids) {
      await onAdd(id, role)
      added.current++
      setIds((left) => left.filter((other) => other !== id))
    }
  }, () => onClose(true))
  return (
    <Dialog
      open
      width={520}
      title={title}
      onClose={() => !action.busy && onClose(added.current > 0)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(added.current > 0)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={ids.length === 0} onClick={add}>{t('member.add')}</Button>
      </>}
    >
      <div className="stack">
        {candidates.length === 0 ? <p className="note">{t('member.noCandidates')}</p> : (
          <Field label={label} htmlFor="member-add-ids">
            <MultiSelect<string> id="member-add-ids" aria-label={label} value={ids} options={candidates.map((item) => ({ value: item.id, label: item.name }))} onChange={setIds} />
          </Field>
        )}
        <Field label={t('member.role')} htmlFor="member-add-role" hint={t(`member.roleHints.${role}`)}>
          <Select<Role> id="member-add-role" aria-label={t('member.role')} block value={role} options={roleOptions} onChange={setRole} />
        </Field>
        {action.error && <ErrorAlert error={action.error} />}
      </div>
    </Dialog>
  )
}

/** A choice in a menu, checked when it is the one in force. */
function Choice({ label, chosen }: { label: string; chosen: boolean }) {
  return <span className="settings-menu-choice">{label}{chosen && <Icon name="check" />}</span>
}

interface Access {
  users: User[]
  groups: Group[]
  members: Member[]
  grants: GroupMember[]
}

type Tab = 'users' | 'groups'

/** Someone with access to the workspace: given it directly, through groups, or as a system administrator. */
type Row = User & { direct?: Member; inherited: GroupMember[]; role: Role }

function AccessManager({ users, groups, members, grants, reload, tab, onTabChange }: Access & { reload: () => void; tab: Tab; onTabChange: (tab: Tab) => void }) {
  const { t } = useTranslation()
  const session = useSession()
  const me = session.state.status === 'ok' ? session.state.data.user?.id : undefined
  const roleOptions = useRoleOptions()
  const action = useAction()
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<{ user: Row } | { grant: GroupMember }>()
  const roleName = (role: Role) => t(`member.roles.${role}`)
  const roleHints = roles.map((role) => `${roleName(role)} · ${t(`member.roleHints.${role}`)}`)
  const rows = users.flatMap((user): Row[] => {
    const direct = members.find((member) => member.userId === user.id)
    const inherited = grants.filter((grant) => groups.some((group) => group.id === grant.groupId && group.userIds.includes(user.id)))
    if (!direct && !inherited.length && !user.isOrgAdmin) return []
    const rank = Math.max(direct ? roles.indexOf(direct.role) : -1, ...inherited.map((grant) => roles.indexOf(grant.role)))
    const role = user.isOrgAdmin ? 'admin' : roles[rank]!
    return [{ ...user, direct, inherited, role }]
  })
  const done = (added: boolean) => { setAdding(false); if (added) reload() }
  // Giving someone who is in through a group a role of their own adds them; changing it keeps them.
  const setDirectRole = (row: Row, role: Role) => {
    if (row.direct?.role === role) return
    void action.run(
      () => row.direct
        ? unwrap(api.PATCH('/members/{userId}', { params: { path: { userId: row.id } }, body: { role } }))
        : unwrap(api.POST('/members', { body: { userId: row.id, role } })),
      reload,
    )
  }
  const rowMenu = (row: Row): MenuItem[] => [
    {
      key: 'role',
      label: t(row.direct ? 'member.directRole' : 'member.addDirect'),
      children: roles.map((role) => ({ key: role, label: <Choice label={roleName(role)} chosen={row.direct?.role === role} />, onSelect: () => setDirectRole(row, role) })),
    },
    ...(row.direct ? [{ key: 'remove', label: t('member.removeDirect'), danger: true, separated: true, onSelect: () => setRemoving({ user: row }) }] : []),
  ]

  return <>
    <Tabs value={tab} onChange={onTabChange} aria-label={t('member.title')} items={[{ value: 'users', label: t('member.users') }, { value: 'groups', label: t('member.groups') }]} />
    {action.error && <ErrorAlert error={action.error} />}
    {tab === 'users' ? <>
      <div className="settings-toolbar spread">
        <SearchBox value={search} onChange={setSearch} />
        <Button variant="primary" onClick={() => setAdding(true)}>{t('member.addUsers')}</Button>
      </div>
      <DataTable aria-label={t('member.users')} rows={rows.filter((row) => found(search, row.displayName, row.email))} rowKey={(row) => row.id} pageSize={20} empty={t('common.none')} columns={[
        { key: 'user', title: t('member.users'), render: (row) => <Person name={row.displayName} email={row.email} marks={<>
          {row.status === 'disabled' && <span className="chip warning">{t('member.statuses.disabled')}</span>}
          {row.id === me && <span className="note small">{t('member.you')}</span>}
        </>} /> },
        { key: 'role', title: <FieldLabel label={t('member.role')} hint={roleHints} />, width: 120, render: (row) => roleName(row.role) },
        { key: 'source', title: t('member.source'), render: (row) => {
          const sources = [
            row.isOrgAdmin && t('user.orgAdmin'),
            row.direct && t('member.sourceDirect', { role: roleName(row.direct.role) }),
            ...row.inherited.map((grant) => t('member.sourceGroup', { name: grant.name, role: roleName(grant.role) })),
          ].filter(Boolean).join(' · ')
          return <span className="settings-clip note" title={sources}>{sources}</span>
        } },
        // One's own role and a system administrator's are not changed here.
        { key: 'actions', title: '', width: 48, render: (row) => row.id === me || row.isOrgAdmin ? null : <RowMenu label={t('settings.actionsOf', { name: row.displayName })} items={rowMenu(row)} /> },
      ]} />
      {adding && <AddDialog
        title={t('member.addUsers')}
        label={t('member.users')}
        candidates={users.filter((user) => user.status === 'active' && !user.isOrgAdmin && !members.some((member) => member.userId === user.id)).map((user) => ({ id: user.id, name: `${user.displayName} (${user.email})` }))}
        onAdd={(userId, role) => unwrap(api.POST('/members', { body: { userId, role } }))}
        onClose={done}
      />}
    </> : <>
      <div className="settings-toolbar spread">
        <p className="note">{t('member.groupsHint')}</p>
        <Button variant="primary" onClick={() => setAdding(true)}>{t('member.addGroups')}</Button>
      </div>
      <DataTable aria-label={t('member.groups')} rows={grants} rowKey={(row) => row.groupId} empty={t('common.none')} columns={[
        { key: 'name', title: t('common.name'), render: (row) => {
          const group = groups.find((g) => g.id === row.groupId)
          return <span className="settings-person"><span>{row.name}</span>{group && <span className="note">{t('group.count', { count: group.userIds.length })}</span>}</span>
        } },
        { key: 'role', title: <FieldLabel label={t('member.role')} hint={roleHints} />, width: 180, render: (row) => <Select size="sm" block aria-label={`${t('member.role')} ${row.name}`} disabled={action.busy} value={row.role} options={roleOptions} onChange={(role) => void action.run(() => unwrap(api.PUT('/group-members/{groupId}', { params: { path: { groupId: row.groupId } }, body: { role } })), reload)} /> },
        { key: 'actions', title: '', width: 48, render: (row) => <RowMenu label={t('settings.actionsOf', { name: row.name })} items={[{ key: 'remove', label: t('member.remove'), danger: true, onSelect: () => setRemoving({ grant: row }) }]} /> },
      ]} />
      {adding && <AddDialog
        title={t('member.addGroups')}
        label={t('settings.groups')}
        candidates={groups.filter((group) => !grants.some((grant) => grant.groupId === group.id)).map((group) => ({ id: group.id, name: group.name }))}
        onAdd={(groupId, role) => unwrap(api.PUT('/group-members/{groupId}', { params: { path: { groupId } }, body: { role } }))}
        onClose={done}
      />}
    </>}
    {removing && ('user' in removing ? (
      <ConfirmDialog
        title={t('member.removeDirectNamed', { name: removing.user.displayName })}
        confirmLabel={t('member.removeDirect')}
        onConfirm={() => unwrap(api.DELETE('/members/{userId}', { params: { path: { userId: removing.user.id } } }))}
        onClose={(removed) => { setRemoving(undefined); if (removed) reload() }}
      >
        {removing.user.inherited.length
          ? t('member.removeDirectKeeps', { name: removing.user.displayName, groups: removing.user.inherited.map((grant) => grant.name).join('、') })
          : t('member.removeDirectNote', { name: removing.user.displayName })}
      </ConfirmDialog>
    ) : (
      <ConfirmDialog
        title={t('member.removeGroupNamed', { name: removing.grant.name })}
        confirmLabel={t('member.remove')}
        onConfirm={() => unwrap(api.DELETE('/group-members/{groupId}', { params: { path: { groupId: removing.grant.groupId } } }))}
        onClose={(removed) => { setRemoving(undefined); if (removed) reload() }}
      >
        {t('member.removeGroupNote', { name: removing.grant.name })}
      </ConfirmDialog>
    ))}
  </>
}

export function Members() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('users')
  const access = useAsync(async () => {
    const [users, groups, members, grants] = await Promise.all([
      unwrap(api.GET('/users')), unwrap(api.GET('/groups')), unwrap(api.GET('/members')), unwrap(api.GET('/group-members')),
    ])
    return { users, groups, members, grants }
  }, [], { keepData: true })
  return (
    <SettingsPage title={t('member.title')} hint={t('member.hint')}>
      <KeptAsync state={access} reload={access.reload}>{(data) => <AccessManager {...data} reload={access.reload} tab={tab} onTabChange={setTab} />}</KeptAsync>
    </SettingsPage>
  )
}
