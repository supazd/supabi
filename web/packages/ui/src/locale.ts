import { createContext, useContext } from 'react'

/** Languages the interface ships in. Add a language here and in the app's message catalogs. */
export const locales = ['zh-CN', 'en-US'] as const
export type Locale = (typeof locales)[number]

/** The words the components say themselves, such as the name of a button that closes a dialog. */
const strings = {
  'zh-CN': {
    clear: '清除',
    close: '关闭',
    search: '搜索',
    noResults: '无匹配项',
    noData: '暂无数据',
    loading: '加载中…',
    remove: '移除',
    previousPage: '上一页',
    nextPage: '下一页',
    page: '第 {n} 页',
    chooseDate: '选择日期',
    startDate: '开始日期',
    endDate: '结束日期',
    previousYear: '上一年',
    nextYear: '下一年',
    send: '发送',
    stop: '停止',
    latest: '回到最新',
  },
  'en-US': {
    clear: 'Clear',
    close: 'Close',
    search: 'Search',
    noResults: 'No results',
    noData: 'No data',
    loading: 'Loading…',
    remove: 'Remove',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    page: 'Page {n}',
    chooseDate: 'Choose a date',
    startDate: 'Start date',
    endDate: 'End date',
    previousYear: 'Previous year',
    nextYear: 'Next year',
    send: 'Send',
    stop: 'Stop',
    latest: 'Jump to latest',
  },
} satisfies Record<Locale, Record<string, string>>

export const LocaleContext = createContext<Locale>('en-US')

export const useStrings = () => strings[useContext(LocaleContext)]

export const useLocale = () => useContext(LocaleContext)
