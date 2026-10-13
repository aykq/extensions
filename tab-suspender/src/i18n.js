// Fills elements marked with data-i18n (text) and data-i18n-title (tooltip).
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = api.i18n.getMessage(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = api.i18n.getMessage(el.dataset.i18nTitle);
  }
})();
