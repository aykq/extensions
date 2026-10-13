# Tab Suspender

Kullanılmayan sekmeleri hafif bir bekleme sayfasıyla değiştirip gerçek sayfayı bellekten atarak RAM kazandırır. Sekmeyi elle, kısayolla ya da belirli bir hareketsizlik süresi sonunda otomatik olarak askıya alabilirsin. Bekleme sayfasındaki düğmeye basınca özgün sayfa geri gelir.

Chromium sürümü (Chrome, Brave, Edge, Manifest V3). Firefox ve Zen sürümü [tab-suspender-firefox](../tab-suspender-firefox) klasöründe.

[English](README.md)

## Askıya alma nasıl çalışır

1. Sekme, eklentinin içindeki bir sayfaya gider. Bu sayfanın adresi özgün URL'yi, başlığı ve zamanı taşır. Böylece eklentinin depolaması silinse bile sekme kendi adresinden geri yüklenebilir.
2. Eklenti sitenin favicon'unun gri bir kopyasını küçük bir duraklat rozetiyle çizer ve sekme ikonu olarak kullanır. Askıdaki sekme bir bakışta ayırt edilir.
3. Sekme baktığın sekme olmaktan çıkınca tarayıcı onu bellekten atar (discard). Belleği asıl boşaltan adım budur. O an baktığın sekme asla atılmaz, sen başka sekmeye geçtiğin anda atılır. Bir sekmeyi geri yüklersen, yüklenirken 15 saniye boyunca atılmaktan korunur.
4. Bekleme sayfası favicon'u, başlığı, özgün URL'yi bağlantı olarak, askıya alınma zamanını, üzerinden ne kadar geçtiğini (10 saniyede bir güncellenir) ve bir Geri Yükle düğmesini gösterir.

Geri yükleme aynı sekmeyi özgün URL'ye götürür ve saklanan kaydı siler. Kayıt yoksa bekleme sayfasının kendi adresindeki URL kullanılır, yani boş sayfada kalmazsın.

## Neler askıya alınır, neler alınmaz

- Yalnızca `http` ve `https` sayfaları askıya alınır. `chrome://`, `brave://`, `file:`, eklenti sayfaları, `data:` ve benzerleri ile Web Mağazası reddedilir.
- Gizli sekmeler hiçbir zaman askıya alınmaz, çünkü URL ve başlık diske yazılırdı. Yedeklerin ve dışa aktarımların dışında da bırakılırlar.
- Sabitlenmiş sekmeler elle askıya alınabilir. Otomatik askıya alma onları atlar.

## Askıya alma ve geri yükleme yolları

**Kısayol: Alt+Shift+S.** Aktif sekmeyi açıp kapatır. Tarayıcının eklenti kısayolları sayfasından değiştirilebilir (`chrome://extensions/shortcuts`).

Birden fazla sekme seçiliyken (sekme şeridinde Ctrl veya Shift ile tıkla) kısayol hepsine uygulanır:

| Seçim | Sonuç |
|---|---|
| Hepsi askıda | Hepsi geri yüklenir |
| Hiçbiri askıda değil | Hepsi askıya alınır |
| Karışık | Açık olanlar askıya alınır, askıdakilere dokunulmaz |

Karışık seçimde eklenti bilerek askıya almayı seçer. Böylece "hepsini askıya al" alışkanlığı bozulmaz ve yanlışlıkla onlarca sekme aynı anda geri yüklenmez. Büyük bir seçimi geri yüklemek tüm sayfaları aynı anda yükler, bu bellek ve bant genişliği demektir.

**Araç çubuğu penceresi.** Aktif sekmeyi askıya alma ve tüm pencerelerdeki askıdaki sekmelerin hepsini geri yükleme düğmeleri.

**Sağ tık menüsü.** Sayfaya ya da eklentinin araç çubuğu ikonuna sağ tıkla ve Tab Suspender alt menüsünü aç: sekmeyi askıya al veya geri yükle, şimdi yedekle, yedekleri göster. İlk giriş her zaman aktif sekmenin durumunu yansıtır. Chromium eklentilerin sekme şeridi menüsüne giriş eklemesine izin vermez, bu yüzden araç çubuğu ikonu kullanılır.

## Otomatik askıya alma

Popup'ta Ayarlar altından aç ve sekmenin ne kadar hareketsiz kalacağını seç: 15 dakika, 30 dakika, 1 saat veya 2 saat. Eklenti dakikada bir kontrol eder. Şu sekmeler atlanır:

- herhangi bir pencerenin aktif sekmesi (her pencere kendi aktif sekmesini korur),
- sabitlenmiş sekmeler,
- ses çalan sekmeler,
- gizli sekmeler,
- zaten askıda veya bellekten atılmış sekmeler,
- `http` ya da `https` olmayan sayfalar.

Hareketsizlik sayacı sekmeden ayrıldığın anda başlar. Saatlerce kullandığın sekme, ayrılır ayrılmaz askıya alınmaz.

## Yedekler

Eklenti açık olan her şeyin anlık görüntüsünü tutar, böylece bir çökme ya da yanlışlıkla kapatılan pencere sekmelerini kaybettirmez.

- Varsayılan olarak 5 dakikada bir görüntü alınır. Aralık 1 ile 180 dakika arasında ayarlanabilir. En yeni 20 görüntü saklanır.
- Görüntü her sekmenin URL'sini, başlığını, askıda olup olmadığını, sabitli olup olmadığını ve penceresini listeler. Askıdaki sekmeler bekleme sayfasının değil, özgün adresleriyle kaydedilir.
- Popup görüntüleri zaman, sekme sayısı ve kaç tanesinin askıda olduğuyla listeler. Birini açınca her sekmeyi görürsün. Oradan tek bir sekmeyi açabilir, görüntünün tamamını (onay sorusundan sonra) geri yükleyebilir, dışa aktarabilir veya silebilirsin.
- Bir görüntüyü geri yüklemek her sekmeyi yeni bir arka plan sekmesi olarak açar. Askıda olanlar askıda geri gelir.
- Popup'taki ve sağ tık menüsündeki "Şimdi Yedekle" anında görüntü alır.
- **Önceki oturumdan kalanlar.** Bir askı kaydı var ama onu kullanan açık sekme kalmamışsa (örneğin çökmeden sonra), eklenti kaydı "kalıntı" işaretli bir görüntüye çevirir ve kaydı siler. Bu, tarayıcı açıldıktan bir dakika sonra ve her zamanlanmış yedekte çalışır. 10 dakikadan genç kayıtlar yok sayılır, çünkü hâlâ yüklenen bir sekme sahipsiz görünebilir.

## Dışa aktarma

Popup'tan açık tüm sekmeleri ya da tek bir görüntüyü şu biçimlerde dışa aktarabilirsin:

- **TXT:** tarih, sekme sayısı ve askıdaki sayısıyla kısa bir başlık, ardından her satırda bir URL. Askıdaki sekmelerin önünde `[ASKIDA]` etiketi, URL'den sonra parantez içinde başlığı olur.
- **JSON:** `url`, `title`, `suspended` ve `pinned` alanlarıyla bir sekme listesi.

Askıdaki sekmeler her zaman gerçek adresleriyle dışa aktarılır.

## Bilmeye değer diğer davranışlar

- **Aktif sekmeyi kapatmak**, onun yerini alan sekmeyi etkinleştirir. Bu sağındaki sekmedir, en sağdaki kapatılmışsa sonuncu sekmedir. Bu, tarayıcının kendi seçiminin yerine geçer.
- **Popup'taki sayılar** (toplam, aktif, askıda) saklı kayıtlardan değil, tüm pencerelerdeki gerçek açık sekmelerden sayılır.
- **Dil.** Arayüz tarayıcı dilini izler. İngilizce ve Türkçe dahildir, yedek dil İngilizce.

## Kurulum

### Kaynaktan

```
git clone https://github.com/aykq/extensions
cd extensions/tab-suspender
npm run build
```

`chrome://extensions` (veya `brave://extensions`) sayfasını aç, Geliştirici modunu aç, **Paketlenmemiş öğe yükle**'yi seç ve `tab-suspender/dist/chrome` klasörünü göster. Kodu değiştirince derlemeyi tekrar çalıştır ve eklenti kartında Yenile'ye bas.

**Yükledikten sonra klasörü taşıma.** Paketlenmemiş eklentide tarayıcı eklenti kimliğini klasör yolundan üretir. Bekleme sayfaları `chrome-extension://<kimlik>/...` adresindedir. Kimlik değişirse tüm askıdaki sekmeler artık var olmayan bir adrese işaret eder ve geri yüklenemez. Taşımadan, yeniden kurmadan ya da eklentiyi kaldırmadan önce askıdaki tüm sekmeleri geri yükle (popup bunu hatırlatır). Mağazadan kurulumun kimliği sabittir.

## İzinler

| İzin | Neden |
|---|---|
| `tabs` | Her sekmenin URL'sini, başlığını, sabitli, sesli ve gizli durumunu okumak; sekmeleri askıya almak, geri yüklemek ve etkinleştirmek. |
| `storage` | Askıdaki sekme kayıtlarını, yedekleri ve ayarları bu cihazda saklar. Hareketsizlik sayaçları kısa ömürlü bir bellek alanında durur. |
| `alarms` | Zamanlanmış yedekler ve dakikada bir yapılan hareketsizlik kontrolü. Service worker zamanlayıcılara güvenemez. |
| `contextMenus` | Sağ tık alt menüsü. |
| `favicon` | Gri ikonu ve yedek listesindeki ikonları çizmek için tarayıcının kendi favicon önbelleğini okur. Siteleri yeniden aramayı önler. |

İçerik betiği yok, ana makine izni yok. Bkz. [PRIVACY.md](PRIVACY.md).

## Bilinen sınırlar

- Gri sekme ikonu tarayıcının favicon önbelleğine bağlıdır. Favicon önbellekte yoksa eklenti kendi duraklat ikonuna döner.
- Tarayıcı sağ tık menüsünden ("Yedekleri Göster") popup'ı açmayı reddederse popup normal bir sekmede açılır.
- Chromium bir sekmeyi yeni bir sekme kimliğiyle değiştirebilir (ön yükleme takası, discard). Eklenti bu olduğunda durumunu yeniden anahtarlar, zamanlanmış temizlik arkada kalanı siler.
- Service worker boştayken tarayıcı tarafından durdurulur. Bunu aşması gereken tüm durum `storage.session` ya da `storage.local` içinde tutulur ve `npm test` bunun için bir yeniden başlatma testi içerir. Gerçek bir worker yeniden başlatması yalnızca tarayıcıda yeniden üretilebilir, aşağıya bak.

## Geliştirme

```
npm test
```

Paket gerektirmeyen düz Node ile iki dosya çalıştırır:

- `sw-restart.test.js`: arka plan betiği, aynı depolamayı koruyan bir service worker yeniden başlatması dahil, sahte tarayıcı API'leriyle. Durum bellekte tutulursa otomatik askıya almayı sessizce bozan durum budur.
- `i18n.test.js`: koddaki her çeviri anahtarı her dilde var, yer tutucular uyuşuyor, kişisel yol yok.

Yapı:

```
src/        eklenti kaynağı, olduğu gibi yüklenebilir
scripts/    build.js, src'yi dist/chrome'a kopyalar
tests/      test dosyaları
```

Gerçek bir service worker yeniden başlatmasını elle denemek için: `chrome://extensions` üzerinden eklentinin service worker'ını aç, otomatik askıya almayı 15 dakikayla etkinleştir, DevTools'ta Terminate'e bas, sekme değiştir, hareketsizlik süresini bekle ve sekmenin askıya alındığını, popup'ın hâlâ istatistik gösterdiğini doğrula.

## Lisans

MIT, bkz. [LICENSE](../LICENSE).
