# Passo Bot — Seat Availability Watcher: İmplementasyon Planı

> **Amaç:** `getseatstatus` endpoint'ini agresif poll ederek  
> (1) A→B transfer sırasında koltuk kayıp penceresini minimize etmek,  
> (2) dolu etkinlikte piyasadan boşa düşen koltuğu rakip botlardan önce kapmak.

---

## Keşfedilen Endpoint'ler (probe-network çıktısından)

```
GET /api/passoweb/getseatstatus?eventId={eventId}&serieId={serieId}&blockId={blockId}
```

Tek istekte o bloktaki **tüm koltuğun** durumunu döndürür:
```json
[
  { "id": 461804625, "isSold": true,  "isReserved": false },
  { "id": 461804626, "isSold": false, "isReserved": false },  ← müsait!
  ...
]
```

- `isSold: false` + `isReserved: false` → koltuk müsait
- `isSold: true` → sepette veya satılmış
- 1 blok = 1 istek (blokta 45 koltuk olsa da). Koltuk başına ayrı istek YOK.

Yardımcı setup endpoint'leri (bir kez çağrılır, cache'lenir):
```
GET /api/passoweb/getavailableblocklist?eventId=X&serieId=&seatCategoryId=Y
  → kategori altındaki blok ID'lerini verir

GET /api/passoweb/getseats?eventId=X&serieId=&seatCategoryId=Y&blockId=Z
  → blok içindeki her koltuğun ID, sıra, no, pozisyon bilgisini verir
```

Hızlı sinyal endpoint'i:
```
GET /api/passoweb/getisavailableseatforeventorserie/null/{eventId}
  → { "value": true/false }
  → true: zaten müsait koltuk var, hemen al
  → false: dolu — normal durum, poll'a devam
```

---

## Temel Prensip

> **"Dolu etkinlik"** asıl hedef senaryodur.
> `getisavailableseatforeventorserie → false` gelince yavaşlamak yanlıştır.
> Aksine, sepetler 10 dakikada bir düşeceğinden o an **en agresif** pollamamız gereken andır.

Rate limit sorununu "frekansı azaltarak" değil, **scope'u daraltarak** çözüyoruz:
- Tüm blokları izleme → sadece **hedef blokları** izle
- 45 koltuk bile olsa: 1 blok = 1 istek
- 2-3 hedef blok → 800ms'de 2-3 istek → saniyede ~3 istek → Cloudflare'i tetiklemez

---

## Senaryo 1: A→B Transfer Güvenliği

### Şu anki açık pencere

```
A: clearBasketFully()         ← koltuk serbest
         ↓
     [AÇIK PENCERE: 2–5 sn]  ← başkası kapabilir
         ↓
B: applyCategoryBlockSelection()
B: openSeatMapStrict()        ← 2–5 sn yükleme
B: pickExactSeat()
```

### Watcher ile hedef akış

```
[A bırakmadan ÖNCE]
B: blockId'yi zaten biliyoruz (A'nın sepetinden okundu)
B: startSeatAvailabilityWatcher(blockId, targetSeatId) → başlatıldı

A: clearBasketFully()         ← koltuk serbest

[800ms içinde]
watcher: isSold=false → resolve(seatId)

B: applyCategoryBlockSelection()  ← tetiklendi
B: openSeatMapStrict()
B: pickExactSeat(seatId)
```

**Kazanım:** Açık pencere 2–5 sn → < 1 sn.

Neden Level 1–2 atlanır: A→B'de hedef blockId zaten biliniyor. Setup adımına gerek yok, direkt Level 3.

---

## Senaryo 2: Piyasadan Koltuk Kapmak (Snipe Modu)

### Akış

```
SETUP (bir kez, bot başlarken):
  hedef kategori(ler) → getavailableblocklist → blockId listesi
  her blockId → getseats → seatId ↔ (sıra, koltuk no) haritası
  → cache'e al

ÇALIŞMA (sürekli):
  her 800ms:
    hedef bloklar için getseatstatus çağır (paralel)
    isSold: false görülen seat → sıra/koltuk no'yu haritadan bul
    kriterlere uyuyor mu? (sıra, blok, fiyat filtresi)
    uyuyorsa → en uygun hesabı tetikle → sepete ekle

getisavailableseatforeventorserie (hızlı sinyal, her 10sn):
  true dönerse → zaten müsait var, acil al (beklemeden)
  false dönerse → normal, poll devam ediyor
```

### Kaç istek atar?

| Durum | Blok sayısı | İstek/800ms | İstek/sn |
|-------|------------|-------------|----------|
| 1 kategori, 2 blok | 2 | 2 | 2.5 |
| 2 kategori, 5 blok | 5 | 5 | 6.25 |
| 3 kategori, 10 blok | 10 | 10 | 12.5 |

10 blok bile saniyede 12.5 istek = normal bir web kullanıcısının ürettiğinden az. Rate limit riski düşük.

---

## Teknik Mimari

### Temel fonksiyon: `startSeatAvailabilityWatcher`

**Dosya:** `src/helpers/seat.js`

```javascript
/**
 * Belirtilen blok(lar)daki hedef koltuğun müsait olmasını bekler.
 * page.evaluate üzerinden fetch yaparak login session'ını kullanır.
 *
 * @param {Page}   page
 * @param {object} opts
 * @param {string}          opts.eventId
 * @param {string}          opts.serieId        - default: ''
 * @param {number|number[]} opts.blockIds        - izlenecek blok ID'leri
 * @param {number|number[]|null} opts.targetSeatIds  - null = bloktaki herhangi biri
 * @param {number}          opts.intervalMs      - default: 800
 * @param {number}          opts.timeoutMs       - default: 300_000
 * @param {AbortSignal}     opts.signal          - iptal sinyali
 * @returns {Promise<{ seatId, blockId }>}       - müsait olan koltuk
 */
async function startSeatAvailabilityWatcher(page, opts) { ... }
```

**İç işleyiş:**
- `page.evaluate(() => fetch(...))` → session cookie otomatik gider
- Her `intervalMs`'de tüm `blockIds` için paralel fetch
- Sonuçları `targetSeatIds` ile filtrele
- `isSold: false && isReserved: false` → resolve
- `signal.abort()` ile dışarıdan iptal edilebilir
- Timeout geçince reject eder

### Setup fonksiyonu: `fetchBlockSeatMap`

**Dosya:** `src/helpers/seat.js`

```javascript
/**
 * Kategori → blok listesini ve her bloğun seat haritasını çeker.
 * Bir kez çalıştırılır, sonuç cache'lenir.
 *
 * @returns {Map<blockId, Map<seatId, { row, seatNo, displayName }>>}
 */
async function fetchBlockSeatMap(page, { eventId, serieId, seatCategoryId }) { ... }
```

### A→B Transfer Entegrasyonu

**Dosya:** `botController.js`, transfer loop içi

```javascript
// 1. A'nın sepetindeki seatId → hangi blockId? (getuserbasketbookingblockview'dan okunur)
const { seatId, blockId } = await getSeatInfoFromBasket(aCtx.page, eventId);

// 2. Watcher başlat (A daha bırakmadan)
const ac = new AbortController();
const watcherPromise = startSeatAvailabilityWatcher(bCtx.page, {
  eventId, serieId, blockIds: [blockId],
  targetSeatIds: [seatId],
  intervalMs: 800,
  timeoutMs: 60_000,
  signal: ac.signal,
});

// 3. A koltuğu bırak
await clearBasketFully(aCtx.page);

// 4. B watcher'ı bekle → hemen tetikle
const { seatId: confirmedSeatId } = await watcherPromise;
ac.abort();

// 5. B seatmap aç → kap
await applyCategoryBlockSelection(bCtx.page, ...);
await openSeatMapStrict(bCtx.page);
await pickExactSeatBundleReleaseAware(bCtx.page, confirmedSeatId);
```

### Snipe Modu: Yeni run tipi

Mevcut modlara ek:

```javascript
// runConfig örneği
{
  mode: 'snipe',
  eventId: '11352322',
  serieId: '',
  targets: [
    {
      seatCategoryId: 12816452,   // hangi kategori
      blockIds: [14859, 14860],    // hangi bloklar (null = hepsini tara)
      seatFilter: {               // kriterleri (null = herhangi)
        rows: ['L', 'K'],         // sıra filtresi
        maxPrice: 1000,
      }
    }
  ],
  accounts: [{ email, password }],  // koltuk bulununca bu hesap alır
  onFound: 'add_to_basket',         // 'add_to_basket' | 'pay_immediately'
}
```

---

## Keşifler (probe-blocks çıktısından)

### SVG Mode: DOM ID = API blockId ✅ DOĞRULANDI

SVG haritasındaki her blok elementi:
```html
<g class="block" id="block17363" style="cursor: pointer;">
  <path id="path17363" class="svgBlock" .../>
</g>
```

`<title>`, `aria-label`, `data-*` attribute yok — isim DOM'da yok.  
Blok tıklanınca `getblockscenedirection/1855221/**17363**` çağrısı gidiyor.  
**DOM ID `block17363` → API blockId = `17363`** — kesin eşleşme.

```javascript
// Tek satır dönüşüm:
const apiBlockId = parseInt(svgDomId.replace('block', ''));
// "block17363" → 17363
```

### SVG Mode: Özel API endpoint'leri (yeni keşif)

SVG bloğa tıklandığında Passo, legacy'den **farklı endpoint'ler** kullanıyor:

| İşlem | Legacy endpoint | SVG endpoint |
|-------|----------------|-------------|
| Kategori | `getcategories?seatCategoryId=X` | `getcategoriesbyblockid` |
| Koltuklar | `getseats?blockId=X` | `getseatsbyblockid` |
| Varyantlar | `getvariants?seatcategoryid=X` | `getvariantsbyblockview` |
| Durum | `getseatstatus?blockId=X` | `getseatstatus?blockId=X` (??) |

`getseatstatus` SVG modda da çağrılıyor mu henüz netleşmedi — legacy'de tespit edilmişti.  
**Watcher için `getseatstatus` kullanmaya devam edilecek** (her iki modda çalışması bekleniyor, test edilmeli).

### Legacy Mode: API üzerinden blockId ✅ NETLEŞTI

Legacy koltuk-secim sayfası: önce kategori tile'ına tıklanır, sonra `select#blocks` dropdown gelir.  
`select#blocks` değer formatı test edilmedi — **gerekmedi.**

`getvenuetemplate → venueLayoutImagePointData: "[]"` → SVG yok → legacy modu teyit edildi.

**Legacy'de blockId alma yöntemi: API tabanlı setup**

```
Bir kez (bot başlarken):
  getcategories?eventId=X → [{ id: 12816451, name: "MARATON" }, ...]
  Her kategori için:
    getavailableblocklist?seatCategoryId=12816451 → [{ id: 14859, name: "..." }, ...]
  → Tüm blockId'ler cache'e alınır

Poll (800ms):
  getseatstatus?blockId=14859 → isSold kontrol
  getseatstatus?blockId=14860 → isSold kontrol
```

`select#blocks` DOM değerine hiç bakılmaz. blockId'ler API'dan gelir.

**SVG vs Legacy blockId karşılaştırması:**

| | SVG | Legacy |
|---|---|---|
| blockId kaynağı | DOM: `parseInt("block17363")` | API: `getavailableblocklist` |
| Blok seçimi | `document.getElementById("block17363").click()` | `select#blocks` dropdown |
| Poll endpoint | `getseatstatus?blockId=17363` | `getseatstatus?blockId=14859` |
| Hız | Anında (DOM hazır) | 1 API çağrısı setup gerekir |

---

## Dikkat Edilmesi Gereken Noktalar

### A. `getseatstatus` login gerektiriyor mu? ✅ DOĞRULANDI

`curl` ile direkt istek → **Cloudflare "Sorry, you have been blocked"**

Login + browser session zorunlu. `node-fetch` veya raw HTTP ile çağrılamaz.

**Mimari kararı:** `page.evaluate(() => fetch(...))` kullanılacak.  
Puppeteer page'inin session cookie'si + Cloudflare clearance'ı otomatik gider.

```javascript
// Watcher içinde:
const result = await page.evaluate(async (url) => {
  const r = await fetch(url, { credentials: 'include' });
  return r.json();
}, `https://ticketingweb.passo.com.tr/api/passoweb/getseatstatus?eventId=${eventId}&serieId=&blockId=${blockId}`);
```

**Sonuç:** Watcher her zaman login olmuş bir Puppeteer page'e bağlı olacak.  
B hesabının page'i kullanılır — zaten koltuk-secim'de bekliyor.

### B. blockId'yi A'nın sepetinden okumak

`getuserbasketbookingblockview` response'u şu an `bookingDeliverysProxies` ve `basketBookingProducts` içeriyor. Koltuk bilgisinden `blockId` çekme kodu eklenecek.

Alternatif: `getseats` ile seatId → blockId ters lookup cache'i kur.

### C. Turnstile Token Hazırlığı

Watcher koltuk boşa düşünce B seatmap açıp UI üzerinden koltuku seçmek zorunda (API direkt çağırmak için Turnstile token gerekiyor). Seatmap açılması 1–3 sn.

**Optimizasyon:** Watcher başlarken `ensureTurnstileTokenOnPage` paralel çalıştır. Watcher ateşlendiğinde token hazır → seatmap açılırken token bekleme süresi sıfır.

### D. Paralel Multi Transfer ile Birleşim

Multi-mode'da her A→B çifti için bağımsız watcher çalışır. Tüm çiftler `Promise.allSettled` ile paralel tetiklenir → bu `IMPROVEMENT_PLAN.md` Madde 2 ile örtüşüyor, ikisi birden kazanım sağlar.

---

## Uygulama Sırası

| # | Adım | Dosya | Bağımlılık |
|---|------|-------|-----------|
| 1 | `getseatstatus` login testi (curl) | — | Mimari kararı verir |
| 2 | `startSeatAvailabilityWatcher` yaz | `seat.js` | — |
| 3 | `fetchBlockSeatMap` yaz (setup cache) | `seat.js` | — |
| 4 | A'nın sepetinden seatId+blockId okuma | `botController.js` | 2 tamamlanmalı |
| 5 | A→B transfer loop'a watcher entegre et | `botController.js` | 2, 4 |
| 6 | Turnstile token paralel hazırlığı | `botController.js` | 5 |
| 7 | Multi transfer paralel hale getir | `botController.js` | 5 |
| 8 | Snipe modu: target config + UI | `botController.js` + `app.js` | 2, 3 |

---

## Açık Sorular (konuşulacak)

1. **Snipe modunda hesap seçimi:** Boşa düşen koltuğu hangi hesap alacak? A hesabı mı, B hesabı mı, ayrı bir "sniper" hesabı mı?
2. **Hedef seat seçimi:** Kullanıcı UI'dan belirli sıra/blok seçer mi, yoksa "bu kategorideki herhangi bir koltuk" yeterli mi?
3. **blockId kullanıcıdan mı gelecek?** `getavailableblocklist` çekip otomatik mi bulalım, yoksa UI'da gösterip kullanıcı mı seçsin?
4. **Snipe bulunca ne yapsın?** Sadece sepete eklesin (kullanıcı kendisi ödesin) mi, yoksa otomatik ödemeye de gitsin mi?
5. **Kaç hesap paralel snipe yapabilir?** Her hesap ayrı blok mu izler, yoksa hepsi aynı hedefi mi izler?
