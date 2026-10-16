import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Quick Peek',
    permissions: ['sidePanel'],
    action: {}, // toolbar icon; popup hata diya hai, isliye explicitly chahiye
  },
});