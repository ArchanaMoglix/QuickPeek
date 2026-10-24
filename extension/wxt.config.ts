import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Quick Peek',
    permissions: ['sidePanel', 'scripting', 'activeTab', 'storage'],
    host_permissions: ['<all_urls>'],
    action: {}, // toolbar icon; popup hata diya hai, isliye explicitly chahiye
    // Overlay card website ke andar iframe mein ye page kholta hai
    web_accessible_resources: [
      { resources: ['sidepanel.html'], matches: ['<all_urls>'] },
    ],
  },
});


