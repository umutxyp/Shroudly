# Shroudly'yi Google Play'e koymak (sahibin adımları)

Bu dosya, Shroudly Android uygulamasını ileride Google Play'de yayınlamak için
Play Console'da elle yapılacak işleri sırayla anlatır. Kod tarafı hazır:

- Play için ayrı bir paket (AAB) her sürümde otomatik üretilir. Bu paket
  GitHub'a güncelleme sormaz, çünkü uygulamayı Play günceller (uygulamanın
  içinden de, Play'in kendi arayüzüyle: 4a).
- GitHub'daki APK ile Play sürümü **aynı uygulamadır**: paket adı
  (`me.codeshare.shroudly`), imza sertifikası ve sürüm kodu aynıdır. Bu yüzden
  APK'yı GitHub'dan kuran biri ileride Play'den güncelleme alır (Play aynı
  imzayı görüp uygulamayı eşleştirir). Play'den kuran biri de isterse GitHub
  APK'sını üstüne kurabilir.
- Play'in kuralları kodda karşılanıyor: hedef API 36; tüm `.so` dosyaları 16 KB
  hizalı (CI her sürümde kontrol ediyor); ön plan servisi VPN modunda
  `systemExempted`, "Yalnızca proxy" modunda (Ayarlar, #31) `specialUse`
  (VPN olmadığı için başka tür uymuyor; beyanı aşağıda, 5h); Play'den
  kurulan kopya güncellemeyi yalnızca Play'in kendi uygulama içi güncelleme
  arayüzüyle alıyor (4a) ve dışarıdan kod indirmiyor; uygulama
  içinde gizlilik politikası bağlantısı var (Hakkında bölümü, 31 dil).

Play Console'daki menü adları zamanla değişebilir. Aşağıda yazanları bulamazsan
benzer adlı menüye bak.

---

## 0. Değişmeyecek iki kural

1. **İmza sertifikası asla değişmez.** GitHub APK'sı ve Play sürümü aynı
   "uygulama imzalama anahtarıyla" imzalanır:
   `~/Desktop/Shroudly/android-imza/shroudly-release.jks`, alias `shroudly`.
   Sertifikanın SHA-256 değeri:

       23:AC:01:4B:72:26:34:3B:74:C7:C9:C0:A4:FD:6F:1D:ED:97:51:8A:3B:FD:35:BC:DE:65:B6:C1:EC:A8:BD:76

   Bu dosya kaybolursa veya değişirse kurulu hiçbir kopya bir daha
   güncellenemez. Dosyanın ve şifresinin çevrimdışı bir yedeği olsun (en az iki
   ayrı yerde, örneğin şifreli bir USB bellek ve bir parola yöneticisi).
   **Google'ın yeni bir anahtar üretmesine asla izin verme.** Üretirse GitHub
   APK'sını kuranlar Play'den hiç güncelleme alamaz.

2. **versionCode hep artar.** Sürüm kodu `package.json`'daki sürümden
   hesaplanır: `major*10000 + minor*100 + patch` (2.5.14 → 20514). İki kanalda
   aynı sürüm aynı kodu alır. Play'e daha düşük ya da aynı kodla paket
   yüklenemez. Bu yüzden her Play yüklemesi yeni bir sürüm (yeni etiket)
   olmalı. Minor ve patch 99'u geçemez (build bunu zaten durdurur).

---

## 1. Ön koşul: Kuruluş (Organization) geliştirici hesabı

Google, `VpnService` kullanan uygulamaları yalnızca **kuruluş hesaplarından**
kabul ediyor. Kişisel hesapla bu uygulama yayınlanamaz.

- Codeshare Technology Ltd adına bir kuruluş hesabı aç ya da kişisel hesabı
  kuruluşa çevir.
- Bunun için bir **D-U-N-S numarası** gerekir (ücretsiz). Alınması 30 güne
  kadar sürebilir; bu yüzden ilk iş bunu başlat.
- Kuruluş hesabında kişisel hesaplardaki "14 gün boyunca 12 test kullanıcısı"
  zorunluluğu yoktur.

## 2. Uygulamayı oluştur

Play Console → **Uygulama oluştur**:

- Uygulama adı: `Shroudly` (adda "VPN" geçmesin, aşağıya bak)
- Varsayılan dil: English (United States). Türkçe listeleme ayrıca eklenir.
- Uygulama / Oyun: **Uygulama**
- Ücretsiz / Ücretli: **Ücretsiz**
- Paket adı ilk yüklenen pakette belirlenir: `me.codeshare.shroudly`

## 3. Play Uygulama İmzalama: mevcut anahtarla

Amaç: Play, kullanıcılara giden APK'ları **bizim mevcut anahtarımızla**
imzalasın. Böylece GitHub APK'sıyla aynı imzayı taşırlar.

**İlk paketi yüklemeden önce** Play Console → uygulama → **Test ve yayınla →
Kurulum → Uygulama imzalama** (eski adı: Uygulama bütünlüğü → Uygulama
imzalama). Orada **"Uygulama imzalama anahtarını değiştir"** / **"Java
KeyStore'dan dışa aktar ve yükle"** ("Export and upload a key from a Java
keystore") seçeneğini seç. "Google tarafından oluşturulan anahtarı kullan"
seçeneğini **seçme**.

### 3a. Sertifikanın doğru olduğunu kontrol et

Terminalde (şifreyi `keytool` kendisi sorar, komuta yazma):

    keytool -list -v \
      -keystore "$HOME/Desktop/Shroudly/android-imza/shroudly-release.jks" \
      -alias shroudly | grep "SHA256:"

Çıkan değer yukarıdaki `23:AC:01:4B:...:BD:76` ile aynı olmalı. Değilse dur:
yanlış dosya.

Aynı komutu `grep` olmadan çalıştırırsan "Valid from ... until ..." satırı
görünür. Play, geçerliliği **22 Ekim 2033'ten sonra** biten bir anahtar ister
(anahtar RSA 2048 bit ya da üstü olmalı). Mevcut anahtar 4096 bit RSA ve
26 Eylül 2126'ya kadar geçerli (2026-10-20'de kontrol edildi), yani uygun.

### 3b. Anahtarı şifreli olarak dışa aktar (PEPK)

Play Console'daki aynı sayfadan iki dosyayı indir: **`pepk.jar`** ve
**şifreleme ortak anahtarı** (`encryption_public_key.pem`). İkisini de
indirdiğin klasörde şunu çalıştır:

    java -jar pepk.jar \
      --keystore="$HOME/Desktop/Shroudly/android-imza/shroudly-release.jks" \
      --alias=shroudly \
      --output=shroudly-play-signing-key.zip \
      --include-cert \
      --rsa-aes-encryption \
      --encryption-key-path=encryption_public_key.pem

- `pepk` anahtar deposu şifresini ve anahtar şifresini **kendisi sorar**.
  Şifreleri komut satırına (`--keystore-pass` vb.) yazma; terminal geçmişine
  düşer.
- Çıkan `shroudly-play-signing-key.zip`, Google'ın ortak anahtarıyla
  şifrelidir; yalnızca Google açabilir.
- Play Console'da bu ZIP'i yükle.
- Yükledikten sonra ZIP'i sil (`rm shroudly-play-signing-key.zip`). Asıl `.jks`
  dosyası olduğu yerde kalır.

Not: Play Console bazen PEPK komutunu sayfada hazır verir. Onun içindeki
`--encryption-key=...` gibi değerler sayfadakiyle aynı kalsın; yalnızca
`--keystore` ve `--alias` yukarıdaki gibi olmalı.

### 3c. Ayrı bir yükleme (upload) anahtarı

Google, Play'e yüklenen paketin uygulama imzalama anahtarından **farklı** bir
"yükleme anahtarıyla" imzalanmasını önerir. Yükleme anahtarı kaybolursa Play
destek üzerinden sıfırlanabilir; uygulama imzalama anahtarı sıfırlanamaz.

1. Yeni yükleme anahtarını üret (şifreleri `keytool` sorar):

       keytool -genkeypair -v \
         -keystore "$HOME/Desktop/Shroudly/android-imza/shroudly-upload.jks" \
         -alias upload -keyalg RSA -keysize 4096 -validity 10950

2. Sertifikasını dışa aktar:

       keytool -export -rfc \
         -keystore "$HOME/Desktop/Shroudly/android-imza/shroudly-upload.jks" \
         -alias upload -file upload_certificate.pem

3. Play Console'da imzalama sayfasında yükleme anahtarı sertifikası olarak
   `upload_certificate.pem` dosyasını yükle (seçenek "yükleme anahtarı
   sertifikasını yükle" gibi adlandırılır).

4. GitHub secret'larını ekle. `gh` şifreleri ekranda göstermeden sorar:

       base64 -i "$HOME/Desktop/Shroudly/android-imza/shroudly-upload.jks" \
         | gh secret set ANDROID_UPLOAD_KEYSTORE_B64 -R umutxyp/Shroudly
       gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD -R umutxyp/Shroudly
       gh secret set ANDROID_UPLOAD_KEY_ALIAS -R umutxyp/Shroudly --body upload
       gh secret set ANDROID_UPLOAD_KEY_PASSWORD -R umutxyp/Shroudly

   Bu secret'lar yoksa release workflow'u Play paketini uygulama imzalama
   anahtarıyla imzalar ve bunu bir uyarıyla söyler. Play buna da izin verir,
   ama ayrı yükleme anahtarı daha güvenlidir.

5. `shroudly-upload.jks` dosyasının da çevrimdışı bir yedeğini al.

## 4. Play paketini (AAB) almak

Her `v*` etiketiyle çalışan **Release** workflow'u, APK'nın yanında Play
paketini de üretir:

- Adı: `Shroudly-<sürüm>.aab`. Aynı sürüm ve sürüm kodu, `STORE_BUILD` açık
  (GitHub'a güncelleme sormaz), yükleme anahtarıyla imzalı.
- 16 KB sayfa boyutu kontrolünden geçmiştir (APK'da ve Play'in paketten
  üreteceği tüm APK'larda).
- Release sayfasına **konmaz**. Workflow çalıştırmasının **artifact**'ı olarak
  90 gün saklanır: `play-bundle`.

İndirmek için:

    gh run list -R umutxyp/Shroudly -w Release -L 5
    gh run download <run-id> -R umutxyp/Shroudly -n play-bundle

Sonra Play Console → **Test et ve yayınla → Test → Dahili test** (Internal
testing) → yeni sürüm → AAB'yi yükle. İlk sürümü her zaman dahili testte
dene, sonra kapalı teste ve üretime al.

Elle üretmek gerekirse (repo kökünden, yükleme anahtarının değişkenleriyle):

    node android/scripts/fetch-hev.js
    cd android && ANDROID_UPLOAD_KEYSTORE=<yükleme-anahtarı.jks> ANDROID_UPLOAD_KEYSTORE_PASSWORD=<şifre> \
      ANDROID_UPLOAD_KEY_ALIAS=<takma ad> ANDROID_UPLOAD_KEY_PASSWORD=<şifre> ./gradlew -Pshroudly.store=play bundleRelease
    bash scripts/check-16k.sh app/build/outputs/bundle/release/app-release.aab
    # çıktı: android/app/build/outputs/bundle/release/app-release.aab

### 4a. Uygulama içi güncelleme (Play)

Play'den kurulan kopya yeni sürümü uygulamanın içinden, Google Play'in kendi
**uygulama içi güncelleme** (In-App Updates) arayüzüyle alır. Play'in
kurallarına uyan tek yol budur: uygulama kendini başka bir yoldan
güncellemez, GitHub'a hiç sormaz. Kitaplık
`com.google.android.play:app-update:2.1.0`, yalnızca Play paketinde vardır
(`android/app/src/play/kotlin/.../PlayUpdates.kt`); GitHub APK'sında bu
kitaplık ve Google kodu yoktur. Kurallar
`android/app/src/main/java/.../PlayUpdatePolicy.kt` dosyasında, testleriyle.

Kullanıcının gördüğü:

- Play'de daha yeni bir sürüm varsa ana penceredeki güncelleme kartı
  "Sürüm X kullanılabilir" der, düğmesi **İndir ve kur**. Play'e günde en
  fazla bir kez sorulur.
- Play'in kendi penceresi, kullanıcı Shroudly'yi açtığında, günde en fazla
  bir kez kendiliğinden çıkar. Koruma açılırken ya da kapanırken çıkmaz.
  Varsayılan **esnek** (flexible) güncellemedir: indirme arka planda olur,
  uygulama kullanılmaya devam eder, kartta yüzde görünür.
- Şu durumlarda **hemen** (immediate, tam ekran) güncelleme istenir ve kart
  "Sürüm X önemli bir güncelleme" der:
  - sürümün önceliği 4 ya da 5 ise (aşağıya bak),
  - kopya 20 ya da daha fazla sürüm numarası gerideyse (yeni bir major her
    zaman sayılır; yalnızca masaüstü için çıkan sürümler de numara
    harcadığından eşik bilerek yüksek),
  - güncelleme 7 gündür bekliyorsa.
- Play esnek güncellemeyi kabul etmeyip yalnızca tam ekranı sunuyorsa (sürüm
  yeni çıkmışsa ya da telefonda yer azsa) ve güncelleme yukarıdaki
  durumlardan biri değilse, tam ekran kendiliğinden çıkmaz: kart bekler,
  kullanıcı düğmeye dokununca açılır.
- Kullanıcı "hayır" derse ya da Play'in ekranını kapatırsa Shroudly normal
  çalışır; ertesi gün yeniden sorulur. Uygulama **asla kilitlenmez**.
- İndirme bitince: pencere açıksa kart **Şimdi yeniden başlat** der. Pencere
  kapalı ve koruma kapalıysa Play güncellemeyi sessizce kurar. Koruma açıksa
  bir bildirim çıkar ("dokununca kurulur"), çünkü kurulum korumayı bir an
  keser; zamanı kullanıcı seçer. Shroudly'nin Ayarlar penceresi açıkken
  hiçbir şey ekranı kaplamaz; kart, kullanıcı ana pencereye dönünce çıkar.
- Kurulum uygulamayı ve korumayı kapatır. Koruma açıkken güncellendiyse
  kurulum biter bitmez kendiliğinden yeniden açılır (`MY_PACKAGE_REPLACED`,
  `KeepOn.updated`). Bu, Play'in kendi otomatik güncellemesi ve GitHub
  APK'sının üstüne yeni APK kurulumu için de geçerlidir.
- Play'in pencerelerini Play kendisi, telefonun dilinde gösterir.

Önceliği (priority) vermek:

- `inAppUpdatePriority` (0–5) yalnızca **Google Play Developer API** ile,
  sürüm yayına alınırken verilir. Play Console'da bunun için bir alan yok;
  sonradan değiştirilemez; dahili uygulama paylaşımında (internal app
  sharing) desteklenmez.
- Bölüm 4'teki gibi Console'dan elle yüklenen her sürümün önceliği **0**
  olur: yalnızca esnek güncelleme; 20 sürüm / 7 gün kuralları yine çalışır.
- Acil bir sürüm için API akışı: `edits.insert` → `edits.bundles.upload` →
  `edits.tracks.update`, gövde:

      {"releases":[{"versionCodes":["20644"],"status":"completed","inAppUpdatePriority":5}]}

  → `edits.commit`. Bunun için Play Console'da yayın izni olan bir hizmet
  hesabı (service account) ve onun JSON anahtarı gerekir; release
  workflow'una eklenecekse GitHub secret olarak (örneğin
  `PLAY_SERVICE_ACCOUNT_JSON`). Bu yol henüz kurulu değil: ilk acil
  sürümden **önce** karar ver, çünkü öncelik sonradan verilemez.
- Play, kurulu sürümle en yeni sürüm arasındaki tüm sürümlerin önceliğine
  bakar: tek bir acil sürüm, kullanıcı onu geçene kadar hemen güncellemeyi
  ister.
- Eşikler kodda: `PlayUpdatePolicy.URGENT_PRIORITY` (4), `FAR_BEHIND` (20),
  `STALE_DAYS` (7), `ASK_EVERY_MS` (1 gün).

Test etmek (dahili uygulama paylaşımı, Internal app sharing):

1. Play Console → **Test et ve yayınla → Dahili uygulama paylaşımı**: açık
   olsun, telefondaki Google hesabı yükleyiciler/test edenler listesinde
   olsun.
2. Telefona önce düşük `versionCode`'lu bir Play paketini **dahili paylaşım
   bağlantısından** kur (aynı paket adı, aynı imza).
3. Daha yüksek `versionCode`'lu AAB'yi dahili paylaşıma yükle. Bağlantıyı
   telefonda aç ama Play sayfasında **Güncelle'ye basma**.
4. Shroudly'yi aç: kart ve Play'in penceresi çıkmalı. Günde bir sınırını
   yeniden denemek için uygulamanın verilerini sil ya da bir gün bekle.
5. Play Store'u olmayan bir telefonda ya da emülatörde Play paketi hiçbir şey
   göstermez; günlükte bir kez "Google Play gave no update information (-9)"
   (ya da -3, -10) yazar.

Lisans: kitaplık açık kaynak değildir; **Play Core Software Development Kit
Terms of Service** altındadır (https://developer.android.com/guide/playcore/license):
uygulamanın içinde dağıtılabilir, değiştirilemez. Getirdiği Play services
Basement/Tasks "Android Software Development Kit License", eski AndroidX
kitaplıkları (core, fragment, lifecycle...) Apache 2.0 altındadır. Hepsi
yalnızca Play paketindedir; uygulamanın açık kaynak bildirimlerinde
(Hakkında → "Açık kaynak") "In the copy from Google Play only" başlığıyla
listelenir. GitHub APK'sının bağımlılıkları değişmedi (yalnızca Kotlin'in
standart kitaplığı).

### 4b. Mağaza bayrağı (stores.json): puanlama kartı ve Play'e geçiş önerisi

Uygulama Play'de olduğu sürece, Play'den kurulan kopyanın ana penceresinde
arada bir küçük bir kart puan ister ("Help others find Shroudly", düğmesi
**Rate on Google Play**). Kart yalnızca Shroudly kullanıcının ülkesinde
gerçekten Play'deyken çıkar; bunu uygulamanın güncellenmesine gerek kalmadan
deponun kökündeki `stores.json` söyler:

    {
      "play": { "live": false, "countries": ["*"], "exclude": [] },
      "appStore": { "live": false, "countries": ["*"], "exclude": [] },
      "macAppStore": { "live": false, "countries": ["*"], "exclude": [] }
    }

- `live`: mağazada yayında mı. **Şu an `false`** (Play incelemesi sürüyor);
  onaylanınca `true` yap.
- `countries`: yayında olduğu ülkeler, ISO 3166-1 alfa-2 kodlarıyla
  (`"TR"`, `"DE"`...), ya da hepsi için `"*"`.
- `exclude`: yayında **olmadığı** ülkeler. `countries` `"*"` olsa bile bu
  ülkelerde kart çıkmaz.
- Eski biçim (`{ "play": { "live": true } }`) de okunur: `countries` yoksa
  `"*"`, `exclude` yoksa boş sayılır.

Android yalnızca `play` kısmını okur (diğerleri iOS ve macOS uygulamaları
için). Telefonun ülkesi şu sırayla bulunur: SIM kartın ülkesi, yoksa mobil
ağın ülkesi (SIM varken SIM'inki geçer, yurt dışında dolaşımda da), yoksa
telefonun dilinin bölgesi. Ülke bulunamazsa kart çıkmaz.

Uygulama dosyayı
`https://raw.githubusercontent.com/umutxyp/Shroudly/main/stores.json`
adresinden, koruma açıkken motor üzerinden (kapalıyken doğrudan), en fazla 12
saatte bir alır; alınamazsa bir saat sonra yeniden dener. Bir cevap bir hafta
geçerlidir. Dosya yoksa, alınamadıysa, okunamıyorsa ya da bir haftadır
alınamadıysa Play "yok" sayılır ve hiçbir kart çıkmaz (alınamayan ya da
okunamayan bir cevap, eldeki son cevabı da siler).

**Bir ülkede kaldırıldıysa** (örneğin oranın bir yasası yüzünden Play
uygulamayı o ülkede yayından kaldırdıysa, ya da o ülkede henüz
yayınlanmadıysa): `main` dalında `stores.json` içinde o ülkenin kodunu
`exclude` listesine ekle ve gönder, örneğin Vietnam için
`"exclude": ["VN"]`. Yalnızca birkaç ülkede yayındaysa `countries` listesine
yalnızca onları yaz (`"countries": ["TR", "AZ"]`).

**Tamamen kapatmak için** (uygulama Play'den kalkarsa, askıya alınırsa ya da
başka bir nedenle kimse Play'e gönderilmemeli): `"live": false` yap ve gönder
(ya da dosyayı sil). Kurulu uygulamalar en geç 12 saat içinde (o sırada açık
olmayan bir telefon için de en geç bir hafta içinde) kartları göstermeyi
bırakır. Yeniden açmak için `true` yap.

Kartın kuralları (`StoreCards.kt`, testleriyle): Play'in kurallarına uygun,
kullanıcının fikrini sormaz ve karşılığında bir şey vaat etmez; bildirim ya da
ekranı kapatan bir pencere değildir; uygulamanın bir çalışmasında en fazla bir
kez, başka bir kart (pil, bildirimler, güncelleme, destek) görünürken asla
çıkmaz. Yalnızca koruma açık ve çalışırken, uygulama en az 3 gündür kuruluyken
ve koruma en az 3 ayrı günde gerçekten çalışmışken çıkar. "Not now" (ya da
kartı başka bir yolla geçmek) bir "hayır" sayılır: sonraki en erken 14 gün,
sonra 28, 56, 112 gün sonra. **Rate on Google Play** Play'deki sayfayı açar
(uygulama içi değerlendirme arayüzü değil; onun kotası dokunuştan sonra hiçbir
şey göstermeyebilir) ve kart bir daha çıkmaz.

Aynı bayrakla, Play'den **kurulmamış** kopyalarda (GitHub APK'sı ya da başka
bir yerden kurulan) bir kez de Play'e geçme önerisi çıkar: "Shroudly is on
Google Play" ve "güncellemeleri Play'den otomatik al: oradaki Shroudly
sayfasında Kaldır'a, sonra Yükle'ye dokun; sonra korumayı yeniden aç;
değiştirdiğin ayarlar baştan başlar" (kaldırınca ayarlar gerçekten silinir,
bu yüzden böyle söylüyor). Düğmesi **Open Google Play**. Kurallar
(`StoreCards.kt`): en fazla iki kez (ilk "Not now"dan 30 gün sonra bir kez
daha, sonra hiç); **Open Google Play**'e dokunulduysa hiç. Yalnızca Play
kullanıcının ülkesinde yayındayken (yukarıdaki kurallar), Play Store
telefonda kurulu ve açıkken, "Block ads and trackers" kapalıyken (Play kopyasında
reklam engelleme yok; geçince kaybolurdu), koruma açık ve çalışırken,
uygulama en az 3 gündür kuruluyken ve koruma en az 2 ayrı günde çalışmışken.
Play'in kurduğu kopyada hiç çıkmaz. Pencere 3 gündür açılmadıysa öneri, ses
ve açılır pencere olmadan, düşük önemli bir bildirim olarak bir kez gelir
(bir gösterim sayılır); dokununca pencere kartla açılır.

## 5. Uygulama içeriği (App content) formları

Play Console → **Politika → Uygulama içeriği**. Hepsi doldurulmadan yayın
yapılamaz.

### 5a. Gizlilik politikası

URL:

    https://github.com/umutxyp/Shroudly#privacy

Uygulama içinde de aynı bağlantı var (Hakkında → "Privacy policy" /
"Gizlilik politikası").

### 5b. Uygulama erişimi (App access)

**"Tüm işlevler özel erişim gerektirmeden kullanılabilir"** (All
functionality is available without special access). Hesap ya da giriş yok.

### 5c. Reklamlar

**Hayır, uygulamamda reklam yok.**

### 5d. İçerik derecelendirmesi (Content rating)

- E-posta: iletişim adresi (`contact@codeshare.me`).
- Kategori: **Yardımcı Program, Üretkenlik, İletişim veya Diğer** (Utility,
  Productivity, Communication, or Other).
- Şiddet, cinsellik, küfür, kumar, uyuşturucu ve benzeri tüm sorulara:
  **Hayır**.
- Kullanıcıların birbiriyle iletişim kurması / içerik paylaşması: **Hayır**.
- Konum paylaşımı: **Hayır**. Dijital ürün satın alma: **Hayır**.
- Uygulama web tarayıcısı ya da arama motoru mu: **Hayır**.
- Beklenen sonuç: herkes için (Everyone / PEGI 3 / 3+).

### 5e. Hedef kitle

- Yaş grupları: **18 ve üzeri** (ya da 13 ve üzeri). 13 yaş altını **seçme**:
  Aileler politikası ile VPN birleşince inceleme çok zorlaşır.
- Uygulama çocuklara hitap ediyor mu: **Hayır**.

### 5f. Veri güvenliği (Data safety)

Uygulamanın bize gönderdiği tek şey **canlı kullanıcı sayımıdır** ve
masaüstüyle birebir aynıdır:

- **Ne gönderiliyor:** yalnızca `{"id":"<rastgele kimlik>"}`. Kimlik, koruma
  her başladığında yeniden üretilen rastgele bir UUID'dir; telefonda hiçbir
  yere yazılmaz, cihazdan, hesaptan ya da kullanıcıdan türetilmez. Telefonun
  modeli, Android sürümü ya da konumu gönderilmez: istek, başlıklarıyla
  birlikte (masaüstünün de gönderdiği sistem dili başlığı dahil) Windows'taki
  Shroudly'nin isteğinin aynısıdır, yani sunucu telefonu bilgisayardan
  ayıramaz.
- **Ne zaman:** yalnızca koruma açıkken, sunucunun istediği aralıkla (şu an
  dakikada bir); motorun üzerinden, HTTPS ile. Telefon uyurken (Doze)
  gönderilmez. Ayarlar → "Count me in the live total" kapatılırsa hiç
  gönderilmez (varsayılan: açık, masaüstündeki gibi).
- **Kimlikle ilişkilendirilmez:** hesap yok; sunucu erişim günlüğü tutmaz ve
  Cloudflare tüneli arkasında olduğu için IP adresini zaten görmez.
- **Saklanmaz:** sunucu yalnızca kimliği ve en son ne zaman görüldüğünü,
  sayım sürdükçe tutar (yeniden başlarken sayım kaybolmasın diye aynı listeyi
  diskine de yazar). Kimlik, Durdur'a basılınca hemen, uygulama sessizce
  kapanırsa birkaç dakika içinde silinir.

Formdaki cevaplar (temkinli beyan; kimlik kişisel olmasa da gönderildiği için
beyan ediyoruz):

| Soru | Cevap |
| --- | --- |
| Uygulama, gerekli kullanıcı verisi türlerinden herhangi birini topluyor ya da paylaşıyor mu? | **Evet** |
| Veri türü | **Cihaz veya diğer kimlikler** (Device or other IDs): yalnızca bu |
| Toplanıyor mu / paylaşılıyor mu? | Toplanıyor: **Evet**. Paylaşılıyor: **Hayır** (üçüncü tarafa gitmez) |
| Geçici olarak mı işleniyor (ephemeral)? | **Hayır** (sunucu sayım süresince tutuyor) |
| Zorunlu mu? | **İsteğe bağlı**: kullanıcı Ayarlar'dan kapatabilir |
| Amaç | **Analiz** (Analytics): kaç kopyanın çalıştığını saymak |
| Toplanan tüm veriler aktarım sırasında şifreleniyor mu? | **Evet** (HTTPS; DNS over HTTPS) |
| Kullanıcılar verilerinin silinmesini isteyebilir mi? | Hesap yok; kimlik Durdur'a basılınca ya da birkaç dakika içinde kendiliğinden silinir, ayarı kapatınca hiç gönderilmez; uygulama silinince telefondaki her şey silinir |
| Hesap oluşturma | Yok |

Bunun dışında Android uygulaması bize hiçbir şey göndermez: DNS sorguları ve
site bağlantıları kullanıcının kendi istediği trafiktir ve telefondan
doğrudan sitelere/çözücülere gider. Hangi tekniğin hangi sitede işe yaradığı
yalnızca telefonda, en fazla 30 gün tutulur ve yedeğe alınmaz. Play sürümü
GitHub'a güncelleme sorgusu bile yapmaz. Çökme raporu, analiz ve reklam
kitaplığı yok.

Play sürümü güncellemeyi telefondaki Google Play Store uygulamasına sorar
(uygulama içi güncelleme, 4a). Bu istek bize değil, Google Play'e gider.
Google'ın bu kitaplık için açıkladığı: toplanan veriler cihaz meta verileri,
uygulama sürümü ve yüklü modül/varlık paketleri listesi; amaç güncelleme olup
olmadığını ve boyutunu bulmak; aktarımda şifreli; üçüncü taraflarla
paylaşılmaz; belirli bir saklama süresinden sonra silinir
(https://developer.android.com/guide/playcore/in-app-updates, "Data safety").
Google, formdaki cevaplardan yalnızca geliştiricinin sorumlu olduğunu
söylüyor: formu doldururken bu satırları da gözden geçir. (İleride bir çökme
raporu gönderilirse "Uygulama bilgileri ve performans → Çökme günlükleri"
olarak beyan edilmeli.)

### 5g. VPN beyanı (VpnService declaration)

Uygulama içeriği altında "VpnService" / "VPN service" beyanı çıkar.
Kategori olarak **VPN uygulamanın temel işlevi** (VPN is the core
functionality) seçeneğini seç. Açıklama alanına şunu (İngilizce) yapıştır:

```
Shroudly's core function is getting around network-level censorship (DPI
filtering) on the user's own device. It uses VpnService only to build a
local, on-device tunnel: the VPN interface hands the device's connections to
Shroudly's own engine, which runs inside the app on 127.0.0.1. There is no
remote VPN server. No traffic is sent to any server operated by us; every
connection goes from the device directly to the site or service the user's
app contacts. The only request the app itself sends to us is an optional,
anonymous online count while the tunnel is on: a random id made fresh for
each session (never stored on the device), which the user can turn off in
Settings.

The tunnel endpoint is on the device itself, so data from the device to the
endpoint never leaves the device. Traffic that leaves the device stays
encrypted by the apps' own TLS, and the app sends DNS queries encrypted (DNS
over HTTPS) to public resolvers.

The engine only changes how the device's own TCP/TLS packets are split and
ordered (for example, sending the TLS ClientHello in several segments) so
that a DPI filter cannot match them. It does not decrypt, read, store or
modify the contents of any connection, does not inject or block ads, and
does not redirect or manipulate traffic for monetization.

The tunnel is started only by the user (the Start button, the Quick Settings
tile, or Android's Always-on VPN setting) after Android's VPN consent dialog,
and is stopped from the app or its ongoing notification. No personal or
sensitive user data is collected or shared. Source code:
https://github.com/umutxyp/Shroudly
```

VPN kullanımı değişirse (ör. uzak sunucu eklenirse) beyan yeniden
gönderilmeli.

### 5h. Ön plan servisi (Foreground service) beyanı

Hedef API 34+ olduğu için kullanılan ön plan servis türleri beyan edilir.
Shroudly iki tür kullanır: VPN modunda **`systemExempted`** (Android'in VPN
uygulamalarına verdiği tür), "Yalnızca proxy" modunda **`specialUse`**. Form
türleri soruyorsa ikisini de seç. `systemExempted` için açıklama gerekiyorsa:

```
The VPN service (ShroudlyVpnService) runs in the foreground while the user's
VPN is on, with an ongoing notification and a Stop action. It starts only
when the user turns protection on (or Android's Always-on VPN starts it) and
after the user has accepted Android's VPN consent dialog. Stopping it ends
the VPN at once, so the user's apps connect directly again.
```

Video istenirse (kısa, ekran kaydı): uygulamayı aç → "Start protection" →
Android'in VPN izin penceresi → "OK" → bildirimde süren "Protected"
bildirimi → bildirimdeki "Stop" ile durdurma.

`specialUse` elle incelenir: Play bir gerekçe ve video ister. Neden bu tür:
"Yalnızca proxy" modunda VPN yoktur (kullanıcının başka VPN uygulaması bağlı
kalsın diye), bu yüzden `systemExempted` kullanılamaz; servis kullanıcı
açık tuttuğu sürece çalışmalıdır, `dataSync` ise Android 15'te günde 6 saatle
sınırlıdır; listedeki diğer türler (konum, medya, cihaz bağlantısı...) yerel
bir proxy'yi tanımlamaz. Manifestteki alt tür
(`PROPERTY_SPECIAL_USE_FGS_SUBTYPE`) aşağıdaki ilk cümleyle aynıdır. Gerekçe:

```
"Proxy only" mode (Settings, off by default): a local proxy on 127.0.0.1
that other apps on this device send their connections through, chosen by
the user instead of the VPN so that another VPN app can stay connected. It
is not a VPN, so systemExempted does not apply, and it has to run for as
long as the user keeps protection on, which dataSync (6 hours a day on
Android 15) does not allow. It starts only when the user turns protection
on, shows an ongoing notification with a Stop action, listens on 127.0.0.1
only (no other device can reach it), and stops when the user turns it off.
```

Video: Ayarlar → Mod → "Proxy only" → ana ekranda "Start protection"
(VPN izin penceresi çıkmaz) → bildirimde "Proxy only: apps set to use
127.0.0.1:10808..." → Wi-Fi ağının proxy ayarına 127.0.0.1 / 10808 yazılır →
tarayıcıda bir sayfa açılır → bildirimdeki "Stop".

### 5i. Diğer formlar

- Haber uygulaması: **Hayır**. Devlet uygulaması: **Hayır**.
- Finansal özellikler: **Yok**. Sağlık: **Yok**.
- Hassas izinler: yok. (`QUERY_ALL_PACKAGES`, `REQUEST_INSTALL_PACKAGES`,
  konum, kişiler vb. kullanılmıyor. Bunlar eklenmemeli.)

## 6. Mağaza girişi (Store listing)

Kurallar:

- Başlıkta ya da simgede "VPN" kelimesini, uzak sunucu / gizlilik / anonimlik
  çağrıştıracak şekilde kullanma. Shroudly IP adresini gizlemez.
- "Her şeyi açar", "tamamen anonim" gibi iddialar yazma.
- Ekran görüntülerinde ve simgede Discord, Roblox gibi başka markaların
  logolarını kullanma.
- Açıklamada VpnService kullanımı açıkça yazmalı (aşağıdaki taslaklarda var).

### English (en-US)

**App name:** `Shroudly`

**Short description** (80 characters at most):

    Gets past DPI filters that block sites and apps. Runs on your phone, no server.

**Full description:**

```
Shroudly helps you reach websites and apps that your network blocks with
deep packet inspection (DPI). It runs entirely on your phone: there is no
Shroudly VPN server, no account and no sign-up.

How it works
Android lets an app handle other apps' connections only as a VPN, so Shroudly
uses Android's VpnService to create a local, on-device tunnel. Your apps'
connections go to Shroudly's engine inside the app, which changes only how
the packets are split and ordered so that a DPI filter cannot recognise them,
and then go straight to the site, as they would without Shroudly. Nothing is
sent through a server of ours, and the contents of your connections are not
read or changed. DNS lookups are sent over encrypted DNS (DNS over HTTPS).

Shroudly is not a privacy or anonymity VPN: it does not hide your IP address
or your location.

Features
- One tap to start and stop, plus a Quick Settings tile
- Works for every app: browsers, chat apps, games
- Encrypted DNS with several public resolvers, picked automatically
- Remembers on your phone which technique worked for a site, for faster
  starts
- Works with Android's Always-on VPN setting
- 31 languages
- Free and open source: https://github.com/umutxyp/Shroudly

Good to know
- Android allows one VPN at a time, so another VPN app and Shroudly cannot be
  on together.
- Some blocks (for example a site that is down, or an IP address that is
  blocked outright) cannot be fixed by reshaping connections.
- While protection is on, the app joins an anonymous live count of running
  copies (a random id that changes every session, nothing else). You can
  turn it off in Settings.

Privacy: https://github.com/umutxyp/Shroudly#privacy
```

### Türkçe (tr-TR)

**Uygulama adı:** `Shroudly`

**Kısa açıklama** (en fazla 80 karakter):

    Siteleri ve uygulamaları engelleyen DPI filtrelerini aşar. Sunucusuz, telefonda.

**Tam açıklama:**

```
Shroudly, ağınızın derin paket incelemesi (DPI) ile engellediği sitelere ve
uygulamalara ulaşmanızı sağlar. Tamamen telefonunuzda çalışır: Shroudly VPN
sunucusu, hesap ya da üyelik yoktur.

Nasıl çalışır?
Android, bir uygulamanın diğer uygulamaların bağlantılarını yalnızca VPN
olarak ele almasına izin verir. Bu yüzden Shroudly, Android'in VpnService
özelliğiyle telefonun içinde yerel bir tünel kurar. Uygulamalarınızın
bağlantıları uygulamanın içindeki Shroudly motoruna gelir; motor yalnızca
paketlerin nasıl bölündüğünü ve sıralandığını değiştirir, böylece DPI
filtresi onları tanıyamaz. Bağlantılar sonra, Shroudly yokmuş gibi doğrudan
siteye gider. Hiçbir trafik bizim bir sunucumuzdan geçmez ve bağlantılarınızın
içeriği okunmaz ya da değiştirilmez. DNS sorguları şifreli DNS (DNS over
HTTPS) ile gönderilir.

Shroudly bir gizlilik ya da anonimlik VPN'i değildir: IP adresinizi ya da
konumunuzu gizlemez.

Özellikler
- Tek dokunuşla başlatma ve durdurma, Hızlı Ayarlar kutucuğu
- Her uygulamada çalışır: tarayıcılar, sohbet uygulamaları, oyunlar
- Birden çok genel çözücüyle, otomatik seçilen şifreli DNS
- Bir sitede hangi tekniğin işe yaradığını telefonunuzda hatırlar, sonraki
  açılışlar daha hızlı olur
- Android'in "Her zaman açık VPN" ayarıyla çalışır
- 31 dil
- Ücretsiz ve açık kaynak: https://github.com/umutxyp/Shroudly

Bilmenizde yarar var
- Android aynı anda tek bir VPN'e izin verir; başka bir VPN uygulaması ile
  Shroudly birlikte açık olamaz.
- Bazı engeller (örneğin kapalı bir site ya da doğrudan engellenmiş bir IP
  adresi) bağlantıların biçimini değiştirerek aşılamaz.
- Koruma açıkken uygulama, çalışan kopyaların anonim canlı sayımına katılır
  (her oturumda değişen rastgele bir kimlik, başka hiçbir şey). Ayarlar'dan
  kapatabilirsiniz.

Gizlilik: https://github.com/umutxyp/Shroudly#privacy
```

Grafikler: 512×512 simge, 1024×500 öne çıkan görsel, en az 2 telefon ekran
görüntüsü (uygulamanın kendi ekranı; başka markaların logoları görünmesin).

## 7. Ülkeler

Üretim → **Ülkeler / bölgeler**: ülkeleri bilerek seç. Bazı ülkelerde
yetkililer VPN uygulamalarının kaldırılmasını isteyebilir ve Google bunu
uygular; bu durumda yalnızca o ülkede listeden kalkar, GitHub APK'sı
etkilenmez.

## 8. Geliştirici doğrulaması (developer verification)

Google, sertifikalı Android cihazlarda Play dışından (APK olarak) kurulan
uygulamaların da kayıtlı bir geliştiriciye ait olmasını şart koşuyor:
2026-09-30'dan beri Brezilya, Endonezya, Singapur ve Tayland'da, 2027'de tüm
dünyada. Play Console'da oluşturulan uygulamalar otomatik kaydedilir; aynı
anahtarla imzalanan GitHub APK'sı da bu kayıttan yararlanır.

Uygulama oluşturulup ilk paket yüklendikten sonra Play Console **Ana sayfa**'da
`me.codeshare.shroudly` paketinin **kayıtlı** (registered) göründüğünü
kontrol et.

## 9. Sıra (özet)

1. D-U-N-S ile kuruluş hesabı.
2. Uygulamayı oluştur (`Shroudly`, ücretsiz).
3. Uygulama imzalama: mevcut anahtarı PEPK ile yükle (3a, 3b). Google'ın
   anahtar üretmesine izin verme.
4. Yükleme anahtarını üret, sertifikasını yükle, GitHub secret'larını ekle
   (3c).
5. Uygulama içeriği formları: gizlilik politikası, erişim, reklam,
   derecelendirme, hedef kitle, veri güvenliği, VPN beyanı, ön plan servisi
   beyanı (5).
6. Mağaza girişi: İngilizce ve Türkçe metinler, grafikler (6).
7. Ülkeler (7).
8. Yeni bir sürüm etiketi → Release workflow → `play-bundle` artifact'ı →
   dahili teste yükle (4).
9. Ana sayfada paket kaydını kontrol et (8).
10. Dahili test sorunsuzsa kapalı test, sonra üretim.
11. Uygulama içi güncellemeyi dahili uygulama paylaşımıyla bir kez dene;
    acil sürümler için öncelik (API ve hizmet hesabı) gerekecekse ilk acil
    sürümden önce kur (4a).
