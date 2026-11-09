import { Button, DataTable, DateInput, Dialog, Field, Input, Markdown, Segmented, Select, Tabs, TextArea, useToast } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { ErrorAlert } from '../../components/ErrorAlert'
import { notificationsChanged } from '../../components/Notifications'
import { ConfirmDialog, KeptAsync, RowMenu, SettingsPage, useAction } from './shared'
import './announcements.css'

// Publishing announcements to the organization or to the current workspace:
// .agents/design/announcements.md 5.

type Announcement = Schemas['Announcement']
type AnnouncementInput = Schemas['AnnouncementInput']
export type AnnouncementScope = 'system' | 'workspace'

const requests = {
  system: {
    list: () => unwrap(api.GET('/system/announcements')),
    create: (body: AnnouncementInput) => unwrap(api.POST('/system/announcements', { body })),
    update: (id: string, body: AnnouncementInput) => unwrap(api.PUT('/system/announcements/{id}', { params: { path: { id } }, body })),
    end: (id: string) => unwrap(api.POST('/system/announcements/{id}/end', { params: { path: { id } } })),
    remove: (id: string) => unwrap(api.DELETE('/system/announcements/{id}', { params: { path: { id } } })),
  },
  workspace: {
    list: () => unwrap(api.GET('/workspace/announcements')),
    create: (body: AnnouncementInput) => unwrap(api.POST('/workspace/announcements', { body })),
    update: (id: string, body: AnnouncementInput) => unwrap(api.PUT('/workspace/announcements/{id}', { params: { path: { id } }, body })),
    end: (id: string) => unwrap(api.POST('/workspace/announcements/{id}/end', { params: { path: { id } } })),
    remove: (id: string) => unwrap(api.DELETE('/workspace/announcements/{id}', { params: { path: { id } } })),
  },
} satisfies Record<AnnouncementScope, unknown>

type State = 'scheduled' | 'active' | 'ended'

function stateOf(a: Announcement, now = Date.now()): State {
  if (now < Date.parse(a.startsAt)) return 'scheduled'
  return now < Date.parse(a.endsAt) ? 'active' : 'ended'
}

const durations = { d1: 1, d3: 3, d7: 7, d30: 30 } as const
type Ends = keyof typeof durations | 'custom'

const pad = (n: number) => String(n).padStart(2, '0')
/** A moment as the browser's day (YYYY-MM-DD) and time (HH:mm). */
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const timeOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
/** The moment a day and a time come to in the browser's time zone, or undefined while either is missing. */
const momentOf = (day: string | undefined, time: string) => (day && /^\d\d:\d\d$/.test(time) ? new Date(`${day}T${time}:00`) : undefined)

/** A day and a time, chosen together. */
function DayAndTime({ day, time, onDay, onTime, label }: { day?: string; time: string; onDay: (day?: string) => void; onTime: (time: string) => void; label: string }) {
  const { t } = useTranslation()
  return (
    <span className="announcement-moment">
      <DateInput value={day} onChange={onDay} clearable={false} aria-label={`${label} · ${t('announcements.date')}`} />
      <Input type="time" value={time} onChange={onTime} aria-label={`${label} · ${t('announcements.time')}`} />
    </span>
  )
}

function AnnouncementDialog({ scope, announcement, onClose }: { scope: AnnouncementScope; announcement?: Announcement; onClose: (saved: boolean) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const action = useAction()
  const [title, setTitle] = useState(announcement?.title ?? '')
  const [body, setBody] = useState(announcement?.body ?? '')
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  // Editing shows the period as saved; a time left alone is sent back as it was.
  const [starts, setStarts] = useState<'now' | 'later'>(announcement ? 'later' : 'now')
  const [startDay, setStartDay] = useState(announcement ? dayOf(new Date(announcement.startsAt)) : dayOf(new Date(Date.now() + 86_400_000)))
  const [startTime, setStartTime] = useState(announcement ? timeOf(new Date(announcement.startsAt)) : '09:00')
  const [startTouched, setStartTouched] = useState(false)
  const [ends, setEnds] = useState<Ends>(announcement ? 'custom' : 'd7')
  const [endDay, setEndDay] = useState(announcement ? dayOf(new Date(announcement.endsAt)) : undefined)
  const [endTime, setEndTime] = useState(announcement ? timeOf(new Date(announcement.endsAt)) : '18:00')
  const [endTouched, setEndTouched] = useState(false)

  const now = Date.now()
  const keptStart = announcement && starts === 'later' && !startTouched
  const start = starts === 'now' ? new Date(now) : keptStart ? new Date(announcement.startsAt) : momentOf(startDay, startTime)
  const keptEnd = announcement && ends === 'custom' && !endTouched
  const end = keptEnd ? new Date(announcement.endsAt) : ends === 'custom' ? momentOf(endDay, endTime) : start && new Date(start.getTime() + durations[ends] * 86_400_000)
  const startError = starts === 'later' && !keptStart && start && start.getTime() <= now ? t('announcements.startPast') : undefined
  const endError = end && start && end <= start ? t('announcements.endBeforeStart') : end && !keptEnd && end.getTime() <= now ? t('announcements.endPast') : undefined
  const valid = Boolean(title.trim() && start && end && !startError && !endError)

  const save = () => void action.run(async () => {
    const input: AnnouncementInput = {
      title: title.trim(),
      body,
      startsAt: starts === 'now' ? undefined : keptStart ? announcement.startsAt : start!.toISOString(),
      endsAt: keptEnd ? announcement.endsAt : end!.toISOString(),
    }
    if (announcement) await requests[scope].update(announcement.id, input)
    else await requests[scope].create(input)
    notificationsChanged()
    toast(t(announcement ? 'announcements.saved' : 'announcements.published'))
  }, () => onClose(true))

  return (
    <Dialog
      open
      width={640}
      title={announcement ? t('announcements.edit') : t('announcements.add')}
      onClose={() => !action.busy && onClose(false)}
      actions={<>
        <Button disabled={action.busy} onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={action.busy} disabled={!valid} onClick={save}>{announcement ? t('common.save') : t('announcements.add')}</Button>
      </>}
    >
      <form className="stack announcement-form" onSubmit={(event) => { event.preventDefault(); if (valid) save() }}>
        <Field label={t('announcements.fields.title')} htmlFor="announcement-title" required>
          <Input id="announcement-title" value={title} onChange={(value) => setTitle(value.replace(/[\r\n]+/g, ' '))} maxLength={120} />
        </Field>
        <Field label={t('announcements.fields.body')} htmlFor="announcement-body" hint={t('announcements.bodyHint')}>
          <div className="announcement-body">
            <Tabs value={tab} onChange={setTab} aria-label={t('announcements.fields.body')} items={[{ value: 'write', label: t('announcements.write') }, { value: 'preview', label: t('announcements.preview') }]} />
            {tab === 'write'
              ? <TextArea id="announcement-body" value={body} onChange={setBody} rows={8} maxLength={10_000} />
              : <div className="announcement-preview">{body.trim() ? <Markdown text={body} /> : <p className="note">{t('announcements.previewEmpty')}</p>}</div>}
          </div>
        </Field>
        <Field label={t('announcements.fields.starts')}>
          <div className="announcement-when">
            <Segmented
              value={starts}
              onChange={(value) => { setStarts(value); setStartTouched(true) }}
              aria-label={t('announcements.fields.starts')}
              options={[{ value: 'now', label: t('announcements.now') }, { value: 'later', label: t('announcements.later') }]}
            />
            {starts === 'later' && (
              <DayAndTime label={t('announcements.fields.starts')} day={startDay} time={startTime}
                onDay={(day) => { setStartDay(day ?? startDay); setStartTouched(true) }} onTime={(time) => { setStartTime(time); setStartTouched(true) }} />
            )}
          </div>
          {startError && <span className="note danger">{startError}</span>}
        </Field>
        <Field label={t('announcements.fields.ends')}>
          <div className="announcement-when">
            <Select
              value={ends}
              onChange={(value) => {
                setEnds(value)
                setEndTouched(true)
                // Custom starts from where the chosen length ended.
                if (value === 'custom' && !endDay && end) { setEndDay(dayOf(end)); setEndTime(timeOf(end)) }
              }}
              aria-label={t('announcements.fields.ends')}
              options={(['d1', 'd3', 'd7', 'd30', 'custom'] as const).map((value) => ({ value, label: t(`announcements.durations.${value}`) }))}
            />
            {ends === 'custom'
              ? <DayAndTime label={t('announcements.fields.ends')} day={endDay} time={endTime}
                  onDay={(day) => { setEndDay(day); setEndTouched(true) }} onTime={(time) => { setEndTime(time); setEndTouched(true) }} />
              : end && <span className="note">{t('announcements.endsAt', { time: end.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
          </div>
          {endError && <span className="note danger">{endError}</span>}
          <span className="note">{t('announcements.timeZone')}</span>
        </Field>
        {action.error && <ErrorAlert error={action.error} />}
      </form>
    </Dialog>
  )
}

/** The announcements of the organization or of the current workspace, the latest start first. */
export function Announcements({ scope }: { scope: AnnouncementScope }) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const list = useAsync(() => requests[scope].list(), [scope], { keepData: true })
  const [editing, setEditing] = useState<Announcement | 'new'>()
  const [deleting, setDeleting] = useState<Announcement>()
  const ending = useAction()
  const when = (value: string) => new Date(value).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })
  const changed = () => { list.reload(); notificationsChanged() }

  return (
    <SettingsPage
      title={t('settings.announcements')}
      hint={t(scope === 'system' ? 'announcements.systemHint' : 'announcements.workspaceHint')}
      actions={<Button variant="primary" onClick={() => setEditing('new')}>{t('announcements.add')}</Button>}
    >
      {ending.error && <ErrorAlert error={ending.error} />}
      <KeptAsync state={list} reload={list.reload}>
        {(rows) => (
          <DataTable
            aria-label={t('settings.announcements')}
            rows={rows}
            rowKey={(row) => row.id}
            empty={t('announcements.empty')}
            pageSize={20}
            columns={[
              { key: 'title', title: t('announcements.columns.title'), render: (row) => <span className="settings-clip" title={row.title}>{row.title}</span> },
              { key: 'state', title: t('announcements.columns.state'), width: 104, render: (row) => { const state = stateOf(row); return <span className={`status-mark ${state}`}>{t(`announcements.state.${state}`)}</span> } },
              { key: 'period', title: t('announcements.columns.period'), width: 260, render: (row) => <span className="note">{when(row.startsAt)} – {when(row.endsAt)}</span> },
              { key: 'author', title: t('announcements.columns.author'), width: 140, render: (row) => <span className="settings-clip" title={row.createdBy}>{row.createdBy}</span> },
              {
                key: 'actions',
                title: '',
                width: 96,
                render: (row) => (
                  <span className="row nowrap announcement-row-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>{t('common.edit')}</Button>
                    <RowMenu label={t('settings.actionsOf', { name: row.title })} items={[
                      ...(stateOf(row) === 'active' ? [{
                        key: 'end',
                        label: t('announcements.endNow'),
                        onSelect: () => void ending.run(() => requests[scope].end(row.id), () => { changed(); toast(t('announcements.ended')) }),
                      }] : []),
                      { key: 'delete', label: t('common.delete'), danger: true, separated: stateOf(row) === 'active', onSelect: () => setDeleting(row) },
                    ]} />
                  </span>
                ),
              },
            ]}
          />
        )}
      </KeptAsync>
      {editing && (
        <AnnouncementDialog
          key={editing === 'new' ? 'new' : editing.id}
          scope={scope}
          announcement={editing === 'new' ? undefined : editing}
          onClose={(saved) => { setEditing(undefined); if (saved) list.reload() }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('announcements.deleteNamed', { name: deleting.title })}
          confirmLabel={t('common.confirmDelete')}
          onConfirm={() => requests[scope].remove(deleting.id)}
          onClose={(done) => { setDeleting(undefined); if (done) changed() }}
        >
          {t('announcements.deleteNote')}
        </ConfirmDialog>
      )}
    </SettingsPage>
  )
}
