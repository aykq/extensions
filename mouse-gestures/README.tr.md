# Mouse Gestures

Sağ fare tuşunu basılı tut, bir yöne sürükle, bırak. Tarayıcı geri gider, ileri gider, sekmeyi kapatır, yeni sekme açar ya da sayfayı yeniler. Çizerken imlecin arkasında silik mavi bir çizgi görünür.

Chrome, Brave, Edge ve diğer Chromium tarayıcılarda çalışır (Manifest V3). Aynı kaynaktan bir Firefox paketi de üretilir, bkz. [Firefox](#firefox).

[English](README.md)

## Jestler

| Jest | İşlem |
|---|---|
| Sola sürükle | Sayfa geçmişinde geri |
| Sağa sürükle | Sayfa geçmişinde ileri |
| Aşağı sürükle | Sekmeyi kapat |
| Yukarı sürükle | Yeni sekme aç |
| Sağa sürükle, sonra geri sola | Sayfayı yenile |

Bir çizginin nasıl okunduğunu belirleyen ayrıntılar:

- **Minimum uzunluk.** Bitiş noktası başlangıç noktasından en az 60 px uzaktaysa çizgi sayılır. Değer seçenekler sayfasından 20 ile 400 px arasında değiştirilebilir.
- **Yön.** Çizgi, başlangıçtan bitişe çekilen düz doğruya göre okunur. Uzun eksen kısa eksenin en az 1,5 katı olmalıdır, bu yaklaşık 34 derece eğime izin verir. Çapraza yakın biten çizgi hiçbir şey yapmaz. Böylece özensiz bir sola çekiş sekmeyi kapatmaz.
- **Yenileme.** Önce sağa en az minimum uzunluk kadar, sonra sola en az minimum uzunluk kadar gitmen gerekir ve çizgi büyük ölçüde yatay kalmalıdır (dikey aralık yatay yolun %45'inden az olmalı). Daire çizmek yenilemeyi tetiklemez. Geri dönüş hızlı da yavaş da olabilir.
- **Sekme kapatma.** Kapatılan sekmenin sağındaki sekme aktif olur. Penceredeki son sekmeyi kapatırsan solundaki aktif olur. Sabitlenmiş sekmeler de kapanır. Penceredeki tek sekmeyi kapatmak pencereyi kapatır.
- **Yeni sekme.** Mevcut sekmenin hemen sağında, aynı pencerede açılır.
- **Yenileme önbelleği korur.** F5 gibi davranır, Ctrl+Shift+R gibi değil.

## Sağ tık menüsü çalışmaya devam eder

Fareyi oynatmadan yapılan düz sağ tık normal menüyü açar. Tuş basılıyken imleç 2 px'ten fazla hareket ettiğinde o çizgi için menü bastırılır, böylece jestinin altında menü açılmaz.

## Jesti iptal etme

Sağ tuş hâlâ basılıyken:

- **Escape**'e bas, ya da
- **Sol fare tuşuna** bas. Tıklama yutulur, imlecin altındaki bir bağlantı tetiklenmez.

İki durumda da hiçbir şey olmaz ve sağ tuşu bıraktığında sağ tık menüsü açılmaz. Pencere odağı kaybolursa, sekme gizlenirse ya da sağ tuş sayfanın göremediği bir yerde bırakılırsa çizgi kendiliğinden iptal olur.

## Seçenekler

Eklentinin seçenekler sayfasını aç (`chrome://extensions`, Ayrıntılar, Eklenti seçenekleri).

- **Minimum jest uzunluğu**, piksel cinsinden, 20 ile 400 arası, varsayılan 60.
- **Jestlerin kapalı olduğu siteler**, her satıra bir alan adı. Alt alan adları dahildir, yani `example.com` yazmak `maps.example.com`'u da kapsar. Tam URL yapıştırabilirsin, ana makine adı ayıklanır ve `www.` atılır. Sağ sürüklemeyi zaten kullanan sayfalar için işe yarar: harita görüntüleyiciler, çizim araçları, oyunlar, uzak masaüstü istemcileri.

Ayarlar `storage.sync` ile saklanır, senkronizasyon açıksa tarayıcı profiline eşlik eder.

## Kurulum

### Kaynaktan (Chromium tarayıcılar)

```
git clone https://github.com/aykq/extensions
cd extensions/mouse-gestures
npm run build
```

`chrome://extensions` (veya `brave://extensions`) sayfasını aç, Geliştirici modunu aç, **Paketlenmemiş öğe yükle**'yi seç ve `mouse-gestures/dist/chrome` klasörünü göster. `mouse-gestures/src` klasörünü doğrudan da yükleyebilirsin, Chromium için ikisi aynıdır.

Sonrasında klasörü taşıma ya da silme, tarayıcı eklentiyi oradan okur. Eklenti kartında Yenile'ye bastıktan sonra açık sekmelerini de yenile, bkz. [Bilinen sınırlar](#bilinen-sınırlar).

Node.js sadece dosyaları kopyalayıp Firefox manifestini yazan derleme betiği için gerekir. Çalışma zamanında hiçbir bağımlılık yok.

### Firefox

`npm run build` ayrıca `dist/firefox` üretir. `about:debugging`, Bu Firefox, Geçici Eklenti Yükle yolunu izle ve `dist/firefox/manifest.json` dosyasını seç. Geçici eklenti tarayıcı kapanınca kaybolur. Kalıcı kurulum için addons.mozilla.org tarafından imzalanmış paket gerekir. Firefox paketi `mouse-gestures@aykq.github.io` kimliğini kullanır ve Firefox 115 veya üstünü ister. Firefox, Manifest V3 eklentilerinde site erişimini isteğe bağlı sayar. Jestler hiçbir şey yapmıyorsa `about:addons` içinde eklentinin izinlerini açıp tüm sitelere erişime izin ver.


## İzinler

| İzin | Neden |
|---|---|
| `storage` | İki ayarı saklar. |
| Tüm sitelerde içerik betiği | Jestlerin her sayfada okunması gerekir. Chromium bunu "tüm web sitelerindeki verilerinizi okuyabilir ve değiştirebilir" diye gösterir, bu her sayfada betik çalıştıran eklenti için kullandığı ifadedir. Betik fare olaylarını okur ve izi çizer. Sayfa içeriğini okumaz. |

Eklenti ağ isteği yapmaz ve hiçbir şey toplamaz. Bkz. [PRIVACY.md](PRIVACY.md).

## Bilinen sınırlar

- **Tarayıcının eklentiye izin vermediği sayfalar:** `chrome://` ve `brave://` sayfaları, yeni sekme sayfası, Chrome Web Mağazası ve yerleşik PDF görüntüleyici. Orada jestler çalışmaz. Yerel `file://` sayfaları ancak eklenti için "Dosya URL'lerine erişime izin ver" açıksa çalışır.
- **Iframe'ler.** Jestler yalnızca üst düzey sayfada başlar. Gömülü bir iframe'in üzerinde başlayan çizgi görülmez.
- **Kurulum veya güncelleme sonrası** zaten açık olan sekmeler eski betik kopyasını taşır (ya da hiç taşımaz). O sekmeleri yenile. Eski kopya, değiştirilen eklentiyle ilk konuşmaya çalıştığında kendini kapatır ve o ana kadar yalnızca geri ve ileri çalışır.
- **Piksel mesafesi CSS pikseli cinsindendir**, yani sayfayı yakınlaştırmak gereken fiziksel sürükleme mesafesini uzatır.
- **Tam ekran ve üst katman öğeleri** (bazı video oynatıcılar, `<dialog>`, popover) iz çizgisini kapatabilir. Jestin kendisi yine çalışır.
- **Linux ve macOS.** Oradaki Chromium sağ tık menüsünü fare tuşu bırakılırken değil basılırken açabilir, bu da çizginin önüne geçebilir. Windows'ta geliştirildi ve test edildi.
- **Sekmeyi kapatmak** kaydedilmemiş form verisini kapatma düğmesiyle aynı şekilde kaybettirir. Sayfa "siteden ayrılmak istiyor musun" uyarısı verebilir, eklenti bunu atlamaz.

## Geliştirme

```
npm test
```

Eklentiyi derler ve paket gerektirmeyen düz Node ile üç test takımını çalıştırır: manifestlerin statik denetimi, jest durum makinesi (sahte DOM üzerinde) ve arka plan mantığı (sahte tabs API'siyle).

Yapı:

```
src/         eklenti kaynağı (Chromium'da olduğu gibi yüklenebilir)
scripts/     build.js (dist/chrome ve dist/firefox yazar), make_icons.py
tests/       manifest, içerik betiği ve arka plan testleri
```

Mağaza arşivi için `dist/chrome` içindekileri `manifest.json` arşivin kökünde olacak şekilde zipleyin.

`scripts/make_icons.py` PNG ikonları `src/icons/icon.svg` ile eşleşecek şekilde yeniden çizer (Pillow gerekir). SVG'yi değiştirirsen betiği de güncelle.

## Lisans

MIT, bkz. [LICENSE](../LICENSE).
