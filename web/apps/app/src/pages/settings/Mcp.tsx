import { Alert, Button, DataTable, Input } from '@supabi/ui'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type Schemas } from '../../api/client'
import { useAsync } from '../../api/useAsync'
import { useClipboard } from '../../lib/useClipboard'
import { ConfirmDialog, KeptAsync, SettingsPage, SettingsPart } from './shared'

type Authorization = Schemas['MCPAuthorization']

/** The address to give a client, ready to copy. */
function Address({ address }: { address: string }) {
  const { t } = useTranslation()
  const { status: copied, copy } = useClipboard()
  return (
    <div className="stack">
      <div className="row mcp-address">
        <Input aria-label={t('mcp.address')} value={address} readOnly onChange={() => undefined} />
        <Button onClick={() => void copy(address)}>{t('mcp.copy')}</Button>
      </div>
      <p className="note small" role="status">{copied ? t(copied === 'copied' ? 'mcp.copied' : 'mcp.copyFailed') : t('mcp.addressHint')}</p>
    </div>
  )
}

/**
 * The MCP clients a person has allowed to read their dashboards, which they
 * may revoke, and the address to connect another: .agents/design/ai-assistant.md 14.5.
 */
export function Mcp() {
  const { t, i18n } = useTranslation()
  const state = useAsync(() => unwrap(api.GET('/mcp/authorizations')), [], { keepData: true })
  const [revoking, setRevoking] = useState<Authorization>()
  const time = (value: string) => new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short', hour12: false })

  return (
    <SettingsPage title={t('settings.mcp')} hint={t('mcp.hint')}>
      <KeptAsync state={state} reload={state.reload}>
        {(data) => (
          <>
            {!data.enabled && <Alert tone="warning" title={t('mcp.off')} />}
            <SettingsPart title={t('mcp.address')}>
              <Address address={data.address} />
            </SettingsPart>
            <SettingsPart title={t('mcp.clients')}>
              <DataTable
                aria-label={t('mcp.clients')}
                rows={data.items}
                rowKey={(row) => row.id}
                empty={t('mcp.none')}
                columns={[
                  { key: 'client', title: t('mcp.client'), render: (row) => <span className="settings-clip" title={row.clientName}>{row.clientName}</span> },
                  { key: 'host', title: t('mcp.answeredAt'), width: 160, render: (row) => <span className="settings-clip" title={row.redirectHost}>{row.redirectHost}</span> },
                  { key: 'authorized', title: t('mcp.authorizedAt'), width: 150, render: (row) => <time dateTime={row.authorizedAt}>{time(row.authorizedAt)}</time> },
                  { key: 'used', title: t('mcp.lastUsedAt'), width: 150, render: (row) => <time dateTime={row.lastUsedAt}>{time(row.lastUsedAt)}</time> },
                  { key: 'actions', title: '', width: 72, render: (row) => <Button size="sm" variant="ghost" onClick={() => setRevoking(row)}>{t('mcp.revoke')}</Button> },
                ]}
              />
            </SettingsPart>
          </>
        )}
      </KeptAsync>
      {revoking && (
        <ConfirmDialog
          title={t('mcp.revokeNamed', { name: revoking.clientName })}
          confirmLabel={t('mcp.revoke')}
          onConfirm={() => unwrap(api.DELETE('/mcp/authorizations/{id}', { params: { path: { id: revoking.id } } }))}
          onClose={(done) => { setRevoking(undefined); if (done) state.reload() }}
        >
          {t('mcp.revokeNote')}
        </ConfirmDialog>
      )}
    </SettingsPage>
  )
}
