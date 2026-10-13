# Firefox ve Zen için Tab Suspender

Kullanılmayan sekmeleri hafif bir bekleme sayfasıyla değiştirip gerçek sayfayı bellekten atarak RAM kazandırır. Sekmeyi elle, kısayolla ya da belirli bir hareketsizlik süresi sonunda otomatik olarak askıya alabilirsin. Bekleme sayfasındaki düğmeye basınca özgün sayfa geri gelir.

Bu, Firefox sürümüdür (Firefox 115 veya üstü, Zen). Arka plan kodu, depolama, favicon ve menülerin iki tarayıcıda farklı çalışması yüzünden [tab-suspender](../tab-suspender/README.tr.md) içindeki Chromium sürümünden ayrı bir kod tabanıdır. Aşağıda belirtilenler dışında özellikler aynıdır.

[English](README.md)

## Askıya alma nasıl çalışır

1. Sekme, eklentinin içindeki bir sayfaya gider. Bu sayfanın adresi özgün URL'yi, başlığı ve zamanı taşır. Böylece eklentinin depolaması silinse bile sekme kendi adresinden geri yüklenebilir.
2. Eklenti sitenin favicon'unun gri bir kopyasını küçük bir duraklat rozetiyle çizip sekme ikonu olarak kullanmayı dener. Favicon, sekmenin bildirdiği adresten indirilir ve birçok site bir eklentiden gelen bu isteği reddeder. Bu olduğunda sekme eklentinin kendi duraklat ikonunu taşır.
3. Sekme baktığın sekme olmaktan çıkınca eklenti onu bellekten atar (discard). Belleği asıl boşaltan adım budur. Firefox o an baktığın sekmeyi atmayı reddeder, bu yüzden eklenti sen başka sekmeye geçer geçmez yeniden dener. Bir sekmeyi geri yüklersen, yüklenirken 15 saniye boyunca atılmaktan korunur.
4. Bekleme sayfası favicon'u, başlığı, özgün URL'yi bağlantı olarak, askıya alınma zamanını, üzerinden ne kadar geçtiğini (10 saniyede bir güncellenir) ve bir Geri Yükle düğmesini gösterir.

Geri yükleme aynı sekmeyi özgün URL'ye götürür ve saklanan kaydı siler. Kayıt yoksa bekleme sayfasının kendi adresindeki URL kullanılır, yani boş sayfada kalmazsın.

## Neler askıya alınır, neler alınmaz

- Yalnızca `http` ve `https` sayfaları askıya alınır. `about:`, `moz-extension:`, `file:`, `data:`, `view-source:` ve benzerleri reddedilir.
- Gizli sekmeler hiçbir zaman askıya alınmaz, çünkü URL ve başlık diske yazılırdı. Yedeklerin ve dışa aktarımların dışında da bırakılırlar.
- Sabitlenmiş sekmeler elle askıya alınabilir. Otomatik askıya alma onları atlar.

## Askıya alma ve geri yükleme yolları

**Kısayol: Alt+Shift+S.** Aktif sekmeyi açıp kapatır. `about:addons` içindeki Eklenti Kısayollarını Yönet bölümünden değiştirilebilir.

Birden fazla sekme seçiliyken (sekme şeridinde Ctrl veya Shift ile tıkla) kısayol hepsine uygulanır:

| Seçim | Sonuç |
|---|---|
| Hepsi askıda | Hepsi geri yüklenir |
| Hiçbiri askıda değil | Hepsi askıya alınır |
| Karışık | Açık olanlar askıya alınır, askıdakilere dokunulmaz |

Karışık seçimde eklenti bilerek askıya almayı seçer. Böylece "hepsini askıya al" alışkanlığı bozulmaz ve yanlışlıkla onlarca sekme aynı anda geri yüklenmez. Büyük bir seçimi geri yüklemek tüm sayfaları aynı anda yükler, bu bellek ve bant genişliği demektir.

**Araç çubuğu penceresi.** Aktif sekmeyi askıya alma ve tüm pencerelerdeki askıdaki sekmelerin hepsini geri yükleme düğmeleri.

**Sağ tık menüsü.** Sayfaya ya da sekme şeridindeki bir sekmeye sağ tıkla ve Tab Suspender alt menüsünü aç: sekmeyi askıya al veya geri yükle, şimdi yedekle, yedekleri göster. İlk giriş menü her açıldığında yenilenir, yani tıkladığın sekmeyle eşleşir.

## Otomatik askıya alma

Popup'ta Ayarlar altından aç ve sekmenin ne kadar hareketsiz kalacağını seç: 15 dakika, 30 dakika, 1 saat veya 2 saat. Eklenti dakikada bir kontrol eder. Şu sekmeler atlanır:

- herhangi bir pencerenin aktif sekmesi,
- sabitlenmiş sekmeler,
- ses çalan sekmeler,
- gizli sekmeler,
- zaten askıda veya bellekten atılmış sekmeler,
- `http` ya da `https` olmayan sayfalar.

Hareketsizlik sayacı sekmeden ayrıldığın anda başlar. Saatlerce kullandığın sekme, ayrılır ayrılmaz askıya alınmaz.

## Yedekler

Eklenti açık olan her şeyin anlık görüntüsünü tutar, böylece bir çökme ya da yanlışlıkla kapatılan pencere sekmelerini kaybettirmez.

- Varsayılan olarak 5 dakikada bir görüntü alınır. Aralık 1 ile 180 dakika arasında ayarlanabilir. En yeni 20 görüntü saklanır.
- Görüntü her sekmenin URL'sini, başlığını, favicon adresini, askıda olup olmadığını, sabitli olup olmadığını ve penceresini listeler. Askıdaki sekmeler bekleme sayfasının değil, özgün adresleriyle kaydedilir.
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

- **Aktif sekmeyi kapatmak**, onun yerini alan sekmeyi etkinleştirir. Bu sağındaki sekmedir, en sağdaki kapatılmışsa sonuncu sekmedir.
- **Popup'taki sayılar** (toplam, aktif, askıda) tüm pencerelerdeki gerçek açık sekmelerden sayılır.
- **Dil.** Arayüz tarayıcı dilini izler. İngilizce ve Türkçe dahildir, yedek dil İngilizce.

## Kurulum

### Kaynaktan

```
git clone https://github.com/aykq/extensions
cd extensions/tab-suspender-firefox
npm run build
```

`about:debugging` sayfasını aç, Bu Firefox'u seç, sonra Geçici Eklenti Yükle'ye bas ve `tab-suspender-firefox/dist/firefox/manifest.json` dosyasını göster. Geçici eklenti tarayıcı kapanınca kaldırılır.

Kalıcı kurulum için `dist/firefox` içindekileri (`manifest.json` arşivin en üstünde olacak şekilde) zipleyip addons.mozilla.org'da imzalat ya da imzasız eklentiyi kabul eden bir tarayıcı sürümü kullan. Eklenti kimliği `tab-suspender@aykq.github.io`.

Kaldırmadan ya da yeniden kurmadan önce askıdaki tüm sekmeleri geri yükle. Bekleme sayfaları `moz-extension://<kimlik>/...` adresindedir ve yeniden kurulumda eklentiye yeni bir iç kimlik verilir, bu yüzden eski bekleme sekmeleri artık var olmayan bir adrese işaret eder.

## İzinler

| İzin | Neden |
|---|---|
| `tabs` | Her sekmenin URL'sini, başlığını, sabitli, sesli ve gizli durumunu okumak; sekmeleri askıya almak, geri yüklemek, bellekten atmak ve etkinleştirmek. |
| `storage` | Askıdaki sekme kayıtlarını, yedekleri ve ayarları bu cihazda saklar. Hareketsizlik sayaçları yalnızca bellekte tutulan bir alanda durur. |
| `alarms` | Zamanlanmış yedekler ve dakikada bir yapılan hareketsizlik kontrolü. |
| `menus` | Sağ tık alt menüsü. |

İçerik betiği yok, ana makine izni yok. Manifest ayrıca bekleme sayfasını web'den erişilebilir olarak işaretler, bu Firefox'un oturumu geri yüklerken bekleme sekmelerini yeniden açmasını sağlar. Bkz. [PRIVACY.md](PRIVACY.md).

## Bilinen sınırlar

- **Arka plan betiği yeniden başlaması.** Firefox boştaki bir arka plan betiğini bellekten kaldırır ve sonra yeniden çalıştırır. Bu yüzden sekmelerin hareketsizlik süreleri ve konumları `storage.session` içinde tutulur, bu da Firefox 115 veya üstünü gerektirir. Bir test betiği aynı depolamayla yeniden başlatıp otomatik askıya almanın hâlâ çalıştığını doğrular. Gerçek bir bellekten kaldırmayı yeniden üretmek yalnızca tarayıcıda mümkündür.
- **Gri ikonlar güvenilir değildir**, çünkü favicon isteği sitenin çapraz kaynak kurallarına tabidir. Başarısız olunca düz bir duraklat ikonu kullanılır.
- Popup, bir görüntüdeki her sekmeyle birlikte favicon adresini saklar ve listede o adresi yükleyerek gösterir.

## Geliştirme

```
npm test
```

Paket gerektirmeyen düz Node ile iki dosya çalıştırır:

- `blob-race.test.js`: arka plan betiği, sahte tarayıcı API'leriyle. Toplu askıya almada kayıp güncellemeleri, kayıt eksikken geri yüklemeyi, çoklu seçimden toplu geri yüklemeyi, bellekten atma kurallarını, otomatik askıya alma kurallarını ve bir arka plan betiği yeniden başlatmasını kapsar.
- `i18n.test.js`: koddaki her çeviri anahtarı her dilde var, yer tutucular uyuşuyor, kişisel yol yok.

Yapı:

```
src/        eklenti kaynağı
scripts/    build.js, src'yi dist/firefox'a kopyalar
tests/      test dosyaları
```

## Lisans

MIT, bkz. [LICENSE](../LICENSE).
