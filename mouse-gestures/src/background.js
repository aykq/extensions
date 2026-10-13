'use strict';

const api = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) ? browser : chrome;

async function handle(action, tab) {
  switch (action) {

    case 'closeTabFocusNext': {
      // Always the next tab by position, the previous one only when closing the last tab.
      const tabs = await api.tabs.query({ windowId: tab.windowId });
      tabs.sort((a, b) => a.index - b.index);
      const idx = tabs.findIndex((t) => t.id === tab.id);
      const target = tabs[idx + 1] || tabs[idx - 1];
      if (target) await api.tabs.update(target.id, { active: true });
      await api.tabs.remove(tab.id);
      break;
    }

    case 'newTabAfterCurrent':
      // Chromium ignores openerTabId for placement (Firefox honours it), so index is explicit.
      await api.tabs.create({ windowId: tab.windowId, openerTabId: tab.id, index: tab.index + 1 });
      break;

    case 'reload':
      await api.tabs.reload(tab.id, { bypassCache: false });
      break;
  }
}

// Not async on purpose: Chromium would treat a returned Promise as a response channel.
api.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.action || !sender.tab) return;
  handle(message.action, sender.tab).catch(() => {});
});
