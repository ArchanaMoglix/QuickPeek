import { RESTRICTED } from '@/lib/extract';
import { OVERLAY_ID, hideOverlay, showOverlay } from '@/lib/overlay';
import { answerConfirm, forgetTab, startRun, stopRun, clearAgent } from '@/lib/agent/manager';
import { OPEN_TABS_KEY, type BgMessage } from '@/lib/session';

export default defineBackground(() => {
  // Side panel sirf fallback hai (chrome:// jaise pages pe overlay nahi lag sakta)
  browser.sidePanel.setOptions({ enabled: false }).catch(console.error);
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

  // Kin tabs mein overlay khula hai: storage hi asli jagah hai (service worker kabhi bhi
  // restart ho sakta hai, memory mein rakha bhool jaata)
  async function openTabs(): Promise<Set<number>> {
    const s = await browser.storage.session.get(OPEN_TABS_KEY);
    return new Set((s[OPEN_TABS_KEY] as number[] | undefined) ?? []);
  }
  async function setOpen(tabId: number, open: boolean) {
    const tabs = await openTabs();
    if (open) tabs.add(tabId);
    else tabs.delete(tabId);
    await browser.storage.session.set({ [OPEN_TABS_KEY]: [...tabs] });
  }

  async function close(tabId: number) {
    await setOpen(tabId, false);
    stopRun(tabId); // widget band = kaam bhi band
    await hideOverlay(tabId);
  }

  // Extension reload/update hua (dev mode mein har code change pe bhi): pehle se khule cards ka
  // andar wala page mar jaata hai aur sirf kaala dabba bachta hai. Aise dabbe hata do.
  browser.runtime.onInstalled.addListener(async () => {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url || RESTRICTED.test(tab.url)) continue;
      browser.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: (id: string) => document.getElementById(id)?.remove(),
          args: [OVERLAY_ID],
        })
        .catch(() => {}); // jin pages pe script nahi chal sakti
    }
  });

  // Toolbar icon: overlay khol/band karo, sirf isi tab mein. Naye tab mein band hi rehta hai.
  browser.action.onClicked.addListener((tab) => {
    if (!tab.id) return;
    const tabId = tab.id;

    // Browser ke apne pages pe website nahi hoti: wahan purana side panel.
    // Yahan await mat lagana, warna Chrome click wala "user gesture" bhool jaata hai.
    if (!tab.url || RESTRICTED.test(tab.url)) {
      browser.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true }).catch(console.error);
      browser.sidePanel.open({ tabId }).catch(console.error);
      return;
    }

    openTabs().then(async (tabs) => {
      if (tabs.has(tabId)) return close(tabId);
      await setOpen(tabId, true);
      if (!(await showOverlay(tabId, true))) await setOpen(tabId, false);
    });
  });

  // Page badla (link click, agent ka click): naye page pe overlay dobara lagao, bina animation
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    openTabs().then((tabs) => {
      if (tabs.has(tabId)) showOverlay(tabId, false);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    setOpen(tabId, false).catch(console.error);
    forgetTab(tabId);
  });

  // Overlay (UI) ke messages
  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as BgMessage;
    switch (msg?.type) {
      case 'qp:agent:start':
        startRun(msg.tabId, msg.runId, msg.instruction).catch(console.error);
        break;
      case 'qp:agent:confirm':
        answerConfirm(msg.tabId, msg.ok);
        break;
      case 'qp:agent:stop':
        stopRun(msg.tabId);
        break;
      case 'qp:agent:clear':
        clearAgent(msg.tabId).catch(console.error);
        break;
      case 'qp:overlay:close':
        close(msg.tabId).catch(console.error);
        break;
    }
  });
});
