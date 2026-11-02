import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// Third-party UI and chart libraries are wrapped by our own packages and may
// not be imported anywhere else. See .agents/design/architecture.md §11.
const componentLibrary = {
  group: [
    'radix-ui', 'radix-ui/*', '@radix-ui/*', 'cmdk', 'sonner', 'react-day-picker', 'react-day-picker/*',
    'lucide-react', 'cn', 'class-variance-authority', '@tanstack/*',
    'react-grid-layout', 'react-grid-layout/*', '@codemirror/*', '@lezer/*',
    'react-markdown', 'remark-*', 'remend', 'use-stick-to-bottom',
  ],
  message: 'Import components from @supabi/ui instead.',
}
const chartLibrary = {
  group: ['echarts', 'echarts/*', 'zrender', 'zrender/*'],
  message: 'Render charts through @supabi/charts instead.',
}
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  { files: ['apps/**/*.{ts,tsx}'], rules: restrict(componentLibrary, chartLibrary) },
  { files: ['packages/ui/**/*.{ts,tsx}'], rules: restrict(chartLibrary) },
  { files: ['packages/charts/**/*.{ts,tsx}'], rules: restrict(componentLibrary) },
)
