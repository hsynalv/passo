const { getCfg } = require('../runCfg');
const logger = require('./logger');

/**
 * Sepette tutma süresi yönetimi
 */
class BasketTimer {
    constructor() {
        this.basketStartTime = null;
        this.holdingTimeSeconds = getCfg().BASKET.HOLDING_TIME_SECONDS;
    }

    /**
     * Sepete ekleme zamanını kaydet
     */
    start() {
        this.basketStartTime = Date.now();
        logger.debug('Sepette tutma süresi başlatıldı', {
            holdingTimeSeconds: this.holdingTimeSeconds,
            startTime: new Date(this.basketStartTime).toISOString()
        });
    }

    /**
     * Kalan süreyi hesapla (saniye cinsinden)
     */
    getRemainingSeconds() {
        if (!this.basketStartTime) return null;
        
        const elapsed = Math.floor((Date.now() - this.basketStartTime) / 1000);
        const remaining = this.holdingTimeSeconds - elapsed;
        return Math.max(0, remaining);
    }

    /**
     * Geçen süreyi hesapla (saniye cinsinden)
     */
    getElapsedSeconds() {
        if (!this.basketStartTime) return 0;
        return Math.floor((Date.now() - this.basketStartTime) / 1000);
    }

    /**
     * Sepet timeout olmuş mu kontrol et
     */
    isExpired() {
        const remaining = this.getRemainingSeconds();
        return remaining !== null && remaining <= 0;
    }

    /**
     * Sepet timeout'una yaklaşıyor mu kontrol et (warning threshold)
     */
    isNearExpiry() {
        const remaining = this.getRemainingSeconds();
        if (remaining === null) return false;
        return remaining <= getCfg().BASKET.WARNING_BEFORE_TIMEOUT && remaining > 0;
    }

    /**
     * Sepet timeout'undan önce kaldırma zamanı geldi mi kontrol et
     */
    shouldRemoveBeforeTimeout() {
        const remaining = this.getRemainingSeconds();
        if (remaining === null) return false;
        return remaining <= getCfg().BASKET.REMOVE_BEFORE_TIMEOUT && remaining > 0;
    }

    /**
     * Kalan süreyi formatlanmış string olarak döndür (örn: "5 dakika 30 saniye")
     */
    getRemainingTimeFormatted() {
        const remaining = this.getRemainingSeconds();
        if (remaining === null) return 'Bilinmiyor';
        if (remaining <= 0) return 'Süre doldu';

        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;

        if (minutes > 0) {
            return `${minutes} dakika ${seconds} saniye`;
        }
        return `${seconds} saniye`;
    }

    /**
     * Sepet durumu bilgisi
     */
    getStatus() {
        return {
            startTime: this.basketStartTime ? new Date(this.basketStartTime).toISOString() : null,
            elapsedSeconds: this.getElapsedSeconds(),
            remainingSeconds: this.getRemainingSeconds(),
            remainingFormatted: this.getRemainingTimeFormatted(),
            isExpired: this.isExpired(),
            isNearExpiry: this.isNearExpiry(),
            shouldRemove: this.shouldRemoveBeforeTimeout(),
            holdingTimeSeconds: this.holdingTimeSeconds
        };
    }

    /**
     * Timer'ı sıfırla
     */
    reset() {
        this.basketStartTime = null;
    }

    syncFromRemainingSeconds(remainingSeconds) {
        const rem = Number(remainingSeconds);
        if (!Number.isFinite(rem)) return false;
        const clamped = Math.max(0, Math.min(this.holdingTimeSeconds, Math.floor(rem)));
        const elapsed = this.holdingTimeSeconds - clamped;
        this.basketStartTime = Date.now() - (elapsed * 1000);
        return true;
    }
}

/**
 * Sepet timeout kontrolü - sayfadan sepette tutma süresini okumaya çalışır
 */
async function checkBasketTimeoutFromPage(page) {
    try {
        const basketInfo = await page.evaluate(() => {
            const bubble = document.querySelector('basket-countdown .basket-remaining-container, .basket-remaining-container');
            let remainingText = null;
            if (bubble) {
                const spans = Array.from(bubble.querySelectorAll('span'));
                const candidate = spans.map(s => (s.innerText || s.textContent || '').trim()).filter(Boolean);
                const mmss = candidate.find(t => /^\d{1,2}:\d{2}$/.test(t)) || null;
                remainingText = mmss;
                if (!remainingText) {
                    const m = (bubble.innerText || bubble.textContent || '').match(/(\d{1,2}:\d{2})/);
                    remainingText = m ? m[1] : null;
                }
            }

            const timerElements = [
                ...document.querySelectorAll('[class*="timer"], [class*="countdown"], [class*="time"], [id*="timer"], [id*="countdown"]'),
                ...document.querySelectorAll('*[data-time], *[data-remaining], *[data-timeout]')
            ];

            const textContent = document.body.innerText || '';
            const timePatterns = [
                /(\d+)\s*(dakika|minute|dk|min)/gi,
                /(\d+)\s*(saniye|second|sn|sec)/gi,
                /(\d+):(\d+)/g,
            ];

            let foundTime = remainingText;
            if (!foundTime) {
                for (const pattern of timePatterns) {
                    const match = textContent.match(pattern);
                    if (match) {
                        foundTime = match[0];
                        break;
                    }
                }
            }

            return {
                timerElements: timerElements.length,
                foundTimeText: foundTime,
                bubbleFound: !!bubble,
                pageText: textContent.substring(0, 500)
            };
        });

        if (basketInfo && basketInfo.foundTimeText) {
            const t = String(basketInfo.foundTimeText).trim();
            const mmss = t.match(/^(\d{1,2}):(\d{2})$/);
            if (mmss) {
                const m = parseInt(mmss[1], 10);
                const s = parseInt(mmss[2], 10);
                if (Number.isFinite(m) && Number.isFinite(s)) {
                    basketInfo.remainingSeconds = (m * 60) + s;
                }
            }
        }

        if (basketInfo.foundTimeText) {
            logger.debug('Sayfadan sepette tutma süresi bulundu', basketInfo);
        }

        return basketInfo;
    } catch (error) {
        logger.warn('Sepette tutma süresi sayfadan okunamadı', { error: error.message });
        return null;
    }
}

module.exports = {
    BasketTimer,
    checkBasketTimeoutFromPage
};

