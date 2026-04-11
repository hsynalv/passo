# Passo Bot — Koltuk Yakalama İyileştirme Planı

> **Durum:** Sıralı, hazırlanmamış bir B penceresi nedeniyle A bırakıp B alana kadar geçen süre (5–15 sn) kritik kayıp noktasıdır.
> Aşağıdaki maddeler etki büyüklüğüne göre sıralanmıştır. Her biri bağımsız uygulanabilir.

---

## Bağlam: Mevcut Akış ve Darboğazları

```
[A hold: poolMap paralel] ─→ [B hazırlık: poolMap paralel] ─→ [Transfer: SEKANSİYEL for-loop]
                                     │                                │
                                /koltuk-secim'de kategori        Her çift:
                                listesinde bekliyor              A bırak → B kategori tıkla
                                (seatmap KAPALI) ✅              → seatmap SIFIRDAN açılır
                                                                 → koltuk serbest görünür → pick
                                                                 AÇIK PENCERE: ~1–2 sn ✅
                                                                 (hâlâ SEKANSİYEL — Madde 2)
```

Koltuk kaçırma nedenleri önem sırasıyla:

| # | Neden | Etki |
|---|-------|------|
| 1 | B, A bıraktıktan SONRA doğru kategoriye geçiyor | Çok yüksek |
| 2 | Multi-mode transfer sıralı (pair 2, pair 1 bitmeden başlamıyor) | Yüksek |
| 3 | A bırakmadan önce session / Turnstile sağlık kontrolü yok | Orta |
| 4 | Sepet boşsa (`initialCount=0`) güvenli devam var ama guard yok | Orta |
| 5 | B'nin polling hızı A bıraktıktan sonra da sabit | Orta |
| 6 | Seat availability XHR/WS izlenmiyor | Uzun vadeli |

---

## Madde 1 — B Kategori Listesinde Beklesin, Seatmap'i A Bıraktıktan Sonra Açsın ✅ UYGULANDИ

**Etki:** Çok yüksek  
**Karmaşıklık:** Düşük  
**Dosya:** `src/controllers/botController.js` — `bCtxFn` + transfer loop

### Problem (eski durum)

`bCtxFn` içinde B, `openSeatMapStrict` ile seatmap'i A'nın koltuğu hâlâ sepetteyken açıyordu. Bu durumda:
- A'nın koltuğu seatmap'te **gri / dolu** görünürdü
- A koltuğu bırakınca Passo seatmap'i otomatik güncellemez — ya page reload ya da seatmap re-render gerekir
- Transfer zamanı: B kategoriye git → seatmap yeniden yükle → koltuk ara = **5–15 sn kayıp pencere**

### Çözüm (uygulandı)

**B, `/koltuk-secim` sayfasında kategori listesinde (seatmap KAPALI) bekler.**

```
Eski akış:
  bCtxFn → applyCategoryBlock(null) → openSeatMapStrict → seatmapReady:true
  Transfer: A bırak → B catBlock uygula → seatmap YENIDEN yükle (gecikme) → pick

Yeni akış:
  bCtxFn → /koltuk-secim'de kal, kategori listesi görünür, seatmap AÇILMAZ
  Transfer: A bırak → B kategoriyi tıkla → seatmap SIFIRDAN açılır → koltuk serbest → pick
```

`bCtxFn`'den kaldırılanlar:
- `applyCategoryBlockSelection(page, mode, null, null)` 
- `openSeatMapStrict(page)` + seat node `waitForFunction`

Transfer döngüsünden kaldırılanlar:
- `if (!bCtx.seatmapReady) { openSeatMapStrict ... }` bloğu

Transfer döngüsünde kalan:
- A bırakır → `applyCategoryBlockSelection(bCtx.page, mode, aCtx.catBlock, aCtx.seatInfo)` → kategori seçilir, seatmap taze açılır → `pickExactSeatBundleReleaseAware` içindeki `openSeatMapStrict` seatmap'in hazır olmasını bekler → pick

### Beklenen kazanım

Açık pencere 5–15 sn → **~1–2 sn** (sadece A'nın basket temizlik süresi + `applyCategoryBlockSelection` + `openSeatMapStrict` render süresi).

---

## Madde 2 — Multi-Mode Transfer'i Paralel Yap

**Etki:** Yüksek  
**Karmaşıklık:** Orta  
**Dosya:** `src/controllers/botController.js` — transfer loop (~satır 10292)

### Problem

```javascript
// MEVCUT: sıralı
for (let i = 0; i < pairCount; i++) {
    // A[i] bırakır → B[i] yakalar → sonra A[i+1]...
}
```

5 çift varsa: pair 5'in B'si pair 1'in transferini bekler. Bu sürede:
- B[4]'ün captcha token'ı sona ermiş olabilir
- Session timeout riski artar
- Toplam transfer süresi: `pairCount × ortalama_transfer_süresi`

### Çözüm

A bırakmaları ve B yakalamalarını **pipeline** yaklaşımıyla paralel yap:

```javascript
// ÖNERİLEN: paralel
const transferResults = await Promise.allSettled(
    Array.from({ length: pairCount }, async (_, i) => {
        const aCtx = aCtxList[i];
        const bCtx = bCtxList[i];
        // ... aynı mantık, sadece paralel çalışıyor
        return await transferSinglePair(i, aCtx, bCtx);
    })
);
```

**Neden güvenli?**  
`pickExactSeatBundleReleaseAware` yalnızca `aCtx.seatInfo.seatId`'yi arar. B[0], A[1]'in seatId'sini almaz çünkü seatId spesifik. Çarpışma riski yoktur.

**Dikkat edilmesi gereken:**
- A bırakmaları arasına küçük bir stagger (100–200ms) eklenebilir: tüm A'lar aynı anda boşaltırsa Passo CDN/edge kısa süre yük görür
- Dashboard güncellemeleri `syncDashboardToRunStore()` mutex gerektirmez (runStore'un `upsert` fonksiyonu tek-thread)
- `persistTransferForPair` ve `persistFailureForPair` zaten bağımsız (farklı pairIndex)

```javascript
// Staggered parallel release
const pairTransferFns = Array.from({ length: pairCount }, (_, i) => async () => {
    await delay(i * 150); // A[i]'nin bırakması 150ms arayla başlar
    return transferSinglePair(i, aCtxList[i], bCtxList[i]);
});
const results = await Promise.allSettled(pairTransferFns.map(fn => fn()));
```

### Beklenen kazanım

5 çift için toplam transfer süresi: `5 × 8sn` → `8sn + 4×150ms = ~8.6sn`.

---

## Madde 3 — Transfer Öncesi Session ve Captcha Sağlık Kontrolü

**Etki:** Orta  
**Karmaşıklık:** Düşük  
**Dosya:** `src/controllers/botController.js` — transfer loop başı ve `transferSeatToBForHold`

### Problem

A ve B'nin oturumları / Turnstile token'ları B hazırlık aşamasında alınmış. Transfer başlamadan bu bilgilerin geçerliliği kontrol edilmiyor. Örneğin B hazırlanırken Turnstile'ın 5 dakikalık süresi dolmuş olabilir.

### Çözüm

Transfer döngüsü başlamadan önce her çift için hızlı sağlık kontrolü:

```javascript
// Transfer döngüsü başında (her pair için, paralelle birleştirilebilir)
const healthCheck = async (page, email, password, role) => {
    // 1. URL kontrolü — login sayfasına düşmüş mü?
    try {
        const url = page.url();
        if (/\/giris|\/login/i.test(url)) {
            audit(`${role}_session_expired_pre_transfer`, { email }, 'warn');
            await reloginIfRedirected(page, email, password);
            await clickBuy(page, eventAddress);
            await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000 });
        }
    } catch {}

    // 2. Turnstile token'ı hâlâ geçerli mi?
    try {
        const tokenOk = await page.evaluate(() => {
            const f = document.querySelector('input[name="cf-turnstile-response"]');
            return !!(f && String(f.value || '').length >= 80);
        }).catch(() => false);
        if (!tokenOk) {
            await ensureCaptchaOnPage(page, email, `preTransfer.${role}`, { background: false });
        }
    } catch {}
};

// Transfer başlamadan önce tüm pair'ler için:
await Promise.all(
    Array.from({ length: pairCount }, async (_, i) => {
        const aCtx = aCtxList[i];
        const bCtx = bCtxList[i];
        if (!aCtx?.seatInfo?.seatId) return;
        await healthCheck(aCtx.page, aCtx.email, aCtx.password, `A${i}`);
        await healthCheck(bCtx.page, bCtx.email, bCtx.password, `B${i}`);
    })
);
```

### Beklenen kazanım

Transfer sırasında "oturum bitmişti, tekrar girildi, 30sn gecikmeli" senaryosu ortadan kalkar. Token refresh transfer öncesi yapılmış olur.

---

## Madde 4 — Sepet Varlığını Transfer Öncesi Guard'la Koru

**Etki:** Orta  
**Karmaşıklık:** Çok düşük  
**Dosya:** `src/controllers/botController.js` — multi transfer loop (~satır 10487)

### Problem

`clearBasketFully` çağrısı öncesinde sepetin gerçekten A'nın koltuğunu tutup tutmadığı doğrulanmıyor. Eğer sepet süresi dolmuş veya A oturumu kapanmışsa `initialCount=0` ile "başarılı" dönebilir ve B olmayan bir koltuğu aramaya çalışır.

### Çözüm

Zaten eklendi (audit log). Şimdi bunu bir **hard guard** yapabiliriz:

```javascript
// MEVCUT: sadece uyarı log
// ÖNERİLEN: erken çıkış
const initialCheck = await getBasketItemCountSafe(aCtx.page);
if (initialCheck === 0) {
    audit('a_seat_lost_before_transfer', {
        idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId,
        note: 'Sepet boş — bilet süre dolmuş ya da oturum bitmişti'
    }, 'warn');
    // Pair'i failed olarak işaretle, B'yi gereksiz yere bekletme
    await persistFailureForPair(i + 1, {
        paymentState: 'failed',
        finalizeState: 'failed',
        recordStatus: 'failed',
        aAccountEmail: aCtx.email,
        auditMeta: { phase: 'a_seat_lost_pre_transfer' }
    });
    if (dashboardPairs[i]) {
        dashboardPairs[i] = { ...dashboardPairs[i], phase: 'Hata: Bilet süre doldu (transfer öncesi)', transferOk: false, paymentState: 'failed' };
        syncDashboardToRunStore();
    }
    continue; // Bu pair atlanır, diğerleri devam eder
}
```

### Beklenen kazanım

Süresi dolmuş biletler için B gereksiz yere `exactMaxMs` süre boyunca koltuk aramaz. Diğer pair'ler daha hızlı devam edebilir.

---

## Madde 5 — Adaptive Polling Hızı (B Release-Aware Optimization)

**Etki:** Orta  
**Karmaşıklık:** Orta  
**Dosya:** `src/helpers/seat.js` — `pickExactSeatWithVerify_ReleaseAware`

### Problem

`pickExactSeatWithVerify_ReleaseAware` ilk 8 saniye (`AGGRESSIVE_RETRY_MS = 8000`) hızlı poll eder. Ama bu sayaç B'nin kendi başına başlatılır — A'nın ne zaman bıraktığından habersizdir.

Eğer B seatmap'i 6 saniyede yükledi, aggressive window'un sadece 2 saniyesi A bıraktıktan sonra koltuk "serbest" durumundayken kullanılır.

### Çözüm

A bıraktığında bir **timestamp** paylaşın. B bu timestamp'ten itibaren agresif poll yapsın:

```javascript
// botController.js — clearBasketFully başarılı olduktan sonra:
aCtx._releasedAt = Date.now();
audit('a_released_signal', { idx: i, aEmail: aCtx.email, releasedAt: aCtx._releasedAt });

// pickExactSeatBundleReleaseAware çağrısına options olarak geç:
const exactPromise = pickExactSeatBundleReleaseAware(bCtx.page, aCtx.seatInfo, exactMaxMs, {
    audit: ...,
    releasedAt: aCtx._releasedAt, // YENİ
});
```

```javascript
// seat.js — pickExactSeatWithVerify_ReleaseAware içinde:
const releasedAt = opts?.releasedAt || null;

// Aggressive window: eğer A'nın bıraktığı zaman biliniyorsa, oradan itibaren say
const aggressiveEnd = releasedAt
    ? releasedAt + AGGRESSIVE_RETRY_MS   // A bıraktıktan sonra 8sn
    : Date.now() + AGGRESSIVE_RETRY_MS;  // Fallback: şu andan 8sn

// Polling döngüsünde:
const isAggressive = Date.now() < aggressiveEnd;
const pollMs = isAggressive ? 40 : 120; // Aggressive modda 40ms
```

### Beklenen kazanım

B'nin tam hazır olduğu anda A bırakmışsa, aggressive 8sn windowunun tamamı gerçek arama için kullanılır. Şu anda bu sürenin bir kısmı seatmap yüklemeyle gidebilir.

---

## Madde 6 — Deferred B Hazırlığı: B Launch Paraleli A Hold ile Başlasın

**Etki:** Orta-Yüksek  
**Karmaşıklık:** Orta  
**Dosya:** `src/controllers/botController.js` — `bCtxFn` çağrısı (~satır 10228)

### Problem

Şu an:
```
A[0..n] hold (paralel) ─(biter)─→ B[0..n] hazırlık (paralel) ─(biter)─→ Transfer
```

A hold toplam ~30-90sn sürebilir (giriş + etkinlik + koltuk seçimi). B hazırlığı da benzer süre alır. Bunlar sıralı çalışırsa toplam süre 2× olur.

### Çözüm

B hazırlığını A hold ile **paralel** başlat. A hold biter bitmez B zaten giriş yapmış ve event sayfasındadır:

```javascript
// MEVCUT:
const rawMultiA = await poolMap(aList, multiAConcurrency, runOneMultiAHold);
// ... A işlenir ...
const bCtxList = await bCtxFn(); // ← SONRA başlar

// ÖNERİLEN:
const bCtxPromise = bCtxFn(); // A holdla eş zamanlı başlat
const rawMultiA = await poolMap(aList, multiAConcurrency, runOneMultiAHold);
// ... A işlenir ...
const bCtxList = await bCtxPromise; // Zaten çoğunlukla tamamlanmıştır
```

**Dikkat:** B hazırlığında kategori bilgisi `aCtxList`'ten geliyor (Madde 1). Ancak B paralel başlarsa `aCtxList` henüz dolmamış olabilir. 

**Çözüm yaklaşımı:**  
B girişini ve event sayfasını paralel yapsın (kategori bilgisi gerekmez), ama seatmap açma adımını A hold bitene kadar beklesin:

```javascript
const bLoginReadyList = await poolMap(bList, multiBConcurrency, async (acc, i) => {
    // 1. Giriş + event sayfası + buy tıklama + /koltuk-secim
    const { browser, page } = await launchAndLoginWithManagedProxy(...);
    await gotoWithRetry(page, eventAddress, ...);
    await clickBuy(page, eventAddress);
    await ensureUrlContains(page, '/koltuk-secim', ...);
    return { browser, page, email: acc.email, password: acc.password, idx: i };
});

// A hold bitti, aCtxList doldu
// Şimdi B'leri doğru kategoriye yönlendir (aCtxList[i] artık bilinir)
const bCtxList = await poolMap(bLoginReadyList, multiBConcurrency, async (bReady, i) => {
    const aCtxForB = aCtxList[i] || null;
    await applyCategoryBlockSelection(bReady.page, ..., aCtxForB?.catBlock, aCtxForB?.seatInfo);
    await openSeatMapStrict(bReady.page);
    // ...
    return { ...bReady, seatmapReady: true, knownCatBlock: aCtxForB?.catBlock };
});
```

### Beklenen kazanım

Toplam süre: `max(A_hold_süresi, B_giriş_süresi) + B_seatmap_süresi` yerine `max(A_hold_süresi, B_tam_hazırlık)`.  
Pratikte 30–90 saniye kazanılabilir.

---

## Madde 7 — Basket Loop Akıllı Zamanlama

**Etki:** Düşük-Orta  
**Karmaşıklık:** Düşük  
**Dosya:** `src/controllers/botController.js` — `ensureDeferredPayableTransferWatcher`

### Problem

Basket loop (A→B→A→...) `extendWhenRemainingSecondsBelow` eşiğini statik bir sayı olarak kullanıyor. Eşik çok geç ayarlanmışsa transfer başlarken zamanlama yetişmeyebilir.

### Çözüm

Transfer süresini geçmiş denemelerden öğrenerek dinamik eşik hesapla:

```javascript
// Her çift transferinin süresi audit log'larından okunabilir
// veya botController içinde basit bir moving average tutulabilir:

let avgTransferMs = 8000; // Başlangıç tahmini: 8sn
const updateAvgTransfer = (ms) => {
    avgTransferMs = Math.round(avgTransferMs * 0.7 + ms * 0.3); // EMA
};

// extendWhenRemainingSecondsBelow:
const dynamicThreshold = Math.ceil((avgTransferMs / 1000) * 1.5); // 1.5x güvenlik marjı
```

---

## Madde 8 — Seat Availability XHR İzleme (Uzun Vadeli)

**Etki:** Yüksek (başarılırsa)  
**Karmaşıklık:** Çok yüksek  
**Dosya:** `src/helpers/seat.js` + yeni `src/helpers/seatNetworkMonitor.js`

### Problem

B şu an DOM'u poll ediyor (`SEAT_NODE_SELECTOR` elementi bekliyor). Ancak koltuk durumu Passo'nun backend'inde değişir ve frontend bu değişikliği XHR/WebSocket ile alır. DOM'un güncellenmesi bu network yanıtından sonra gelir.

### Çözüm

B'nin sayfasına Puppeteer ile `page.on('response', ...)` ekleyerek seat status response'larını intercept et:

```javascript
// seatNetworkMonitor.js (yeni dosya)
function startSeatAvailabilityWatcher(page, targetSeatId) {
    const emitter = new EventEmitter();
    const handler = async (response) => {
        try {
            const url = response.url();
            // Passo'nun seat availability endpoint'i (tersine mühendislik gerekir)
            if (!url.includes('/api/seat') && !url.includes('/koltuk')) return;
            if (response.status() !== 200) return;
            const body = await response.json().catch(() => null);
            if (!body) return;
            // body içinde targetSeatId'yi ara
            const isAvailable = checkSeatAvailability(body, targetSeatId);
            if (isAvailable) {
                emitter.emit('available', { seatId: targetSeatId, ts: Date.now() });
            }
        } catch {}
    };
    page.on('response', handler);
    return {
        emitter,
        stop: () => page.off('response', handler)
    };
}
```

**Araştırılması gereken:** Passo'nun hangi endpoint'i seat availability için kullandığı (DevTools Network tab ile bakılabilir).

---

## Uygulama Sırası ve Bağımlılıklar

```
Madde 4 (Guard)           ← Bağımsız, en kolay, hemen uygulanabilir
    ↓
Madde 1 (B doğru catBlock) ← Madde 4'ten sonra, en yüksek etki
    ↓
Madde 3 (Session health)   ← Madde 1 ile paralel uygulanabilir
    ↓
Madde 5 (Adaptive polling) ← Madde 1'den sonra (releasedAt signal gerekir)
    ↓
Madde 2 (Paralel transfer) ← Madde 1 ve 5'ten sonra (sıra önemli)
    ↓
Madde 6 (B launch paraleli) ← Madde 2'den sonra (mimari değişiklik)
    ↓
Madde 7 (Dinamik threshold) ← İsteğe bağlı
    ↓
Madde 8 (XHR izleme)       ← Araştırma gerektirir, en uzun vadeli
```

---

## Özet Tablo

| Madde | Değişiklik | Etki | Zorluk | Önce |
|-------|-----------|------|--------|------|
| 1 | B'yi A'nın gerçek catBlock'uyla hazırla | Çok yüksek | Düşük | — |
| 2 | Multi transfer paralel | Yüksek | Orta | 1, 5 |
| 3 | Transfer öncesi session+captcha sağlık | Orta | Düşük | — |
| 4 | Sepet empty guard | Orta | Çok düşük | — |
| 5 | Adaptive polling (releasedAt) | Orta | Orta | 1 |
| 6 | B launch paraleli A hold | Orta-Yüksek | Orta | 2 |
| 7 | Dinamik basket eşiği | Düşük-Orta | Düşük | — |
| 8 | XHR seat availability izleme | Yüksek | Çok yüksek | 5 |

---

*Son güncelleme: Nisan 2026*
