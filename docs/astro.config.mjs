import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// See .agents/design/docs-site.md.
export default defineConfig({
  integrations: [
    starlight({
      title: 'SupaBI',
      logo: { src: './src/assets/logo.svg' },
      customCss: ['./src/styles/theme.css'],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      sidebar: [
        {
          label: 'Getting started',
          translations: { 'zh-CN': '快速开始' },
          items: [{ slug: 'getting-started/install' }, { slug: 'getting-started/first-dashboard' }],
        },
        {
          label: 'Concepts',
          translations: { 'zh-CN': '概念' },
          items: [{ slug: 'concepts/overview' }],
        },
        {
          label: 'Data',
          translations: { 'zh-CN': '数据' },
          items: [
            { slug: 'data/datasources' },
            { slug: 'data/exploration' },
            { slug: 'data/datasets' },
            { slug: 'data/parameters' },
            { slug: 'data/expressions' },
          ],
        },
        {
          label: 'Charts',
          translations: { 'zh-CN': '图表' },
          items: [{ slug: 'charts/editor' }, { slug: 'charts/types' }, { slug: 'charts/tables' }],
        },
        {
          label: 'Dashboards',
          translations: { 'zh-CN': '仪表盘' },
          items: [{ slug: 'dashboards/build' }, { slug: 'dashboards/interaction' }, { slug: 'dashboards/view-and-share' }],
        },
        {
          label: 'Administration',
          translations: { 'zh-CN': '管理' },
          items: [
            { slug: 'admin/members' },
            { slug: 'admin/data-permissions' },
            { slug: 'admin/system' },
            { slug: 'admin/ai-assistant' },
            { slug: 'admin/mcp' },
          ],
        },
        {
          label: 'Deployment',
          translations: { 'zh-CN': '部署' },
          items: [{ slug: 'deployment/configuration' }, { slug: 'deployment/exports-and-cache' }, { slug: 'deployment/operations' }],
        },
      ],
    }),
  ],
})
