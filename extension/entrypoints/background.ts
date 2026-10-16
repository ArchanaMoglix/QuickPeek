export default defineBackground(() => {
  // Toolbar icon click karne pe side panel khule
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});