# Passo Bot (UI’sız) Geliştirme Planı

Bu plan, mevcut `passo-nodejs` kod tabanını **UI yazmadan** (HTTP API + config dosyaları + loglar) büyütmek için fazlara ayrılmış bir yol haritasıdır. Amaç: çoklu hesap, güvenilir sepet/transfer, üyelik yönetimi, raporlama ve operasyonel dayanıklılık.

## Varsayımlar / Mevcut Durum
- Çoklu hesap modu mevcut: `aAccounts[]` (holding) ve `bAccounts[]` (receiver) ile A’lar paralel, B’ler hazırlık + `A[i] -> B[i]` transfer.
- Transfer yaklaşımı: A sepetten çıkarır, B aynı `seatId`’yi yakalamaya çalışır (exact pick), olmazsa random fallback.
- `audit.log` mevcut ve runId bazlı korelasyon yapılabiliyor.
- Proxy parametreleri request ile alınabiliyor.

## Geliştirme Sınıflandırması (Passo akışını bilmek gerekir mi?)

### A) Passo UI/akışını **bilmeden** yapılabilenler (altyapı/operasyon)
- **Stabilite ve kaynak yönetimi**
  - Windows `EPERM` tmp cleanup hatasını “fail-soft” yapmak
  - Browser yaşam döngüsü: düzgün close/kill, timeout yönetimi, yeniden başlatma politikası
- **Konfigürasyon / çalışma şekli**
  - Profil dosyaları (run profile), override mantığı
  - Üyelik/proxy/payment profilini dosyadan veya storage’dan çekme
- **Loglama / raporlama / izlenebilirlik**
  - `audit.log` şemasını standartlaştırma
  - Run summary JSON üretme (API response / dosyaya yazma)
  - Hata sınıflandırma (error code -> aksiyon matrisi)
- **Üyelik havuzu yönetimi**
  - Hesap CRUD (dosya/SQLite), disable/blacklist
  - Proxy havuzu (round-robin/random), A/B ayrı politika

Bu sınıfın ana fazları: **Faz 0, Faz 1, Faz 2, Faz 5, Faz 6**.

### B) Passo UI/akışını **bilmeden yapılamayan** (keşif/selector/ekran şart)
- **Yeni ekran adımları ekleme**
  - TC/Pasaport “tanımlama/atama” ekranı otomasyonu
  - Transfer geri çekme (undo) ekranı
  - Otomatik ödeme (kart formu + 3DS/OTP varyasyonları)
- **Etkinlik özelinde değişen akışlar**
  - Öncelikli satış tipleri (Kongre No/Bilet Kodu vs Taraftar Kart/TC) ve ilgili form/checkbox adımları
  - Adet seçimi, kampanya akışları, modal/uyarı varyasyonları
- **Koltuk seçim UX değişiklikleri**
  - Seatmap DOM/iframe/canvas değişince yeni tespit ve tıklama stratejileri

Bu sınıfın ana fazları: **Faz 3 ve Faz 4** (kısmen Faz 0.2 de UI gecikmelerine bağlı olarak gözlem gerektirebilir).

## Hedef Kullanım (UI olmadan)
- Operatör bir **tek API** ile “run” başlatır.
- Üyelikler, ödeme profilleri, proxy havuzu, takım/etkinlik profilleri **dosya veya basit storage** üzerinden yönetilir.
- Sonuçlar `audit.log` + “run summary” JSON çıktısı ile izlenir.

---

# Faz 0 — Stabilizasyon (Mevcut akışı sağlamlaştır)
**Çıktı**: daha az crash, daha az flake, daha iyi retry/backoff.

## 0.1 Windows EPERM / Chrome tmp cleanup
- `chrome-launcher` tmp cleanup (`lighthouse.*`) hatalarında süreci kırmadan devam.
- Alternatif tmp dizini desteği (env ile) veya cleanup hatalarını “warn” seviyesine indir.

## 0.2 A tarafı “SEAT_SELECTION_FAILED_A” iyileştirme
- `pickRandomSeatWithVerify` doğrulama bekleme süresini konfige bağla.
- “click oldu ama basket read gecikti” senaryosu için:
  - verify window uzat (örn 4s -> 10-15s)
  - kısa retry (yeniden verify / gerekirse re-click stratejisi)

## 0.3 Harici log servisi hatası
- 127.0.0.1:8000 gibi harici sink başarısızsa:
  - feature flag ile kapat
  - ya da “warn”a düşür (run’ı bozmasın)

## 0.4 Multi-mode smoke test
- 3 A + 2 B ile test:
  - 2 transfer + 1 holdingOnly beklenen sonuç
  - audit log’da her run için tutarlılık

---

# Faz 1 — Konfigürasyon & Operasyon (UI’sız kontrol katmanı)
**Çıktı**: Tek bir endpoint ile çalıştırma + dosya tabanlı yönetim.

## 1.1 Dosya tabanlı “run profile”
- `configs/` altında JSON/YAML profil dosyaları:
  - eventUrl, mode, categoryType/alt, concurrency, timeouts
  - takım/etkinlik isim etiketi
- API request body minimalleşsin: `profileName` + override’lar.

## 1.2 Üyelik havuzu dosyaları (takım bazlı)
- `accounts/` altında:
  - `teamA_holding.json` (A hesapları)
  - `teamA_receivers.json` (B hesapları)
- API:
  - `POST /bot/run` sadece `teamKey` + `eventUrl` alabilir (hesapları dosyadan çeker)

## 1.3 Proxy havuzu
- `proxies.json` desteği:
  - round-robin / random atama
  - A ve B için ayrı proxy policy

---

# Faz 2 — Üyelik Yönetimi (UI’sız CRUD)
**Çıktı**: Üyelikleri dosyadan değil, servis üzerinden yönetebilme.

## 2.1 Basit storage seçimi
- İlk adım: JSON file storage (atomic write) veya SQLite.

## 2.2 API uçları
- `GET /accounts?teamKey=&role=(A|B)`
- `POST /accounts/import` (bulk)
- `POST /accounts` / `DELETE /accounts/:id`
- `POST /accounts/disable` (ban/lock)

## 2.3 Ban/blacklist
- Belirli hata tiplerinde otomatik disable:
  - sürekli login fail
  - güvenlik blok / captcha loop

---

# Faz 3 — Transfer “Tanımlama” (TC/Pasaport) Modu (Sözleşmeye yaklaşım)
**Çıktı**: “B hesabında tanımlama ekranı” gibi bir akış varsa otomasyon.

> Not: Bu faz, Passo’nun gerçek UI akışına bağlı. Mevcut sistemdeki “seatId release-catch” transferi farklı bir anlamda transfer.

## 3.1 Akış keşfi (UI yazmadan)
- Sadece bot tarafında: gerekli ekran/selector tespiti, audit ile iz.

## 3.2 Tanımlama API’si
- Request’e opsiyonel alanlar:
  - `assignTo.identityType` (tc/pasaport)
  - `assignTo.identityValue`
- Eğer tanımlama ekranı yoksa:
  - bu faz “N/A” olarak işaretlenir.

## 3.3 Geri çekme
- Tanımlama/transfer tersine çevrilebiliyorsa, “undo” flow.

---

# Faz 4 — Ödeme (UI’sız otomasyon, opsiyonel)
**Çıktı**: Ödeme otomasyonu istenirse eklenir.

## 4.1 Ödeme profilleri
- `paymentProfiles.json`:
  - holderName, cardNo, exp, cvv
  - 3DS/OTP varsa “manuel onay” stratejisi

## 4.2 Mode
- `checkoutMode`:
  - `none` (sadece sepete kadar)
  - `prepare` (ödeme ekranına kadar)
  - `auto` (mümkünse tamamla)

---

# Faz 5 — Raporlama & Run Sonuçları (UI’sız)
**Çıktı**: audit dışında makine okunur run özeti.

## 5.1 Run summary JSON
- `POST /bot/run` response:
  - her A için: seatId, cat/block, status (holdingOnly/transferred/failed)
  - transfer duration, hata kodu

## 5.2 Audit event standardizasyonu
- Zorunlu alanlar:
  - `runId`, `accountRole`, `email`, `event`, `seatId`, `timestamp`, `durationMs`, `proxyKey`

---

# Faz 6 — Dayanıklılık & Performans
**Çıktı**: daha yüksek concurrency, daha az ban/flake.

## 6.1 Concurrency policy
- A worker pool dinamik:
  - CPU/RAM’e göre ayarlanabilir

## 6.2 Recovery / retry matrisi
- Hata koduna göre aksiyon:
  - relogin
  - returnUrl recover
  - kategori/blok yeniden seç
  - browser restart

---

# Kabul Kriterleri (Faz bazlı)
- Faz 0:
  - EPERM crash olmadan run kapanır
  - SEAT_SELECTION_FAILED_A oranı belirgin düşer
  - 3A+2B smoke test tutarlı
- Faz 1:
  - profile + accounts/proxies dosyalarıyla run başlatılabilir
- Faz 2:
  - account CRUD + disable/blacklist çalışır
- Faz 3:
  - (varsa) tanımlama akışı otomatik
- Faz 5:
  - run summary + audit alanları standart

# Notlar
- Bu doküman implementasyon değil, **uygulanabilir teknik plan**tır.
- Fazlar birbirinden bağımsız yürütülebilir ama Faz 0 önerilen önceliktir.
