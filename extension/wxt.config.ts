import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Quick Peek',
    permissions: ['sidePanel', 'scripting', 'activeTab'],
    host_permissions: ['<all_urls>'],
    action: {}, // toolbar icon; popup hata diya hai, isliye explicitly chahiye
  },
});


