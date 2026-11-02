import { hueColor, hues } from '@supabi/charts'
import { Button, Checkbox, Field, Input, Popover, Segmented, Tooltip, type ColorScheme } from '@supabi/ui'
import { useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import { useTranslation } from 'react-i18next'
import { backgroundIn, isHexColor, paddings, swatchOf, type Background, type Frame } from '../lib/frame'
import { Icon } from './Icon'

/**
 * How a widget's box looks: its background in each scheme, how far that lets
 * through what is behind it, its border and padding, given and changed as the
 * frame it is drawn with. The background is set for the light or the dark
 * scheme, chosen above the swatches, which show their colours as that scheme
 * has them; the dark one follows the light one until it is given one of its
 * own. What is picked in the colour panel or dragged on the transparency
 * slider is shown at once: `live` is set for each step of it, and `onPicked`
 * called when it is let go, so that it can be one step to undo.
 */
export function FrameSettings({ frame, scheme, onChange, onPicked, id }: {
  frame: Frame
  scheme: ColorScheme
  onChange: (frame: Frame, live?: boolean) => void
  onPicked?: () => void
  /** Tells apart the fields of several of these on one page. */
  id: string
}) {
  const { t } = useTranslation()
  // Which scheme's background is being set: the one being looked at, to begin with.
  const [mode, setMode] = useState<ColorScheme>(scheme)
  const shown = backgroundIn(frame, mode)
  const set = (background: Background | undefined, live?: boolean) => onChange(mode === 'light' ? { ...frame, background } : { ...frame, backgroundDark: background ?? 'default' }, live)
  const choices = [
    { value: undefined, label: t('dashboard.frame.backgroundDefault'), className: 'swatch swatch-default', color: swatchOf('default', mode) },
    { value: 'neutral' as const, label: t('dashboard.frame.backgroundNeutral'), className: 'swatch', color: swatchOf('neutral', mode) },
    ...hues.map((hue) => ({ value: hue, label: t(`chartStyle.hues.${hue}`), className: 'swatch', color: swatchOf(hue, mode) })),
  ]
  return <>
    <div className="field frame-background"><span className="note small">{t('dashboard.frame.background')}</span>
      <Segmented block aria-label={t('dashboard.frame.scheme')} value={mode} onChange={setMode} options={(['light', 'dark'] as const).map((value) => ({ value, label: (
        // What each theme has chosen, in the colour its swatch shows.
        <span className="frame-mode"><span className="frame-mode-dot" style={{ background: swatchOf(backgroundIn(frame, value) ?? 'default', value) }} />{t(`dashboard.frame.${value}`)}</span>
      ) }))} />
      <div className="swatches" role="radiogroup" aria-label={t('dashboard.frame.backgroundIn', { scheme: t(`dashboard.frame.${mode}`) })}>
        {choices.map((choice) => (
          <Tooltip key={choice.value ?? 'default'} title={choice.label}>
            <button type="button" role="radio" className={choice.className} aria-checked={shown === choice.value} aria-label={choice.label} style={{ background: choice.color }} onClick={() => set(choice.value)} />
          </Tooltip>
        ))}
        <OwnColor shown={shown} mode={mode} onPick={(color) => set(color, true)} onPicked={onPicked} id={id} />
      </div>
      {mode === 'dark' && frame.backgroundDark && <Button size="sm" variant="ghost" onClick={() => onChange({ ...frame, backgroundDark: undefined })}>{t('dashboard.frame.sameAsLight')}</Button>}
    </div>
    <Transparency value={frame.transparency ?? 0} onChange={(transparency) => onChange({ ...frame, transparency }, true)} onPicked={onPicked} id={id} />
    <Checkbox checked={Boolean(frame.border)} onChange={(border) => onChange({ ...frame, border })}>{t('dashboard.frame.border')}</Checkbox>
    <div className="field"><span className="note small">{t('dashboard.frame.padding')}</span>
      <Segmented block aria-label={t('dashboard.frame.padding')} value={frame.padding ?? 'normal'} onChange={(padding) => onChange({ ...frame, padding })} options={paddings.map((value) => ({ value, label: t(`dashboard.frame.paddings.${value}`) }))} />
    </div>
  </>
}

/** How far the background lets through what is behind it, the same in both schemes: 0% is opaque, 100% lets everything through. */
function Transparency({ value, onChange, onPicked, id }: { value: number; onChange: (transparency: number) => void; onPicked?: () => void; id: string }) {
  const { t } = useTranslation()
  return (
    <div className="field"><label className="note small" htmlFor={`${id}-transparency`}>{t('dashboard.frame.transparency')}</label>
      <div className="frame-transparency">
        <input id={`${id}-transparency`} type="range" min={0} max={100} step={5} value={value}
          onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onPicked} onKeyUp={onPicked} onBlur={onPicked} />
        <output htmlFor={`${id}-transparency`}>{value}%</output>
      </div>
    </div>
  )
}

/** A colour of the author's own for one scheme, picked or typed in a panel by the last swatch. */
function OwnColor({ shown, mode, onPick, onPicked, id }: { shown: Background | undefined; mode: ColorScheme; onPick: (color: `#${string}`) => void; onPicked?: () => void; id: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // What is being typed, until it is a colour; a picked colour replaces it.
  const [draft, setDraft] = useState<string>()
  const own = isHexColor(shown) ? shown : undefined
  const typed = draft === undefined ? undefined : draft.startsWith('#') ? draft : `#${draft}`
  const pick = (color: string) => onPick(color.toLowerCase() as `#${string}`)
  const label = t('dashboard.frame.backgroundCustom')
  return (
    <Popover open={open} width={244} onOpenChange={(next) => { setOpen(next); setDraft(undefined); if (!next) onPicked?.() }} content={
      <div className="frame-color-picker">
        <p className="note small">{t('dashboard.frame.pickingFor', { scheme: t(`dashboard.frame.${mode}`) })}</p>
        {/* Starting from what is shown, when it is a grey or a hue, to change from there. */}
        <HexColorPicker color={own ?? hueColor(hues.find((hue) => hue === shown) ?? 'blue', mode)} onChange={(color) => { setDraft(undefined); pick(color) }} />
        <Field label={t('dashboard.frame.colorValue')} htmlFor={`${id}-color-value`} hint={t('dashboard.frame.colorValueHint')}>
          <Input id={`${id}-color-value`} size="sm" value={draft ?? own ?? ''} placeholder="#RRGGBB" maxLength={7} invalid={typed !== undefined && !/^#[0-9a-f]{0,6}$/i.test(typed)}
            onChange={(text) => { setDraft(text); const color = text.startsWith('#') ? text : `#${text}`; if (isHexColor(color)) pick(color) }} />
        </Field>
      </div>
    }>
      <button type="button" role="radio" className={`swatch swatch-custom${own ? ' picked' : ''}`} aria-checked={Boolean(own)} aria-label={label} title={label} style={{ background: own ?? swatchOf('default', mode) }}>
        {!own && <Icon name="pipette" size={12} />}
      </button>
    </Popover>
  )
}
