'use strict';

const api = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) ? browser : chrome;
const DEFAULTS = { minDistance: 60, blockedSites: [] };

const $ = (id) => document.getElementById(id);
const msg = (key) => api.i18n.getMessage(key);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);

function normalizeHost(line) {
  let s = line.trim().toLowerCase();
  if (!s) return '';
  try { if (s.includes('://')) s = new URL(s).hostname; } catch (_) { /* keep raw text */ }
  return s.replace(/^www\./, '').replace(/\/.*$/, '');
}

async function load() {
  const s = await api.storage.sync.get(DEFAULTS);
  $('minDistance').value = s.minDistance;
  $('blockedSites').value = (s.blockedSites || []).join('\n');
}

let timer = null;
async function save() {
  const raw = Number($('minDistance').value);
  const minDistance = raw >= 20 && raw <= 400 ? raw : DEFAULTS.minDistance;
  const blockedSites = [...new Set($('blockedSites').value.split('\n').map(normalizeHost).filter(Boolean))];
  await api.storage.sync.set({ minDistance, blockedSites });
  $('status').textContent = msg('optSaved');
  clearTimeout(timer);
  timer = setTimeout(() => { $('status').textContent = ''; }, 1500);
}

$('minDistance').addEventListener('change', save);
$('blockedSites').addEventListener('change', save);
load();
