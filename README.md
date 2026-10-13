# Browser extensions

Small browser extensions I write for my own use and publish here.

| Extension | What it does | Browsers |
|---|---|---|
| [Mouse Gestures](mouse-gestures) | Right-button drag gestures for back, forward, close tab, new tab and reload. | Chromium (MV3), Firefox build included |
| [Tab Suspender](tab-suspender) | Suspends inactive tabs to free memory, with automatic suspension, scheduled backups and export. | Chromium (MV3) |
| [Tab Suspender for Firefox](tab-suspender-firefox) | The same idea for Firefox as a separate code base. | Firefox 115+, Zen |

Each extension has its own folder with a README that lists every feature, the permissions it asks for and its known limits, plus a privacy statement. All of them are MIT licensed, see [LICENSE](LICENSE). Interfaces are available in English and Turkish.

Every extension builds with `npm run build` and tests with `npm test`. Node.js is the only requirement and nothing needs to be installed.

---

# Tarayıcı eklentileri

Kendi kullanımım için yazdığım ve burada yayınladığım küçük tarayıcı eklentileri.

| Eklenti | Ne yapar | Tarayıcılar |
|---|---|---|
| [Mouse Gestures](mouse-gestures) | Geri, ileri, sekme kapatma, yeni sekme ve yenileme için sağ tuşla sürükleme jestleri. | Chromium (MV3), Firefox paketi dahil |
| [Tab Suspender](tab-suspender) | Kullanılmayan sekmeleri askıya alıp bellek kazandırır. Otomatik askıya alma, zamanlanmış yedek ve dışa aktarma içerir. | Chromium (MV3) |
| [Tab Suspender (Firefox)](tab-suspender-firefox) | Aynı fikrin Firefox sürümü, ayrı bir kod tabanı olarak. | Firefox 115+, Zen |

Her eklentinin kendi klasöründe tüm özellikleri, istediği izinleri ve bilinen sınırlarını anlatan bir README ve bir gizlilik metni var. Hepsi MIT lisanslıdır, bkz. [LICENSE](LICENSE). Arayüzler İngilizce ve Türkçe sunulur.

Her eklenti `npm run build` ile derlenir ve `npm test` ile test edilir. Tek gereksinim Node.js'tir, bir şey kurmak gerekmez.
