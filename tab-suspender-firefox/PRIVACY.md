# Privacy

**English**

Tab Suspender for Firefox and Zen does not collect, transmit or sell personal data. It has no analytics, no remote code and no third-party services. The extension author never receives anything.

What it stores on your device, in the browser's extension storage:

- Records of suspended tabs: the page address, title, favicon address and the time of suspension.
- Backup snapshots of your open tabs (address, title, favicon address, whether suspended and pinned). Up to 20 are kept.
- Your settings (automatic suspension on or off, idle time, backup interval).

Idle timers for open tabs are kept in memory only.

This data stays in the browser profile. It is not synced by the extension and not sent anywhere. It is removed when you uninstall the extension. Exports (TXT, JSON) are files you create yourself and are saved wherever you choose.

Things to be aware of:

- A suspended tab's own address contains the original page address and title, because that is how a tab can be restored without storage. That means a suspended tab appears in your browser history with that address.
- To draw the grayscale tab icon, the extension downloads the favicon from the address the tab reports, which is the site the tab belongs to. The popup does the same when you open a backup snapshot, it loads each tab's favicon from its site to show it in the list. No other site is contacted.
- Private tabs are never suspended, backed up or exported.

**Türkçe**

Firefox ve Zen için Tab Suspender kişisel veri toplamaz, iletmez ya da satmaz. Analitik, uzak kod veya üçüncü taraf hizmet içermez. Eklenti yazarı hiçbir şey almaz.

Cihazında, tarayıcının eklenti depolamasında sakladıkları:

- Askıdaki sekme kayıtları: sayfa adresi, başlık, favicon adresi ve askıya alınma zamanı.
- Açık sekmelerinin yedek görüntüleri (adres, başlık, favicon adresi, askıda ve sabitli olup olmadığı). En fazla 20 tane saklanır.
- Ayarların (otomatik askıya alma açık veya kapalı, hareketsizlik süresi, yedek aralığı).

Açık sekmelerin hareketsizlik sayaçları yalnızca bellekte tutulur.

Bu veri tarayıcı profilinde kalır. Eklenti tarafından senkronize edilmez ve hiçbir yere gönderilmez. Eklentiyi kaldırdığında silinir. Dışa aktarımlar (TXT, JSON) kendi oluşturduğun dosyalardır ve seçtiğin yere kaydedilir.

Bilmen gerekenler:

- Askıdaki bir sekmenin kendi adresi özgün sayfa adresini ve başlığı içerir, çünkü sekme depolamaya ihtiyaç duymadan böyle geri yüklenebilir. Bu yüzden askıdaki sekme tarayıcı geçmişinde bu adresle görünür.
- Gri sekme ikonunu çizmek için eklenti favicon'u sekmenin bildirdiği adresten, yani sekmenin ait olduğu siteden indirir. Popup bir yedek görüntüsünü açtığında da aynısını yapar, listede göstermek için her sekmenin favicon'unu kendi sitesinden yükler. Başka hiçbir siteyle iletişim kurulmaz.
- Gizli sekmeler hiçbir zaman askıya alınmaz, yedeklenmez ya da dışa aktarılmaz.
