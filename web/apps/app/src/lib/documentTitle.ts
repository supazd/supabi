import i18n from 'i18next'
import { useEffect } from 'react'

/** What the page in view is called, when it is about one thing. */
let page: string | undefined

/**
 * Names the browser tab after the page, then the app, so tabs of different
 * dashboards can be told apart: a tab too narrow for its title cuts off the
 * end, where every tab would say the same.
 */
export function showTitle() {
  const app = i18n.t('app.name')
  document.title = page ? `${page} - ${app}` : app
}

/** Names the browser tab after what the page shows, while it shows it. */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    page = title?.trim() || undefined
    showTitle()
    return () => {
      page = undefined
      showTitle()
    }
  }, [title])
}
