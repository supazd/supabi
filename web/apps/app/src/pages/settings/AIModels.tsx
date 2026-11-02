import { Alert, Button, Checkbox, DataTable, Dialog, Field, Input, Select } from '@supabi/ui'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, unwrap, type ApiError, type Schemas } from '../../api/client'
import { toApiError, useAsync } from '../../api/useAsync'
import { Async } from '../../components/Async'
import { ErrorAlert, useErrorText } from '../../components/ErrorAlert'
import { currencyOptions } from '../../lib/currencies'
import { formatTokenCount, parseTokenCount } from '../../lib/tokenCounts'
import { ConfirmDialog, RowMenu, SettingsPage, SettingsPart, useAction } from './shared'
import './aiModels.css'

type AIConfig = Schemas['AIConfig']
type AIProvider = Schemas['AIProvider']
type AIModel = Schemas['AIModel']
type AISettings = Schemas['AISettings']
type AIModelTrial = Schemas['AIModelTrial']

/**
 * The models the assistant calls, and which one it uses for what. Only
 * system administrators set them; people never choose a model themselves.
 * See .agents/design/ai-assistant.md 3.
 */
export function AIModels() {
  const { t } = useTranslation()
  const config = useAsync(() => unwrap(api.GET('/ai/config')), [], { keepData: true })
  const [editingProvider, setEditingProvider] = useState<AIProvider | 'new'>()
  const [editingModel, setEditingModel] = useState<{ provider: AIProvider; model?: AIModel }>()

  return (
    <SettingsPage title={t('settings.ai')}>
      <SettingsPart title={t('ai.purposesTitle')} hint={t('ai.purposesHint')}>
        <Async state={config} reload={config.reload}>
          {(c) => <Purposes config={c} onSaved={config.reload} />}
        </Async>
      </SettingsPart>

      <SettingsPart title={t('ai.providersTitle')} hint={t('ai.providersHint')} actions={<Button variant="primary" onClick={() => setEditingProvider('new')}>{t('ai.addProvider')}</Button>}>
        <Async state={config} reload={config.reload}>
          {(c) =>
            c.providers.length === 0 ? (
              <p className="note">{t('ai.noProviders')}</p>
            ) : (
              c.providers.map((provider) => (
                <Provider
                  key={provider.id}
                  provider={provider}
                  models={c.models.filter((m) => m.providerId === provider.id)}
                  onEdit={() => setEditingProvider(provider)}
                  onAddModel={() => setEditingModel({ provider })}
                  onEditModel={(model) => setEditingModel({ provider, model })}
                  onChanged={config.reload}
                />
              ))
            )
          }
        </Async>
      </SettingsPart>

      {editingProvider && (
        <ProviderDialog
          provider={editingProvider === 'new' ? undefined : editingProvider}
          onClose={(saved) => {
            setEditingProvider(undefined)
            if (saved) config.reload()
          }}
        />
      )}
      {editingModel && (
        <ModelDialog
          provider={editingModel.provider}
          model={editingModel.model}
          onClose={(saved) => {
            setEditingModel(undefined)
            if (saved) config.reload()
          }}
        />
      )}
    </SettingsPage>
  )
}

/** Which model is used for what. A change is saved at once. */
function Purposes({ config, onSaved }: { config: AIConfig; onSaved: () => void }) {
  const { t } = useTranslation()
  const action = useAction()
  const providerName = (id: string) => config.providers.find((p) => p.id === id)?.name ?? ''
  const models = config.models.map((m) => ({ value: m.id, label: `${m.model} · ${providerName(m.providerId)}` }))
  const set = (key: keyof AISettings, value: string) =>
    void action.run(() => unwrap(api.PUT('/ai/settings', { body: { ...config.settings, [key]: value || undefined } })), onSaved)
  const purposes: { key: keyof AISettings; unset: string }[] = [
    { key: 'chatModelId', unset: t('ai.unset') },
    { key: 'titleModelId', unset: t('ai.sameAsChat') },
    { key: 'compressionModelId', unset: t('ai.sameAsChat') },
  ]
  return (
    <>
      {config.models.length === 0 && <p className="note">{t('ai.addModelsFirst')}</p>}
      <div className="form-grid ai-purposes">
        {purposes.map(({ key, unset }) => (
          <Field key={key} label={t(`ai.purposes.${key}`)} htmlFor={`ai-${key}`} hint={t(`ai.purposes.${key}Hint`)}>
            <Select id={`ai-${key}`} value={config.settings[key] ?? ''} options={[{ value: '', label: unset }, ...models]} disabled={action.busy} onChange={(value) => set(key, value)} />
          </Field>
        ))}
      </div>
      {action.error && <ErrorAlert error={action.error} />}
    </>
  )
}

interface ProviderProps {
  provider: AIProvider
  models: AIModel[]
  onEdit: () => void
  onAddModel: () => void
  onEditModel: (model: AIModel) => void
  onChanged: () => void
}

function Provider({ provider, models, onEdit, onAddModel, onEditModel, onChanged }: ProviderProps) {
  const { t } = useTranslation()
  const [trial, setTrial] = useState<{ model: AIModel; result?: AIModelTrial; error?: ApiError }>()
  const [deleting, setDeleting] = useState<{ model?: AIModel }>()
  const test = (model: AIModel) => {
    setTrial({ model })
    unwrap(api.POST('/ai/models/{id}/test', { params: { path: { id: model.id } } })).then(
      (result) => setTrial({ model, result }),
      (error: unknown) => setTrial({ model, error: toApiError(error) }),
    )
  }
  const testing = Boolean(trial && !trial.result && !trial.error)
  return (
    <div className="ai-provider stack">
      <div className="row spread">
        <div className="ai-provider-name">
          <strong>{provider.name}</strong>
          <span className="note small">
            {t(`ai.protocols.${provider.protocol}`)} · {provider.baseUrl} · {provider.hasApiKey ? t('ai.keySet') : t('ai.keyUnset')}
          </span>
        </div>
        <span className="row nowrap">
          <Button size="sm" variant="ghost" aria-label={t('ai.addModelTo', { name: provider.name })} onClick={onAddModel}>
            {t('ai.addModel')}
          </Button>
          <RowMenu label={t('settings.actionsOf', { name: provider.name })} items={[
            { key: 'edit', label: t('common.edit'), onSelect: onEdit },
            { key: 'delete', label: t('common.delete'), danger: true, separated: true, onSelect: () => setDeleting({}) },
          ]} />
        </span>
      </div>
      <DataTable
        aria-label={t('ai.modelsOf', { name: provider.name })}
        rows={models}
        rowKey={(row) => row.id}
        empty={t('ai.noModels')}
        columns={[
          { key: 'model', title: t('ai.model'), render: (row) => <code>{row.model}</code> },
          { key: 'context', title: t('ai.contextTokens'), width: 120, render: (row) => formatTokenCount(row.contextTokens) },
          { key: 'output', title: t('ai.maxOutputTokens'), width: 120, render: (row) => formatTokenCount(row.maxOutputTokens) },
          {
            key: 'prices',
            title: t('ai.prices'),
            render: (row) => (
              <span className="nowrap">
                {[row.inputPrice, row.cachedInputPrice ?? '—', row.cacheWritePrice ?? '—', row.outputPrice].join(' / ')} {row.currency}
              </span>
            ),
          },
          {
            key: 'actions',
            title: '',
            width: 104,
            render: (row) => (
              <span className="row nowrap">
                <Button size="sm" variant="ghost" aria-label={t('ai.testNamed', { name: row.model })} loading={testing && trial?.model.id === row.id} disabled={testing} onClick={() => test(row)}>
                  {t('ai.test')}
                </Button>
                <RowMenu label={t('settings.actionsOf', { name: row.model })} items={[
                  { key: 'edit', label: t('common.edit'), onSelect: () => onEditModel(row) },
                  { key: 'delete', label: t('common.delete'), danger: true, separated: true, onSelect: () => setDeleting({ model: row }) },
                ]} />
              </span>
            ),
          },
        ]}
      />
      {trial && <TrialResult model={trial.model} result={trial.result} error={trial.error} />}
      {deleting && (
        <ConfirmDialog
          title={deleting.model ? t('ai.deleteModelNamed', { name: deleting.model.model }) : t('ai.deleteProviderNamed', { name: provider.name })}
          confirmLabel={t('common.confirmDelete')}
          onConfirm={() => deleting.model
            ? unwrap(api.DELETE('/ai/models/{id}', { params: { path: { id: deleting.model.id } } }))
            : unwrap(api.DELETE('/ai/providers/{id}', { params: { path: { id: provider.id } } }))}
          onClose={(done) => { setDeleting(undefined); if (done) onChanged() }}
        >
          {deleting.model ? t('ai.deleteModelNote') : t('ai.deleteProviderNote', { count: models.length })}
        </ConfirmDialog>
      )}
    </div>
  )
}

function TrialResult({ model, result, error }: { model: AIModel; result?: AIModelTrial; error?: ApiError }) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  if (error) return <Alert tone="error" title={errorText(error)} />
  if (!result) return null
  if (result.ok) {
    // The assistant looks data up through tools: a model that does not call them can only chat.
    const tools = result.tools
    return (
      <Alert tone={tools && !tools.called ? 'warning' : 'success'} title={t('ai.trialOk', { model: model.model, ms: result.durationMs, reply: result.reply || '—' })}>
        {tools && <span className="ai-trial-message">{tools.called ? t('ai.toolsOk') : tools.error ? t('ai.toolsFailed', { message: tools.error.message }) : t('ai.toolsNotCalled')}</span>}
      </Alert>
    )
  }
  const failure = result.error!
  const reason = i18n.exists(`assistant.errors.${failure.code}`) ? t(`assistant.errors.${failure.code}`) : failure.code
  return (
    <Alert tone="error" title={t('ai.trialFailed', { model: model.model, reason, status: failure.status ? ` (HTTP ${failure.status})` : '' })}>
      <span className="ai-trial-message">{failure.message}</span>
    </Alert>
  )
}

function ProviderDialog({ provider, onClose }: { provider?: AIProvider; onClose: (saved: boolean) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const action = useAction()
  const save = () => {
    // A key is sent only when it changes.
    const body = { name, protocol: 'openai' as const, baseUrl, ...(apiKey ? { apiKey } : clearKey ? { apiKey: '' } : {}) }
    void action.run(
      () => (provider ? unwrap(api.PATCH('/ai/providers/{id}', { params: { path: { id: provider.id } }, body })) : unwrap(api.POST('/ai/providers', { body }))),
      () => onClose(true),
    )
  }
  return (
    <Dialog
      open
      width={520}
      title={provider ? t('ai.editProvider') : t('ai.addProvider')}
      onClose={() => onClose(false)}
      actions={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={action.busy} disabled={!name.trim() || !baseUrl.trim()} onClick={save}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('common.name')} htmlFor="ai-provider-name" required>
          <Input id="ai-provider-name" value={name} maxLength={100} placeholder={t('ai.providerNamePlaceholder')} onChange={setName} />
        </Field>
        <Field label={t('ai.protocol')} htmlFor="ai-provider-protocol">
          <Select id="ai-provider-protocol" value="openai" options={[{ value: 'openai', label: t('ai.protocols.openai') }]} onChange={() => {}} />
        </Field>
        <Field label={t('ai.baseUrl')} htmlFor="ai-provider-url" required hint={t('ai.baseUrlHint')}>
          <Input id="ai-provider-url" value={baseUrl} placeholder="https://api.openai.com/v1" onChange={setBaseUrl} />
        </Field>
        <Field label={t('ai.apiKey')} htmlFor="ai-provider-key" hint={provider?.hasApiKey ? t('ai.apiKeyKept') : undefined}>
          <Input id="ai-provider-key" type="password" value={apiKey} disabled={clearKey} placeholder={provider?.hasApiKey ? t('ai.keySet') : ''} onChange={setApiKey} />
        </Field>
        {provider?.hasApiKey && (
          <Checkbox checked={clearKey} onChange={(checked) => { setClearKey(checked); if (checked) setApiKey('') }}>
            {t('ai.clearKey')}
          </Checkbox>
        )}
        {action.error && <ErrorAlert error={action.error} />}
      </div>
    </Dialog>
  )
}

function ModelDialog({ provider, model, onClose }: { provider: AIProvider; model?: AIModel; onClose: (saved: boolean) => void }) {
  const { t, i18n } = useTranslation()
  const [name, setName] = useState(model?.model ?? '')
  // Written as providers write them, 128K or 1M.
  const [contextTokens, setContextTokens] = useState(model ? formatTokenCount(model.contextTokens) : '')
  const [maxOutputTokens, setMaxOutputTokens] = useState(model ? formatTokenCount(model.maxOutputTokens) : '')
  const [currency, setCurrency] = useState(model?.currency ?? 'CNY')
  const currencies = useMemo(() => currencyOptions(i18n.language, model?.currency), [i18n.language, model?.currency])
  const [inputPrice, setInputPrice] = useState(model?.inputPrice ?? '')
  const [cachedInputPrice, setCachedInputPrice] = useState(model?.cachedInputPrice ?? '')
  const [cacheWritePrice, setCacheWritePrice] = useState(model?.cacheWritePrice ?? '')
  const [outputPrice, setOutputPrice] = useState(model?.outputPrice ?? '')
  const [thinkingLevel, setThinkingLevel] = useState(model?.thinkingLevel ?? '')
  const action = useAction()
  const save = () => {
    const body = {
      model: name,
      contextTokens: parseTokenCount(contextTokens)!,
      maxOutputTokens: parseTokenCount(maxOutputTokens)!,
      currency,
      inputPrice: inputPrice.trim(),
      outputPrice: outputPrice.trim(),
      // Left out, such tokens are charged as other input.
      cachedInputPrice: cachedInputPrice.trim() || undefined,
      cacheWritePrice: cacheWritePrice.trim() || undefined,
      // Left out, the provider decides.
      thinkingLevel: thinkingLevel.trim() || undefined,
    }
    void action.run(
      () =>
        model
          ? unwrap(api.PATCH('/ai/models/{id}', { params: { path: { id: model.id } }, body }))
          : unwrap(api.POST('/ai/providers/{id}/models', { params: { path: { id: provider.id } }, body })),
      () => onClose(true),
    )
  }
  const contextInvalid = contextTokens.trim() !== '' && parseTokenCount(contextTokens) === undefined
  const outputInvalid = maxOutputTokens.trim() !== '' && parseTokenCount(maxOutputTokens) === undefined
  const ready = name.trim() && parseTokenCount(contextTokens) && parseTokenCount(maxOutputTokens) && inputPrice.trim() && outputPrice.trim()
  return (
    <Dialog
      open
      width={600}
      title={model ? t('ai.editModel') : t('ai.addModelTo', { name: provider.name })}
      onClose={() => onClose(false)}
      actions={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={action.busy} disabled={!ready} onClick={save}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('ai.model')} htmlFor="ai-model-name" required>
          <Input id="ai-model-name" value={name} placeholder={t('ai.modelPlaceholder')} onChange={setName} />
        </Field>
        <div className="form-grid">
          <Field label={t('ai.contextTokens')} htmlFor="ai-model-context" required hint={t('ai.contextTokensHint')}>
            <Input id="ai-model-context" value={contextTokens} placeholder="128K" invalid={contextInvalid} onChange={setContextTokens} />
          </Field>
          <Field label={t('ai.maxOutputTokens')} htmlFor="ai-model-output" required hint={t('ai.maxOutputTokensHint')}>
            <Input id="ai-model-output" value={maxOutputTokens} placeholder="8K" invalid={outputInvalid} onChange={setMaxOutputTokens} />
          </Field>
        </div>
        <p className="note">{t('ai.tokenUnits')}</p>
        <Field label={t('ai.thinkingLevel')} htmlFor="ai-model-thinking" hint={t('ai.thinkingLevelHint')}>
          <Input id="ai-model-thinking" value={thinkingLevel} maxLength={32} onChange={setThinkingLevel} />
        </Field>
        <Field label={t('ai.currency')} htmlFor="ai-model-currency" required hint={t('ai.currencyHint')}>
          <Select id="ai-model-currency" aria-label={t('ai.currency')} value={currency} options={currencies} search searchBy="label" onChange={setCurrency} />
        </Field>
        <p className="note">{t('ai.pricesHint')}</p>
        <div className="form-grid">
          <Field label={t('ai.inputPrice')} htmlFor="ai-model-input-price" required>
            <Input id="ai-model-input-price" value={inputPrice} placeholder="2" onChange={setInputPrice} />
          </Field>
          <Field label={t('ai.outputPrice')} htmlFor="ai-model-output-price" required>
            <Input id="ai-model-output-price" value={outputPrice} placeholder="8" onChange={setOutputPrice} />
          </Field>
          <Field label={t('ai.cachedInputPrice')} htmlFor="ai-model-cached-price" hint={t('ai.optionalPriceHint')}>
            <Input id="ai-model-cached-price" value={cachedInputPrice} onChange={setCachedInputPrice} />
          </Field>
          <Field label={t('ai.cacheWritePrice')} htmlFor="ai-model-write-price" hint={t('ai.optionalPriceHint')}>
            <Input id="ai-model-write-price" value={cacheWritePrice} onChange={setCacheWritePrice} />
          </Field>
        </div>
        {action.error && <ErrorAlert error={action.error} />}
      </div>
    </Dialog>
  )
}
