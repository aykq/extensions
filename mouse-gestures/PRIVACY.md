# Privacy

**English**

Mouse Gestures does not collect, store, transmit or sell any personal data. It makes no network requests. It has no analytics, no remote code and no third-party services.

The only data it keeps is your two settings (minimum stroke length and the list of sites where gestures are disabled). They are saved with the browser's `storage.sync` API, which means they live in your browser profile and, if you have browser sync turned on, are synced by your browser vendor under its own privacy policy. The extension author never receives them.

The extension runs a small script on every page so it can read mouse events and draw the gesture trail. The script does not read, copy or send page content, form fields, URLs or browsing history. The background part only receives short commands from the script ("close this tab", "open a new tab", "reload") and acts on the tab that sent them.

**Türkçe**

Mouse Gestures hiçbir kişisel veriyi toplamaz, saklamaz, iletmez veya satmaz. Ağ isteği yapmaz. Analitik, uzak kod ya da üçüncü taraf hizmet içermez.

Sakladığı tek veri iki ayarın (minimum jest uzunluğu ve jestlerin kapalı olduğu sitelerin listesi). Bunlar tarayıcının `storage.sync` API'siyle kaydedilir, yani tarayıcı profilinde durur ve tarayıcı senkronizasyonu açıksa tarayıcı sağlayıcısı tarafından kendi gizlilik politikası kapsamında senkronize edilir. Eklenti yazarı bunları hiçbir zaman almaz.

Eklenti, fare olaylarını okumak ve jest izini çizmek için her sayfada küçük bir betik çalıştırır. Betik sayfa içeriğini, form alanlarını, URL'leri veya gezinti geçmişini okumaz, kopyalamaz, göndermez. Arka plan kısmı betikten yalnızca kısa komutlar alır ("bu sekmeyi kapat", "yeni sekme aç", "yenile") ve komutu gönderen sekme üzerinde işlem yapar.
