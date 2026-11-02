import { MultiSelect } from '@supabi/ui'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Group, type Subject, type User } from '../api/client'

/** The people a grant or a rule can be for: the org's users and groups. */
export interface Directory {
  users: User[]
  groups: Group[]
}

/** Loads the users and groups to choose from. Developers and admins may list them. */
export async function loadDirectory(): Promise<Directory> {
  const [users, groups] = await Promise.all([unwrap(api.GET('/users')), unwrap(api.GET('/groups'))])
  return { users, groups }
}

/** A subject as one string, so a box of options can hold it. */
export function subjectKey(subject: Subject): string {
  if (subject.everyone) return 'everyone'
  return subject.group ? `group:${subject.group}` : `user:${subject.user}`
}

function subjectOf(key: string): Subject {
  if (key === 'everyone') return { everyone: true }
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  return kind === 'group' ? { group: id } : { user: id }
}

/** Names a subject for reading, as the picker does. */
export function useSubjectName(directory: Directory) {
  const { t } = useTranslation()
  return (subject: Subject) => {
    if (subject.everyone) return t('subject.everyone')
    if (subject.group) return t('subject.group', { name: directory.groups.find((group) => group.id === subject.group)?.name ?? subject.group })
    const user = directory.users.find((item) => item.id === subject.user)
    return user ? `${user.displayName} (${user.email})` : (subject.user ?? '')
  }
}

/** One box for choosing every member, groups and users. */
export function SubjectPicker({ directory, value, onChange, disabled, wrap, 'aria-label': ariaLabel }: { directory: Directory; value: Subject[]; onChange: (value: Subject[]) => void; disabled?: boolean; wrap?: boolean; 'aria-label'?: string }) {
  const { t } = useTranslation()
  const name = useSubjectName(directory)
  const subjects: Subject[] = [
    { everyone: true },
    ...directory.groups.map((group) => ({ group: group.id })),
    ...directory.users.filter((user) => user.status === 'active').map((user) => ({ user: user.id })),
  ]
  return (
    <MultiSelect<string>
      aria-label={ariaLabel}
      placeholder={t('subject.placeholder')}
      disabled={disabled}
      wrap={wrap}
      value={value.map(subjectKey)}
      options={subjects.map((subject) => ({ value: subjectKey(subject), label: name(subject) }))}
      onChange={(keys) => onChange(keys.map(subjectOf))}
    />
  )
}
