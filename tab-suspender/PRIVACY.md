# Privacy

**English**

Tab Suspender does not collect, transmit or sell personal data. It has no analytics, no remote code and no third-party services. The extension author never receives anything.

What it stores on your device, in the browser's extension storage:

- Records of suspended tabs: the page address, title, a short favicon address and the time of suspension.
- Backup snapshots of your open tabs (address, title, whether suspended and pinned). Up to 20 are kept.
- Your settings (automatic suspension on or off, idle time, backup interval).
- Idle timers for open tabs, in an area that is cleared when the browser closes.

This data stays in the browser profile. It is not synced by the extension and not sent anywhere. It is removed when you uninstall the extension. Exports (TXT, JSON) are files you create yourself and are saved wherever you choose.

Things to be aware of:

- A suspended tab's own address contains the original page address and title, because that is how a tab can be restored without storage. That means a suspended tab appears in your browser history with that address.
- To draw the grayscale tab icon, the extension reads the browser's favicon cache. If an icon is not cached it may request that tab's favicon once more from the same site the tab came from. No other site is contacted.
- Private (incognito) tabs are never suspended or backed up.

**Türkçe**

Tab Suspender kişisel veri toplamaz, iletmez ya da satmaz. Analitik, uzak kod veya üçüncü taraf hizmet içermez. Eklenti yazarı hiçbir şey almaz.

Cihazında, tarayıcının eklenti depolamasında sakladıkları:

- Askıdaki sekme kayıtları: sayfa adresi, başlık, kısa bir favicon adresi ve askıya alınma zamanı.
- Açık sekmelerinin yedek görüntüleri (adres, başlık, askıda ve sabitli olup olmadığı). En fazla 20 tane saklanır.
- Ayarların (otomatik askıya alma açık veya kapalı, hareketsizlik süresi, yedek aralığı).
- Açık sekmeler için hareketsizlik sayaçları, tarayıcı kapanınca temizlenen bir alanda.

Bu veri tarayıcı profilinde kalır. Eklenti tarafından senkronize edilmez ve hiçbir yere gönderilmez. Eklentiyi kaldırdığında silinir. Dışa aktarımlar (TXT, JSON) kendi oluşturduğun dosyalardır ve seçtiğin yere kaydedilir.

Bilmen gerekenler:

- Askıdaki bir sekmenin kendi adresi özgün sayfa adresini ve başlığı içerir, çünkü sekme depolamaya ihtiyaç duymadan böyle geri yüklenebilir. Bu yüzden askıdaki sekme tarayıcı geçmişinde bu adresle görünür.
- Gri sekme ikonunu çizmek için eklenti tarayıcının favicon önbelleğini okur. İkon önbellekte yoksa o sekmenin geldiği siteden favicon'u bir kez daha isteyebilir. Başka hiçbir siteyle iletişim kurulmaz.
- Gizli sekmeler hiçbir zaman askıya alınmaz ya da yedeklenmez.
