# Shroudly'yi App Store ve Mac App Store'a koymak (sahibin adımları)

Bu dosya, Apple Developer hesabı (CODESHARE TECHNOLOGY LTD) onaylandıktan
sonra Shroudly'nin iPhone/iPad ve Mac sürümünü yayınlamak için elle
yapılacak işleri sırayla anlatır. Kod tarafı hazır:

- Uygulama, paket tüneli (VPN eklentisi), motor (`core/`) ve
  hev-socks5-tunnel `apple/` altında; imzasız olarak iOS simülatörü, iOS
  cihaz ve macOS için derleniyor, birim testleri CI'da her push'ta
  çalışıyor (`.github/workflows/test.yml`, `apple` işi).
- Mağaza kuralları Play kopyasındaki gibi uygulanmış: reklam/izleyici
  engelleme yok, bağış bağlantısı yok (Apple kuralı 3.1.1), güncelleme
  denetimi yok (App Store günceller), puan isteği yalnızca Apple'ın kendi
  penceresiyle (kural 5.6.1) ve yalnızca uygulama mağazada yayındayken
  (`stores.json`, 7. adım).
- Gizlilik bildirimi (`PrivacyInfo.xcprivacy`), şifreleme beyanı
  (`ITSAppUsesNonExemptEncryption = NO`), ilk açılışta "veri toplanmıyor"
  ekranı (VPN uygulamaları için kural 5.4), simgeler ve 31 dil hazır.

Kalan iş: takım kimliğini yazmak, Xcode'a hesabı tanıtmak, cihazda denemek,
App Store Connect'te uygulamayı açıp formları doldurmak ve yüklemek.

## 0. Değişmeyecek kurallar

- **Paket kimlikleri:** `me.codeshare.shroudly` (uygulama) ve
  `me.codeshare.shroudly.tunnel` (VPN eklentisi). İlk yüklemeden sonra
  değiştirilemez; Android'deki paket adıyla aynı.
- **Kuruluş hesabı şart.** Apple, VPN sunan uygulamaları yalnızca kuruluş
  (Organization) olarak kayıtlı geliştiricilerden kabul eder (kural 5.4).
  Bu yüzden uygulama kişisel bir hesapla değil, CODESHARE TECHNOLOGY LTD
  hesabıyla yayınlanmalı.
- **Tek kayıt, iki platform:** iOS ve macOS aynı paket kimliğini kullanır;
  App Store Connect'te tek uygulama kaydı açılır (Universal Purchase).

## 1. Takım kimliğini (Team ID) yaz

1. developer.apple.com → Account → **Membership details** → Team ID
   (10 karakter, örn. `AB12CD34EF`).
2. `apple/Config/Signing.xcconfig` içinde:

       DEVELOPMENT_TEAM = AB12CD34EF

   Commit et. (Takım kimliği gizli değildir; her imzalı uygulamada
   görünür. İstenirse commit etmeden `Config/Signing.local.xcconfig`
   dosyasına da yazılabilir; o dosya git'e girmez.)
3. Mac'teki uygulama grubu takım kimliğinden kendiliğinden oluşur
   (`<TeamID>.me.codeshare.shroudly`); iPhone'daki `group.me.codeshare.shroudly`.

## 2. Xcode'a hesabı tanıt, kimlikler kendiliğinden açılsın

1. Xcode → Settings → **Accounts** → + → Apple ID (hesap sahibinin ya da
   takımda Admin/App Manager rolü olan birinin).
2. `apple/Shroudly.xcodeproj` dosyasını aç. Shroudly ve ShroudlyTunnel
   hedeflerinde **Signing & Capabilities** sekmesinde takım görünmeli,
   "Automatically manage signing" açık olmalı. Xcode şunları kendisi
   oluşturur:
   - App ID `me.codeshare.shroudly` ve `me.codeshare.shroudly.tunnel`,
     ikisinde de **Network Extensions** (Packet Tunnel) ve **App Groups**;
   - App Group `group.me.codeshare.shroudly`;
   - geliştirme sertifikası ve profiller.
3. Kırmızı hata çıkarsa "Try Again"e bas. Elle yapmak gerekirse aynı
   kimlikleri developer.apple.com → Certificates, Identifiers & Profiles →
   Identifiers'tan aç ve aynı yetenekleri işaretle. Packet Tunnel için
   artık Apple'dan özel izin istemek gerekmiyor.

Dağıtım sertifikaları (Apple Distribution; Mac için ayrıca Mac Installer
Distribution) ve App Store profilleri, 6. adımda Organizer'ın "Distribute
App" akışında bulutta kendiliğinden oluşturulur.

## 3. Sürüm

Sürüm `package.json`'dan gelir (Android'deki gibi). Her yüklemeden önce:

    node apple/scripts/gen-version.js

Bu `apple/Config/Version.xcconfig` dosyasını yazar (git'e girmez):
`2.6.44`, yapı numarası `20644` (Android'in versionCode'u ile aynı). Aynı
sürüm ikinci kez yüklenecekse (ör. reddedilen bir yapı), yapı numarasına
bir parça ekle: Xcode'da Shroudly hedefinin Build Settings'inde
`CURRENT_PROJECT_VERSION = 20644.1`, ya da komut satırında
`xcodebuild ... CURRENT_PROJECT_VERSION=20644.1`.

## 4. Önce cihazda dene

Paket tüneli simülatörde ve imzasız çalışmaz; ilk kez gerçek cihazda
denenir.

1. Kaynaktan bir kez: `node apple/scripts/fetch-hev.js`,
   `apple/scripts/build-hev.sh`, `node apple/scripts/gen-strings.js`,
   `node apple/scripts/gen-version.js`.
2. iPhone'u Mac'e bağla (Ayarlar → Gizlilik ve Güvenlik → Geliştirici
   Modu açık olmalı). Xcode'da şema **Shroudly**, hedef iPhone → Run.
3. Büyük düğmeye bas → "Başlamadan önce" ekranı → Devam → iOS'un "VPN
   yapılandırması eklemek istiyor" sorusuna **İzin Ver**.
4. Kontrol listesi:
   - durum "Korunuyor" olur; Ayarlar → VPN'de Shroudly bağlı görünür;
   - Safari ve diğer uygulamalar çalışır; engelli bir ağda engelli bir site
     açılır;
   - düğmeye tekrar basınca durur ve her şey doğrudan çalışır;
   - Ayarlar → "Korumayı açık tut" açıkken telefonu yeniden başlat:
     koruma kendiliğinden açılır; Durdur'a basınca bir daha açılmaz;
   - Hakkında → "Share logs" paylaşım ekranını açar;
   - **bellek:** Xcode → Debug → Attach to Process → ShroudlyTunnel, sonra
     Debug Navigator → Memory; birkaç sekmede video/ağır sayfa açıkken
     50 MB'ın altında kalmalı (iOS bu sınırı aşan VPN eklentisini kapatır).
5. Mac: hedef **My Mac** → Run; ilk Start'ta macOS da VPN yapılandırması
   için izin ister. Sistem Ayarları → VPN'de Shroudly görünür.

## 5. App Store Connect'te uygulamayı aç

appstoreconnect.apple.com → Apps → **+** → New App:

- Platforms: **iOS** ve **macOS** (ikisi birlikte)
- Name: `Shroudly` (alınmışsa `Shroudly - DPI Bypass`)
- Primary Language: English (U.S.)
- Bundle ID: `me.codeshare.shroudly`
- SKU: `shroudly`
- User Access: Full Access

Sonra:

- **App Information:** Category **Utilities** (ikincil: Productivity).
  Content Rights: üçüncü taraf içerik yok.
- **Pricing and Availability:** Free. Ülkeler: hepsi. Apple bazı ülkelerin
  (ör. Çin anakarası) mağazasında lisanssız VPN uygulamalarına izin vermez;
  Çin anakarasını listeden çıkarmak reddi önler. Hangi ülkelerde kalacağı
  sahibin kararı (10. adım).
- **App Privacy:**
  - Privacy Policy URL: `https://github.com/umutxyp/Shroudly#privacy`
  - Data Collection: **"No, we do not collect data from this app"**.
    Gerekçe: hesap yok, analitik/reklam/izleyici yok; bağlantılar cihazdan
    doğrudan siteye gider; loglar yalnızca kullanıcı "Share logs" ile
    kendisi paylaşırsa gider; DNS sorguları anlık hizmet için genel
    çözümleyicilere (Cloudflare, Google, AdGuard, OpenDNS, DNS.SB) şifreli
    gider, bizde tutulmaz. Uygulama yalnızca GitHub'dan `stores.json`
    dosyasını okur, hiçbir şey göndermez.
- **Age Rating:** anketin hepsi "None"/"No" → 4+. ("Unrestricted Web
  Access" hayır: Shroudly bir tarayıcı değil.)
- **Export Compliance (şifreleme):** Info.plist'te
  `ITSAppUsesNonExemptEncryption = NO` var, App Store Connect her yüklemede
  sormaz. Gerekçe: uygulama yalnızca Apple'ın işletim sistemindeki
  şifrelemeyi kullanır (şifreli DNS için URLSession üzerinden HTTPS);
  motor kendi şifrelemesini yapmaz, tünel şifreli değildir (cihaz içinde,
  sunucu yok). Fransa beyanı vb. gerekmez.
- **App Review Information:** Sign-in required: **hayır**. İletişim
  bilgileri (ad, telefon, e-posta). Notes: 8. adımdaki metin.
- **Version Information:** 9. adımdaki metinler ve ekran görüntüleri.

## 6. Yükle

1. `node apple/scripts/gen-version.js`
2. Xcode'da hedef **Any iOS Device (arm64)** → Product → **Archive** →
   Organizer → **Distribute App** → App Store Connect → Upload. (İlk
   seferde Apple Distribution sertifikası ve profiller burada oluşur.)
3. Hedef **Any Mac** → Product → Archive → Distribute App → App Store
   Connect → Upload. (Mac Installer Distribution sertifikası da burada
   oluşur.)
4. Yapılar App Store Connect'te "Processing"den çıkınca önce **TestFlight**
   ile kendine dağıt ve 4. adımdaki listeyi TestFlight kopyasıyla tekrarla.
5. iOS ve macOS sürüm sayfalarında yapıyı seç → **Add for Review** →
   **Submit**. İki platform ayrı ayrı incelenir.

## 7. Yayından sonra: puan bayrağı (`stores.json`)

Uygulama puanı yalnızca mağaza sayfası yayındayken ister (Apple'ın kendi
penceresiyle, kullanıcı 3 gündür yüklüyse, koruma 3 farklı günde başarıyla
açıldıysa ve şu an açık ve çalışıyorsa; sonra 14, 28, 56, 112... gün
arayla, oturum başına en fazla bir kez). Bayrak deponun kökündeki
`stores.json` dosyasıdır ve uygulama onu `main` dalından okur:

    { "play": { "live": true }, "appStore": { "live": false }, "macAppStore": { "live": false } }

- iOS sürümü yayına çıkınca `"appStore": { "live": true }`,
- Mac sürümü yayına çıkınca `"macAppStore": { "live": true }`

yapıp `main`'e gönder. Uygulama en geç 12 saat içinde görür. Yayından önce
`true` yapma: inceleme kopyası ya da bekleyen bir sürüm boşuna sorar.

## 8. App Review notları (İngilizce, olduğu gibi yapıştır)

```
Shroudly is a free, open-source tool that helps people reach websites and
apps that their network blocks with deep packet inspection (DPI). It uses
NEPacketTunnelProvider only to create a local, on-device tunnel: there is no
VPN server, no account and no sign-in.

Other apps' connections are handed to Shroudly's engine inside the packet
tunnel extension. The engine changes only how the first packets of a
connection are split and ordered, so that a DPI filter does not recognise
them, and then connects straight to the destination. No traffic is routed to
a server of ours, and the contents of connections are not read, stored or
changed. DNS lookups are made with DNS over HTTPS to public resolvers
(Cloudflare, Google, AdGuard, OpenDNS, DNS.SB).

The app collects no user data and has no analytics, ads or tracking. Before
the VPN configuration is first added, a screen explains what it is for and
that nothing is collected (guideline 5.4). The app is published by CODESHARE
TECHNOLOGY LTD, enrolled as an organization.

How to review: open the app, tap the large round button, tap Continue on the
notice and allow the VPN configuration. The status changes to "Protected";
use the device as usual, everything keeps working. Tap the button again to
stop. Settings offers the technique (Auto is recommended), turning QUIC or
IPv6 off, and keeping protection on (on demand). On a network without DPI
filtering, as in Apple's offices, the visible effect is only that everything
keeps working while protected; the techniques matter on networks that block
sites by DPI.

Source code: https://github.com/umutxyp/Shroudly (MIT license)
Privacy policy: https://github.com/umutxyp/Shroudly#privacy
```

## 9. Mağaza metinleri

**Ekran görüntüleri:** iPhone 6.9" (1320×2868), iPad 13" (2064×2752) ve
Mac (2880×1800 ya da 1440×900). Ekranlar simülatörde de açılır (koruma orada
başlamaz ama ana ekran, Ayarlar ve Hakkında çekilebilir); "Korunuyor"
ekranı için cihazdan çek.

**Support URL:** `https://github.com/umutxyp/Shroudly/issues` ·
**Marketing URL:** `https://github.com/umutxyp/Shroudly` ·
**Copyright:** `2026 CODESHARE TECHNOLOGY LTD`

### English (U.S.)

**Subtitle** (30): `Bypass DPI blocks, no server`

**Promotional text** (170):

    Reach sites and apps your network blocks with DPI. Runs on your device, with no server, no account and no data collected. Free and open source.

**Keywords** (100): `dpi,bypass,censorship,unblock,blocked sites,dns,doh,encrypted dns,firewall,filter,proxy,tunnel`

**Description:**

```
Shroudly helps you reach websites and apps that your network blocks with
deep packet inspection (DPI). It runs entirely on your device: there is no
Shroudly VPN server, no account and no sign-up.

How it works
iOS and macOS let an app handle other apps' connections only as a VPN, so
Shroudly adds a VPN configuration to create a local, on-device tunnel. Your
apps' connections go to Shroudly's engine on your device, which changes only
how the packets are split and ordered so that a DPI filter cannot recognise
them, and then go straight to the site, as they would without Shroudly.
Nothing is sent through a server of ours, and the contents of your
connections are not read or changed. Names are looked up over encrypted DNS
(DNS over HTTPS).

Shroudly is not a privacy or anonymity VPN: it does not hide your IP address
or your location.

Features
- One tap to start and stop
- Works for every app: browsers, chat apps, games
- Encrypted DNS with several public resolvers, picked automatically
- Keep protection on: it comes back by itself after a restart
- 31 languages
- No data collected, no ads, no account
- Free and open source: https://github.com/umutxyp/Shroudly

Good to know
- One VPN can be on at a time, so another VPN app and Shroudly cannot be on
  together.
- Some blocks (for example a site that is down, or an IP address that is
  blocked outright) cannot be fixed by reshaping connections.

Privacy: https://github.com/umutxyp/Shroudly#privacy
```

### Türkçe

**Alt başlık** (30): `DPI engellerini aş, sunucusuz`

**Tanıtım metni** (170):

    Ağının DPI ile engellediği site ve uygulamalara ulaş. Cihazında çalışır; sunucu yok, hesap yok, veri toplanmaz. Ücretsiz ve açık kaynak.

**Anahtar kelimeler** (100): `dpi,engel,sansür,erişim,engelli site,dns,doh,şifreli dns,güvenlik duvarı,filtre,proxy,tünel`

**Açıklama:**

```
Shroudly, ağının derin paket incelemesiyle (DPI) engellediği sitelere ve
uygulamalara ulaşmanı sağlar. Tamamen cihazında çalışır: Shroudly'nin VPN
sunucusu yoktur, hesap ya da kayıt gerekmez.

Nasıl çalışır
iOS ve macOS, bir uygulamanın diğer uygulamaların bağlantılarını yalnızca
VPN olarak taşımasına izin verir; bu yüzden Shroudly cihaz içinde kalan bir
tünel için bir VPN yapılandırması ekler. Uygulamalarının bağlantıları
cihazındaki Shroudly motoruna gelir; motor yalnızca paketlerin nasıl
bölündüğünü ve sıralandığını değiştirir, böylece DPI filtresi onları
tanıyamaz; bağlantılar sonra Shroudly yokmuş gibi doğrudan siteye gider.
Hiçbir şey bizim bir sunucumuzdan geçmez, bağlantılarının içeriği okunmaz
ve değiştirilmez. Adlar şifreli DNS (DNS over HTTPS) ile sorgulanır.

Shroudly bir gizlilik ya da anonimlik VPN'i değildir: IP adresini ya da
konumunu gizlemez.

Özellikler
- Tek dokunuşla aç, kapat
- Her uygulamada çalışır: tarayıcılar, mesajlaşma, oyunlar
- Birkaç genel çözümleyiciyle şifreli DNS, kendiliğinden seçilir
- Korumayı açık tut: yeniden başlatmadan sonra kendiliğinden açılır
- 31 dil
- Veri toplanmaz, reklam yok, hesap yok
- Ücretsiz ve açık kaynak: https://github.com/umutxyp/Shroudly

Bilmekte fayda var
- Aynı anda tek bir VPN açık olabilir; başka bir VPN uygulamasıyla Shroudly
  birlikte açık olamaz.
- Bazı engeller (örneğin kapalı bir site ya da tamamen engellenmiş bir IP
  adresi) bağlantıları yeniden biçimlendirerek aşılamaz.

Gizlilik: https://github.com/umutxyp/Shroudly#privacy
```

## 10. Sahibin vereceği kararlar

1. **Şifreleme beyanı:** `ITSAppUsesNonExemptEncryption = NO` (yalnızca
   işletim sisteminin şifrelemesi) doğru kabul edildi. Farklı düşünülürse
   `apple/Config/App-Info.plist` ve `Tunnel-Info.plist` içindeki değer
   kaldırılır ve App Store Connect'teki anket doldurulur.
2. **Veri toplama:** "Data Not Collected" önerildi (5. adım).
3. **Ülkeler:** Çin anakarası (ve Apple'ın VPN'e izin vermediği başka
   ülkeler) dışarıda bırakılsın mı.
4. **iPad:** uygulama iPad'i de destekliyor (iPad ekran görüntüleri
   gerekir). Yalnızca iPhone istenirse `TARGETED_DEVICE_FAMILY = 1`
   (`Config/Shroudly.xcconfig`).
5. **Mac:** iOS ile birlikte mi, sonra mı yayınlanacak (tek kayıt; Mac sürüm
   sayfası ayrıca gönderilir).
6. **Ad:** "Shroudly" App Store'da alınmışsa yedek ad.

## 11. Sıra (özet)

1. Team ID → `Config/Signing.xcconfig` (1)
2. Xcode'a hesap; imza kendiliğinden (2)
3. `gen-version.js`, cihazda deneme ve bellek kontrolü (3, 4)
4. App Store Connect kaydı, gizlilik, yaş, şifreleme, inceleme notu (5, 8)
5. Metinler ve ekran görüntüleri (9)
6. Archive → Upload → TestFlight → Submit (6)
7. Yayına çıkınca `stores.json` → `live: true` (7)
