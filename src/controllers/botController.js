const { connect: realBrowserConnect } = require('puppeteer-real-browser');
const rebrowserPuppeteer = require('rebrowser-puppeteer-core');
const axios = require('axios');
const { randomUUID, randomInt } = require('crypto');
const fs = require('fs');
const util = require('util');
const treeKill = require('tree-kill');
const treeKillAsync = util.promisify(treeKill);
const { PNG } = require('pngjs');
const { botRequestSchema, snipeRequestSchema } = require('../validators/botRequest');

const configRoot = require('../config');
const categoryRepo = require('../repositories/categoryRepository');
const blockRepo = require('../repositories/blockRepository');
const credentialRepo = require('../repositories/credentialRepository');
const orderRecordRepo = require('../repositories/orderRecordRepository');
const proxyRepo = require('../repositories/proxyRepository');
const teamRepo = require('../repositories/teamRepository');
const { withRunCfg, getCfg } = require('../runCfg');
const { buildProviderChain, hasCaptchaSolverCredentials, solveTurnstileProxyless, solveRecaptchaV2Proxyless } = require('../services/captchaSolver');
const delay = require('../utils/delay');
const categoryLoadRegistry = require('../utils/categoryLoadRegistry');
const {
  isSoftProxyLoginFailure,
  shouldRetryLoginWithAnotherPoolProxy
} = require('../utils/proxyLoginFailure');
const { evaluateSafe, waitForFunctionSafe } = require('../utils/browserEval');
const { decryptSecret } = require('../utils/credentialCrypto');
const logger = require('../utils/logger');
const { formatError, formatSuccess } = require('../utils/messages');
const { BasketTimer, checkBasketTimeoutFromPage } = require('../utils/basketTimer');
const {confirmSwalYes, clickRemoveFromCartAndConfirm} = require('../helpers/swal');
const { captureSeatIdFromNetwork, readBasketData, readCatBlock, setCatBlockOnB, openSeatMapStrict, clickContinueInsidePage, gotoWithRetry, ensureUrlContains, isHomeUrl, SEAT_NODE_SELECTOR, ensureTcAssignedOnBasket, clickBasketDevamToOdeme, dismissPaymentInfoModalIfPresent, fillInvoiceTcAndContinue, acceptAgreementsAndContinue, fillNkolayPaymentIframe } = require('../helpers/page');
const { pickRandomSeatWithVerify, pickExactSeatWithVerify_Locked, waitForTargetSeatReady, pickExactSeatWithVerify_ReleaseAware, applyTicketQuantityDropdown, resolveApiBlockId, startSeatAvailabilityWatcher } = require('../helpers/seat');
const { buildPassoApiCookieHeader } = require('../helpers/passoSessionCookies');

function normalizeSelectedCategory(item, fallbackMode = 'scan') {
    if (!item || typeof item !== 'object') return null;
    const categoryType = String(item.categoryType || item.categoryTypeValue || '').trim();
    if (!categoryType) return null;
    const alternativeCategory = String(item.alternativeCategory || item.alternativeCategoryValue || '').trim();
    const selectionModeHint = String(item.selectionModeHint || fallbackMode || 'scan').trim().toLowerCase();
    const tc = Number(item.ticketCount);
    const ticketCount = Number.isFinite(tc) && tc >= 1 ? Math.min(Math.floor(tc), 10) : 1;
    const svgBlockId = String(item.svgBlockId || '').trim();
    return {
        id: item.id ? String(item.id) : null,
        label: String(item.label || item.name || categoryType).trim(),
        categoryType,
        alternativeCategory,
        selectionModeHint: ['legacy', 'scan', 'svg', 'scan_map'].includes(selectionModeHint) ? selectionModeHint : String(fallbackMode || 'scan').trim().toLowerCase(),
        ticketCount,
        adjacentSeats: item.adjacentSeats === true,
        ...(svgBlockId ? { svgBlockId } : {})
    };
}

/**
 * Üyeliğe kategori atanmışsa yalnızca o kategoriler (DB) kullanılır; atanmamışsa arayüz seçimi geçerlidir.
 * Arayüz seçimi üyeliği kısıtlamaz — öncelik üyelikte.
 */
async function resolveCategoriesForCredential(teamId, selectedCategories, credentialCategoryIds, categorySelectionMode) {
  const ids = Array.isArray(credentialCategoryIds)
    ? credentialCategoryIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (!ids.length || !teamId) {
    return selectedCategories;
  }
  const repoCategories = await categoryRepo.getCategoriesByIds(teamId, ids);
  if (!repoCategories.length) {
    return selectedCategories;
  }
  return repoCategories
    .map((item) => normalizeSelectedCategory({
      id: item.id,
      label: item.label,
      categoryType: item.categoryTypeValue,
      alternativeCategory: item.alternativeCategoryValue,
      selectionModeHint: item.selectionModeHint,
      sortOrder: item.sortOrder,
      ticketCount: item.ticketCount,
      adjacentSeats: item.adjacentSeats,
      svgBlockId: item.svgBlockId
    }, categorySelectionMode))
    .filter(Boolean);
}

/**
 * Blok hedefini normalleştirir.
 * @param {object} block - blockRepo.mapBlock çıktısı
 * @returns {object|null}
 */
function normalizeSelectedBlock(block) {
  if (!block || !block.id) return null;
  return {
    id: block.id,
    label: String(block.label || ''),
    selectionMode: block.selectionMode === 'legacy' ? 'legacy' : 'svg',
    categoryId: block.categoryId || null,
    svgBlockId: block.svgBlockId || null,
    apiBlockId: block.apiBlockId || null,
    categoryType: block.categoryType || null,
    blockVal: block.blockVal || null,
    ticketCount: Number.isFinite(block.ticketCount) && block.ticketCount >= 1 ? block.ticketCount : 1,
    adjacentSeats: block.adjacentSeats === true,
  };
}

/**
 * Seçili blok listesinden categoryId → block Map'i oluşturur.
 * categoryId olmayan (bağımsız) bloklar atlanır.
 */
function buildBlockCategoryMap(selectedBlocks) {
  const map = new Map();
  for (const block of Array.isArray(selectedBlocks) ? selectedBlocks : []) {
    if (block && block.categoryId) {
      if (!map.has(block.categoryId)) {
        map.set(block.categoryId, block);
      }
    }
  }
  return map;
}

/**
 * Üyeliğe blok atanmışsa yalnızca o bloklar kullanılır.
 * credentialBlockIds yoksa seçili bloklar döner.
 */
async function resolveBlocksForCredential(teamId, selectedBlocks, credentialBlockIds) {
  const ids = Array.isArray(credentialBlockIds)
    ? credentialBlockIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (!ids.length || !teamId) {
    return selectedBlocks;
  }
  const repoBlocks = await blockRepo.getBlocksByIds(teamId, ids);
  if (!repoBlocks.length) {
    return selectedBlocks;
  }
  return repoBlocks.map(normalizeSelectedBlock).filter(Boolean);
}

function snapshotLooksLikeCloudflareBlock(snap, httpStatus) {
    if (!snap || typeof snap !== 'object') return false;
    const t = String(snap.title || '').toLowerCase();
    if (t.includes('attention required')) return true;
    if (t.includes('just a moment')) return true;
    if (t.includes('sorry, you have been blocked')) return true;
    const ic = Number(snap.inputCount) || 0;
    if (Number(httpStatus) === 403 && ic < 2) return true;
    return false;
}

function buildCategoryRoamTexts(selectedCategories, fallbackCategoryType, fallbackAlternativeCategory) {
    const values = [];
    for (const item of Array.isArray(selectedCategories) ? selectedCategories : []) {
        if (!item) continue;
        if (item.label) values.push(String(item.label).trim());
        if (item.categoryType) values.push(String(item.categoryType).trim());
        if (item.alternativeCategory) values.push(String(item.alternativeCategory).trim());
    }
    if (fallbackCategoryType) values.push(String(fallbackCategoryType).trim());
    if (fallbackAlternativeCategory) values.push(String(fallbackAlternativeCategory).trim());
    return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSvgMatchText(value) {
    const map = {
        'c': 'c', 'ç': 'c',
        'g': 'g', 'ğ': 'g',
        'i': 'i', 'ı': 'i', 'İ': 'i',
        'o': 'o', 'ö': 'o',
        's': 's', 'ş': 's',
        'u': 'u', 'ü': 'u'
    };
    return String(value || '')
        .split('')
        .map((ch) => {
            const low = ch.toLowerCase();
            return Object.prototype.hasOwnProperty.call(map, low) ? map[low] : low;
        })
        .join('')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function buildSvgCategorySegments(label) {
    const normalized = normalizeSvgMatchText(label);
    if (!normalized) return [];
    const pieces = normalized.split('/').map((part) => part.trim()).filter(Boolean);
    const parsed = pieces.map((piece) => {
        let base = piece;
        let from = '';
        let to = '';
        let m = piece.match(/\s([a-z])\s*-\s*([a-z])$/i);
        if (m) {
            base = piece.slice(0, m.index).trim();
            from = m[1];
            to = m[2];
        } else {
            m = piece.match(/\s([a-z])$/i);
            if (m) {
                base = piece.slice(0, m.index).trim();
                from = m[1];
                to = m[1];
            }
        }
        return { raw: piece, base: base || piece, from, to };
    });
    const inherited = parsed.slice().reverse().find((item) => item.base && item.from);
    if (inherited && parsed.length > 1) {
        for (const item of parsed) {
            if (item.base && !item.from) {
                item.from = inherited.from;
                item.to = inherited.to;
            }
        }
    }
    return parsed.filter((item) => item.base);
}

function getSvgMeaningfulTokens(value) {
    const stop = new Set([
        'tribun', 'tribunu', 'tribunleri', 'blok', 'bloklari', 'blogu',
        'kategori', 'kati'
    ]);
    return Array.from(new Set(
        normalizeSvgMatchText(value)
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token && token.length >= 2 && !stop.has(token))
    ));
}

function isSvgLetterWithinRange(letter, from, to) {
    const cur = String(letter || '').trim().toLowerCase();
    const start = String(from || '').trim().toLowerCase();
    const end = String(to || '').trim().toLowerCase();
    if (!cur || !start || !end) return false;
    const code = cur.charCodeAt(0);
    const a = start.charCodeAt(0);
    const b = end.charCodeAt(0);
    if (!Number.isFinite(code) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    return code >= Math.min(a, b) && code <= Math.max(a, b);
}

function getSvgCategoryMatchScore(tooltipText, categoryTexts = []) {
    const tooltipNorm = normalizeSvgMatchText(tooltipText);
    if (!tooltipNorm) return 0;
    const tooltipTokens = getSvgMeaningfulTokens(tooltipNorm);
    const tooltipBlockMatch = tooltipNorm.match(/\b([a-z])\s*blok\b/i);
    const tooltipBlockLetter = tooltipBlockMatch ? String(tooltipBlockMatch[1] || '').toLowerCase() : '';
    let best = 0;
    for (const text of Array.isArray(categoryTexts) ? categoryTexts : []) {
        const want = normalizeSvgMatchText(text);
        if (!want) continue;
        if (tooltipNorm === want) best = Math.max(best, 120);
        else if (tooltipNorm.includes(want) || want.includes(tooltipNorm)) best = Math.max(best, 100);
        const wantTokens = getSvgMeaningfulTokens(want);
        if (wantTokens.length) {
            const hits = wantTokens.filter((token) => tooltipNorm.includes(token) || tooltipTokens.includes(token));
            const coverage = hits.length / wantTokens.length;
            if (coverage >= 1) best = Math.max(best, 98);
            else if (coverage >= 0.75) best = Math.max(best, 88);
            else if (coverage >= 0.5 && hits.length >= 2) best = Math.max(best, 72);
            else if (hits.length >= 1) best = Math.max(best, 45);
        }
        const segments = buildSvgCategorySegments(text);
        for (const segment of segments) {
            if (!segment?.base || !tooltipNorm.includes(segment.base)) continue;
            if (segment.from) {
                if (tooltipBlockLetter && isSvgLetterWithinRange(tooltipBlockLetter, segment.from, segment.to)) {
                    best = Math.max(best, 95);
                } else {
                    best = Math.max(best, 55);
                }
            } else {
                best = Math.max(best, 70);
            }
        }
    }
    return best;
}

/** Haritadan örneklenen renk ile lejant rengi arasındaki mesafeyi 0–120 “uygunluk” skoruna çevirir. */
function svgLegendColorFitScore(distance) {
    if (!Number.isFinite(distance) || distance === Number.POSITIVE_INFINITY) return 0;
    return Math.max(0, 120 - Math.min(120, distance * 1.35));
}

/**
 * SVG: hedef kategori (lejant satırı başlığı eşlemesi) + blok renginin lejant rengine yakınlığı.
 * İkisi de zayıfsa skor 0 — yalnız blok adı veya yalnız rastgele renk tek başına kazanmasın.
 */
function svgCategoryColorCombinedScore(legendTitleScore, colorDistance) {
    const colorFit = svgLegendColorFitScore(colorDistance);
    if (!legendTitleScore || !colorFit) return 0;
    return Math.round((legendTitleScore * colorFit) / 100);
}

function parseRgbColorString(value) {
    const m = String(value || '').match(/rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*([0-9.]+))?\s*\)/i);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const a = m[4] == null ? 1 : Number(m[4]);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
}

function colorDistance(a, b) {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const dr = Number(a.r || 0) - Number(b.r || 0);
    const dg = Number(a.g || 0) - Number(b.g || 0);
    const db = Number(a.b || 0) - Number(b.b || 0);
    return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function samplePngPatchColor(png, x, y, radius = 3) {
    if (!png || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const w = Number(png.width || 0);
    const h = Number(png.height || 0);
    if (!w || !h) return null;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let count = 0;
    const rx = Math.max(0, Math.floor(Number(radius) || 0));
    const cx = Math.max(0, Math.min(w - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(h - 1, Math.round(y)));
    for (let yy = Math.max(0, cy - rx); yy <= Math.min(h - 1, cy + rx); yy++) {
        for (let xx = Math.max(0, cx - rx); xx <= Math.min(w - 1, cx + rx); xx++) {
            const idx = ((yy * w) + xx) << 2;
            const alpha = Number(png.data[idx + 3] ?? 255) / 255;
            if (alpha <= 0) continue;
            sr += Number(png.data[idx] || 0) * alpha;
            sg += Number(png.data[idx + 1] || 0) * alpha;
            sb += Number(png.data[idx + 2] || 0) * alpha;
            count += alpha;
        }
    }
    if (!count) return null;
    return {
        r: Math.round(sr / count),
        g: Math.round(sg / count),
        b: Math.round(sb / count)
    };
}

function sanitizeStartRequestForLog(value) {
    const secretKeyRe = /^(password|password2|cvv|proxyPassword|fanCardCode|identity|sicilNo|priorityTicketCode|priorityPhone|priorityTckn|cardNumber|encryptedPassword|ANTICAPTCHA_KEY|CAPSOLVER_KEY|TWOCAPTCHA_KEY)$/i;

    const visit = (input, keyName = '') => {
        if (input == null) return input;
        if (Array.isArray(input)) return input.map((item) => visit(item));
        if (typeof input !== 'object') {
            if (secretKeyRe.test(String(keyName || ''))) {
                if (/cardNumber/i.test(String(keyName || ''))) {
                    const raw = String(input);
                    return raw.replace(/\d(?=\d{4})/g, '*');
                }
                return '***';
            }
            return input;
        }

        const out = {};
        for (const [k, v] of Object.entries(input)) {
            if (secretKeyRe.test(String(k || ''))) {
                if (/cardNumber/i.test(String(k || ''))) {
                    const raw = v == null ? '' : String(v);
                    out[k] = raw.replace(/\d(?=\d{4})/g, '*');
                } else {
                    out[k] = '***';
                }
                continue;
            }
            out[k] = visit(v, k);
        }
        return out;
    };

    return visit(value);
}

const BASKET_ROOT_SELECTOR = '.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]';

async function getBasketItemCountSafe(page) {
    if (!page) return 0;
    try {
        const data = await readBasketData(page);
        const count = Number(data?.itemCount);
        if (Number.isFinite(count) && count >= 0) return Math.max(0, count);
    } catch {}

    try {
        const count = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const countExactLabels = (label) => {
                const want = String(label || '').trim().toLowerCase();
                if (!want) return 0;
                const nodes = Array.from(document.querySelectorAll('.basket-span, div, span, li, p, dt'));
                let total = 0;
                for (const n of nodes) {
                    if (norm(n.textContent) === want) total++;
                }
                return total;
            };
            return Math.max(
                countExactLabels('koltuk'),
                countExactLabels('sıra'),
                countExactLabels('blok'),
                countExactLabels('tribün')
            );
        }).catch(() => 0);
        return Math.max(0, Number(count) || 0);
    } catch {}

    return 0;
}

async function clearBasketFully(page, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT;
    const maxRounds = Number.isFinite(opts.maxRounds) ? Math.max(1, opts.maxRounds) : 8;
    const settlePollMs = Number.isFinite(opts.settlePollMs) ? Math.max(100, opts.settlePollMs) : 250;

    let initialCount = await getBasketItemCountSafe(page);
    let remainingCount = initialCount;
    let removedClicks = 0;

    for (let round = 1; round <= maxRounds; round++) {
        remainingCount = await getBasketItemCountSafe(page);
        if (remainingCount <= 0) {
            return { ok: true, initialCount, remainingCount: 0, removedClicks, rounds: round - 1 };
        }

        const removed = await clickRemoveFromCartAndConfirm(page, timeoutMs);
        if (!removed) {
            remainingCount = await getBasketItemCountSafe(page);
            return { ok: remainingCount <= 0, initialCount, remainingCount, removedClicks, rounds: round, reason: 'remove_click_failed' };
        }

        removedClicks++;
        const beforeCount = remainingCount;
        const settleUntil = Date.now() + Math.max(2000, Number(timeoutMs) || 0);
        while (Date.now() < settleUntil) {
            await delay(settlePollMs);
            remainingCount = await getBasketItemCountSafe(page);
            if (remainingCount <= 0 || remainingCount < beforeCount) break;
        }
    }

    remainingCount = await getBasketItemCountSafe(page);
    return { ok: remainingCount <= 0, initialCount, remainingCount, removedClicks, rounds: maxRounds, reason: 'remaining_items' };
}

async function parkHolderOnBasket(page, basketTimer, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const email = opts.email || null;
    const password = opts.password || null;
    const relogin = typeof opts.reloginIfRedirected === 'function' ? opts.reloginIfRedirected : null;
    const label = String(opts.label || 'holder').trim() || 'holder';

    try {
        if (relogin && email && password) {
            try { await relogin(page, email, password); } catch {}
        }
        await gotoWithRetry(page, 'https://www.passo.com.tr/tr/sepet', {
            retries: 2,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: '/sepet',
            rejectIfHome: false,
            backoffMs: 450
        });
        await page.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 12000 }).catch(() => {});
    } catch {}

    try {
        const basketInfo = await checkBasketTimeoutFromPage(page);
        const rem = Number(basketInfo?.remainingSeconds);
        if (basketTimer && Number.isFinite(rem) && rem >= 0) {
            basketTimer.syncFromRemainingSeconds(rem);
            logger.info(`${label}:basket_timer_synced_from_ui`, { remainingSeconds: rem, foundTimeText: basketInfo?.foundTimeText || null });
            return { ok: true, synced: true, remainingSeconds: rem, basketInfo };
        }
        return { ok: true, synced: false, basketInfo: basketInfo || null };
    } catch {
        return { ok: false, synced: false };
    }
}

function normalizeHeldSeats(seatInfo) {
    const base = seatInfo && typeof seatInfo === 'object' ? seatInfo : null;
    const raw = [
        ...(base ? [base] : []),
        ...(Array.isArray(base?.heldSeats) ? base.heldSeats : [])
    ];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const normalized = {
            tribune: item.tribune != null ? String(item.tribune) : '',
            block: item.block != null ? String(item.block) : '',
            row: item.row != null ? String(item.row) : '',
            seat: item.seat != null ? String(item.seat) : '',
            blockId: item.blockId != null ? String(item.blockId) : '',
            seatId: item.seatId != null ? String(item.seatId) : '',
            combined: item.combined != null ? String(item.combined) : ''
        };
        if (!normalized.combined) {
            normalized.combined = `${normalized.tribune} ${normalized.block} ${normalized.row} ${normalized.seat}`.trim();
        }
        const key = normalized.seatId || normalized.combined;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}

function mergeSeatBundle(primarySeat, pickedSeats) {
    const seats = normalizeHeldSeats({
        ...(primarySeat && typeof primarySeat === 'object' ? primarySeat : {}),
        heldSeats: Array.isArray(pickedSeats) ? pickedSeats : []
    });
    const first = seats[0] || (primarySeat && typeof primarySeat === 'object' ? primarySeat : null);
    if (!first) return primarySeat || null;
    return {
        ...(primarySeat && typeof primarySeat === 'object' ? primarySeat : {}),
        ...first,
        heldSeats: seats,
        itemCount: seats.length || Number(primarySeat?.itemCount) || 1
    };
}

async function pickExactSeatBundleReleaseAware(page, targetSeatInfo, maxMs, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const targets = normalizeHeldSeats(targetSeatInfo);
    if (!targets.length) {
        const single = await pickExactSeatWithVerify_ReleaseAware(page, targetSeatInfo, maxMs);
        return single ? mergeSeatBundle(single, [single]) : single;
    }

    const deadline = Date.now() + Math.max(10000, Number(maxMs) || 0);
    const pickedSeats = [];

    for (let idx = 0; idx < targets.length; idx++) {
        const target = targets[idx];
        const remainingTargets = Math.max(1, targets.length - idx);
        const remainingMs = Math.max(10000, deadline - Date.now());
        const perSeatMs = idx === targets.length - 1
            ? remainingMs
            : Math.max(10000, Math.min(45000, Math.floor(remainingMs / remainingTargets)));

        try {
            if (typeof opts.audit === 'function') {
                opts.audit('exact_pick_seat_start', {
                    seatId: target.seatId || null,
                    row: target.row || null,
                    seat: target.seat || null,
                    index: idx + 1,
                    total: targets.length,
                    maxMs: perSeatMs
                });
            }
        } catch {}

        const targetWithRecovery = {
            ...target,
            __recoveryOptions: targetSeatInfo?.__recoveryOptions || undefined
        };
        const picked = await pickExactSeatWithVerify_ReleaseAware(page, targetWithRecovery, perSeatMs);
        pickedSeats.push({
            ...target,
            ...(picked && typeof picked === 'object' ? picked : {})
        });

        try {
            if (typeof opts.audit === 'function') {
                opts.audit('exact_pick_seat_done', {
                    seatId: target.seatId || null,
                    pickedSeatId: picked?.seatId || null,
                    row: picked?.row || target.row || null,
                    seat: picked?.seat || target.seat || null,
                    index: idx + 1,
                    total: targets.length
                });
            }
        } catch {}
    }

    return mergeSeatBundle(targetSeatInfo, pickedSeats);
}

async function prepareSeatSelectionControls(page, logContext = 'seatPrep') {
    if (!page) return { ok: false, reason: 'no_page' };
    const appearDeadline = Date.now() + 12000;

    let membershipResult = null;
    let waitedMs = 0;

    try {
        do {
            try {
                await page.evaluate(() => {
                    const overlays = document.querySelectorAll('.form-control-disabled');
                    for (const el of overlays) {
                        try { el.style.setProperty('display', 'none', 'important'); } catch {}
                        try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                    }
                });
            } catch {}

            membershipResult = await page.evaluate(() => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const isVisible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r || r.width < 2 || r.height < 2) return false;
                    const st = window.getComputedStyle(el);
                    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                    return true;
                };
                const selects = Array.from(document.querySelectorAll('select, select.form-control')).filter(isVisible);
                const memberSelect = selects.find(s => {
                    const opts = Array.from(s.options || []);
                    return opts.some(o => norm(o.textContent).includes('üyelik') || norm(o.textContent).includes('kampanya'));
                });
                if (!memberSelect) return { ok: false, reason: 'no_membership_select', visibleSelectCount: selects.length };

                const opts = Array.from(memberSelect.options || []);
                const currentVal = memberSelect.value;
                if (currentVal && !/^0:\s*null$/i.test(currentVal)) {
                    return { ok: true, already: true, value: currentVal, text: norm(memberSelect.options[memberSelect.selectedIndex]?.textContent || ''), visibleSelectCount: selects.length };
                }

                const validOpt = opts.find(o => o.value && !/^0:\s*null$/i.test(o.value) && !o.disabled);
                if (!validOpt) return { ok: false, reason: 'no_valid_option', optionCount: opts.length, visibleSelectCount: selects.length };

                memberSelect.value = validOpt.value;
                memberSelect.dispatchEvent(new Event('input', { bubbles: true }));
                memberSelect.dispatchEvent(new Event('change', { bubbles: true }));
                try { memberSelect.dispatchEvent(new Event('ngModelChange', { bubbles: true })); } catch {}
                return { ok: true, selected: true, value: validOpt.value, text: norm(validOpt.textContent), visibleSelectCount: selects.length };
            });

            if (membershipResult?.ok || membershipResult?.reason !== 'no_membership_select') break;
            if (Date.now() >= appearDeadline) break;
            await delay(300);
            waitedMs += 300;
        } while (true);

        logger.info(`${logContext}:membership_type_select`, { ...(membershipResult || {}), waitedMs });

        if (membershipResult?.selected) {
            await delay(1500);
            try {
                await page.evaluate(() => {
                    const overlays = document.querySelectorAll('.form-control-disabled');
                    for (const el of overlays) {
                        try { el.style.setProperty('display', 'none', 'important'); } catch {}
                        try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                    }
                });
            } catch {}
        }

        return { ok: !!membershipResult?.ok, membershipResult, waitedMs };
    } catch (e) {
        logger.warn(`${logContext}:membership_type_select_failed`, { error: e?.message || String(e), waitedMs });
        return { ok: false, error: e?.message || String(e), waitedMs };
    }
}

/**
 * Blok hedefleri için round-robin seçici.
 * selectedBlocks boşsa null döner — çağrıcı mevcut kategori seçiciyi kullanır.
 */
function createBlockChooser(selectedBlocks) {
    const list = Array.isArray(selectedBlocks) ? selectedBlocks.filter(Boolean) : [];
    if (!list.length) return null;
    let idx = 0;
    return {
        list,
        hasBlocks: true,
        peekNext() { return list[idx % list.length] || null; },
        /**
         * Aktif blok hedefini seçer (koltuk seçim sayfasında).
         * SVG seçim başarısız olursa legacy fallback'e geçer.
         */
        async choose(page, selectionMode) {
            const block = list[idx % list.length];
            idx = (idx + 1) % list.length;
            if (!block) return null;
            let catBlock;
            if (block.selectionMode === 'svg') {
                catBlock = { svgBlockId: block.svgBlockId, categoryText: block.label || '' };
            } else {
                catBlock = {
                    categoryText: block.categoryType || block.label || '',
                    blockVal: block.blockVal || '',
                    blockText: block.label || '',
                };
            }
            const seatInfo = block.selectionMode === 'svg'
                ? { svgBlockId: block.svgBlockId, blockId: String(block.apiBlockId || '') }
                : {};
            const ok = await applyCategoryBlockSelection(page, selectionMode, catBlock, seatInfo);
            // SVG seçim başarısız olduysa ve legacy fallback alanları varsa legacy'ye dön
            if (!ok && block.selectionMode === 'svg' && block.categoryType && block.blockVal) {
                const legacyCatBlock = {
                    categoryText: block.categoryType,
                    blockVal: block.blockVal,
                    blockText: block.label || '',
                };
                await setCatBlockOnB(page, legacyCatBlock);
                return {
                    chosenBlock: block,
                    svgBlockId: null,
                    catBlock: legacyCatBlock,
                };
            }
            return {
                chosenBlock: block,
                svgBlockId: block.selectionMode === 'svg' ? block.svgBlockId : null,
                catBlock,
            };
        }
    };
}

/**
 * SVG mod için direkt blok seçici.
 * Kategori seçim adımını tamamen atlar; seçilen blokları round-robin ile doğrudan
 * SVG harita üzerinde tıklar. Kategoriler sadece UI organizasyonu için kullanılır.
 */
function createSvgDirectBlockChooser(svgBlocks) {
    const blocks = (Array.isArray(svgBlocks) ? svgBlocks : []).filter((b) => b && b.svgBlockId);
    let nextIdx = 0;
    return {
        list: [],
        peekNext() {
            if (!blocks.length) return null;
            const b = blocks[nextIdx % blocks.length];
            return { id: null, label: b.label || b.svgBlockId, categoryType: null, svgBlockId: b.svgBlockId };
        },
        getRoamTexts: () => [],
        rebindLoadKey: () => {},
        async choose(page) {
            if (!blocks.length) return null;
            const block = blocks[nextIdx % blocks.length];
            nextIdx = (nextIdx + 1) % blocks.length;
            logger.info('categoryBlock:svg_direct_block_choose', {
                blockId: block.id,
                svgBlockId: block.svgBlockId,
                label: block.label,
                nextIdx,
                total: blocks.length,
            });
            const ok = await selectSvgBlockById(page, block.svgBlockId, {
                categoryId: null,
                categoryLabel: null,
                categoryType: null,
            });
            if (ok) {
                return { svgBlockId: block.svgBlockId, chosenCategory: null, chosenBlock: block };
            }
            logger.warn('categoryBlock:svg_direct_block_failed', { svgBlockId: block.svgBlockId, blockId: block.id });
            return null;
        },
    };
}

/**
 * SVG mod + blok seçilmişse direkt blok seçiciyi, aksi halde kategori seçiciyi döner.
 * Legacy modda bloklar kategori override olarak eklenir.
 */
function buildAccountChooser(accountAllowedBlocks, accountAllowedCategories, resolvedCategoryType, resolvedAlternativeCategory, categorySelectionMode, balanceOpts) {
    const mode = String(categorySelectionMode || 'scan').toLowerCase();
    if (mode !== 'legacy') {
        const svgBlocks = accountAllowedBlocks.filter((b) => b && b.svgBlockId);
        if (svgBlocks.length > 0) {
            return { chooser: createSvgDirectBlockChooser(svgBlocks), blockMap: new Map() };
        }
    }
    // Legacy mod veya SVG blok yok — kategori seçici + legacy block override map
    const legacyBlocks = accountAllowedBlocks.filter((b) => b && !b.svgBlockId);
    const blockMap = buildBlockCategoryMap(legacyBlocks);
    return {
        chooser: createCategoryChooser(
            accountAllowedCategories,
            resolvedCategoryType,
            resolvedAlternativeCategory,
            categorySelectionMode,
            balanceOpts,
            blockMap.size > 0 ? blockMap : null
        ),
        blockMap,
    };
}

function createCategoryChooser(selectedCategories, fallbackCategoryType, fallbackAlternativeCategory, defaultMode = 'scan', balanceOpts = null, blockOverrideMap = null) {
    const normalized = (Array.isArray(selectedCategories) ? selectedCategories : [])
        .map((item) => normalizeSelectedCategory(item, defaultMode))
        .filter(Boolean);
    const balanceRunId = balanceOpts && String(balanceOpts.runId || '').trim();
    const balanceTicketCount = Number(balanceOpts?.ticketCount);
    const workerIndex = Number.isFinite(Number(balanceOpts?.workerIndex)) ? Number(balanceOpts.workerIndex) : null;
    const useLoadBalance = !!(balanceRunId && balanceTicketCount === 1 && normalized.length > 1);

    let nextIndex = 0;
    if (!useLoadBalance && workerIndex != null && normalized.length > 0) {
        nextIndex = workerIndex % normalized.length;
    }
    /** Son başarılı kategori indeksi; seatmap recover’da nextIndex ilerlemesin diye */
    let lastCommittedCategoryIndex = null;
    let lastLoadKey = null;

    const releaseLoadKey = () => {
        if (balanceRunId && lastLoadKey) {
            categoryLoadRegistry.adjustLoad(balanceRunId, lastLoadKey, -1);
            lastLoadKey = null;
        }
    };

    const pickBalancedIndex = () => {
        const loads = normalized.map((c, j) => ({
            j,
            L: categoryLoadRegistry.getLoad(balanceRunId, categoryLoadRegistry.slotKeyFromCategory(c))
        }));
        const minL = loads.length ? Math.min(...loads.map((x) => x.L)) : 0;
        const ties = loads.filter((x) => x.L === minL).map((x) => x.j);
        if (!ties.length) return 0;
        return ties[randomInt(0, ties.length)];
    };

    const peekNext = () => {
        const chosen = normalized[nextIndex] || normalized[0] || null;
        if (chosen) return chosen;
        const fallbackType = String(fallbackCategoryType || '').trim();
        const fallbackAlt = String(fallbackAlternativeCategory || '').trim();
        if (!fallbackType && !fallbackAlt) return null;
        return {
            id: null,
            label: fallbackType || fallbackAlt,
            categoryType: fallbackType || null,
            alternativeCategory: fallbackAlt || null,
            selectionModeHint: String(defaultMode || 'scan').trim().toLowerCase()
        };
    };

    const rebindLoadKey = (newKeyFull) => {
        if (!useLoadBalance || !balanceRunId || !lastLoadKey || !newKeyFull || newKeyFull === lastLoadKey) return;
        categoryLoadRegistry.migrateKey(balanceRunId, lastLoadKey, newKeyFull);
        lastLoadKey = newKeyFull;
    };

    return {
        list: normalized,
        peekNext,
        getRoamTexts: () => buildCategoryRoamTexts(normalized, fallbackCategoryType, fallbackAlternativeCategory),
        rebindLoadKey: useLoadBalance ? rebindLoadKey : () => {},
        async choose(page, categoryType, alternativeCategory, selectionMode, opts = null) {
            const reapplyLast = opts && opts.reapplyLastCommitted === true;
            if (!normalized.length) {
                return chooseCategoryAndRandomBlock(
                    page,
                    fallbackCategoryType || categoryType,
                    fallbackAlternativeCategory || alternativeCategory,
                    selectionMode || defaultMode,
                    ''
                );
            }
            const nlen = normalized.length;
            let idx;
            if (reapplyLast) {
                idx = lastCommittedCategoryIndex != null
                    ? lastCommittedCategoryIndex
                    : (nlen ? (nextIndex + nlen - 1) % nlen : 0);
            } else if (useLoadBalance) {
                releaseLoadKey();
                idx = pickBalancedIndex();
                const k = categoryLoadRegistry.slotKeyFromCategory(normalized[idx]);
                categoryLoadRegistry.adjustLoad(balanceRunId, k, 1);
                lastLoadKey = k;
                nextIndex = (idx + 1) % nlen;
            } else {
                idx = nextIndex;
                nextIndex = normalized.length > 1 ? ((nextIndex + 1) % nlen) : 0;
            }
            const chosen = normalized[idx] || normalized[0];
            const mode = String(selectionMode || chosen.selectionModeHint || defaultMode || 'scan').trim().toLowerCase();
            logger.info('categoryBlock:selected_category_candidate', {
                categoryId: chosen.id || null,
                label: chosen.label || null,
                categoryType: chosen.categoryType,
                svgBlockId: chosen.svgBlockId || null,
                alternativeCategory: chosen.alternativeCategory || null,
                mode,
                nextIndex,
                total: normalized.length,
                reapplyLastCommitted: reapplyLast || false,
                usedIndex: idx,
                categoryLoadBalance: useLoadBalance || false,
                categorySlotKey: useLoadBalance && !reapplyLast ? categoryLoadRegistry.slotKeyFromCategory(chosen) : null
            });
            const svgBid = String(chosen.svgBlockId || '').trim();
            // Seçili blok haritasından bu kategoriye bağlı blok varsa önce onu dene
            const blockOverride = (blockOverrideMap && chosen.id) ? blockOverrideMap.get(String(chosen.id)) : null;
            const overrideSvgBid = blockOverride?.svgBlockId ? String(blockOverride.svgBlockId).trim() : '';
            const effectiveSvgBid = overrideSvgBid || svgBid;
            if (effectiveSvgBid) {
                const catLog = {
                    categoryId: chosen.id || null,
                    categoryLabel: chosen.label || null,
                    categoryType: chosen.categoryType || null,
                    svgBlockId: effectiveSvgBid,
                    blockOverride: !!overrideSvgBid,
                };
                logger.info('categoryBlock:direct_svg_block_from_db_category', catLog);
                const directOk = await selectSvgBlockById(page, effectiveSvgBid, {
                    categoryId: chosen.id,
                    categoryLabel: chosen.label,
                    categoryType: chosen.categoryType
                });
                if (directOk) {
                    lastCommittedCategoryIndex = idx;
                    return { svgBlockId: effectiveSvgBid, chosenCategory: chosen, chosenBlock: blockOverride || null };
                }
                logger.warn('categoryBlock:direct_svg_block_failed_fallback_text', catLog);
                // SVG blok başarısız — legacy fallback varsa dene
                if (blockOverride?.selectionMode !== 'svg' || (blockOverride?.categoryType && blockOverride?.blockVal)) {
                    // Block override için legacy fallback
                    const legacyCat = blockOverride?.categoryType || chosen.categoryType;
                    const legacyAlt = chosen.alternativeCategory;
                    const result2 = await chooseCategoryAndRandomBlock(page, legacyCat, legacyAlt, mode, '');
                    if (result2 && typeof result2 === 'object') result2.chosenCategory = chosen;
                    if (result2) lastCommittedCategoryIndex = idx;
                    return result2;
                }
            }
            const result = await chooseCategoryAndRandomBlock(
                page,
                chosen.categoryType,
                chosen.alternativeCategory,
                mode,
                chosen.svgBlockId
            );
            if (result && typeof result === 'object') result.chosenCategory = chosen;
            if (result) lastCommittedCategoryIndex = idx;
            return result;
        }
    };
}

/**
 * openSeatMapStrict koltuk node'larını beklediği için blok tıklamadan önce 10–20sn boşa gidebiliyor.
 * Burada yalnızca svgLayout + hedef blok id için hızlı yol: hazırsa hiç bekleme; değilse tek tık + kısa poll.
 */
async function ensureSvgBlockLayerVisible(page, blockId, logBase) {
    const bid = String(blockId || '').trim();
    if (!bid) return;
    const ensureStarted = Date.now();

    const snapshot = async () => page.evaluate((id) => {
        const hasLayout = !!document.querySelector('svg.svgLayout, .svgLayout');
        const el = document.getElementById(id);
        return { hasLayout, hasBlock: !!el };
    }, bid).catch(() => ({ hasLayout: false, hasBlock: false }));

    let st = await snapshot();
    if (st.hasLayout && st.hasBlock) {
        logger.info('categoryBlock:ensureSvgBlockLayer_fast_path', { ...logBase, note: 'svgLayout+block zaten DOMda', waitMs: Date.now() - ensureStarted });
        return;
    }

    try {
        await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const byId = document.getElementById('custom_seat_button');
            const byText = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).find((el) => {
                const t = norm(el.innerText || el.textContent || el.value || '');
                if (!t) return false;
                return (
                    t.includes('kendim seçmek istiyorum') ||
                    t === 'seçimi değiştir' ||
                    (t.includes('koltuk') && (t.includes('seç') || t.includes('seçim') || t.includes('değiştir')))
                );
            });
            const btn = byId || byText;
            if (!btn || btn.disabled) return;
            try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            try { btn.click(); } catch {}
        });
    } catch {}

    const deadline = Date.now() + 8500;
    while (Date.now() < deadline) {
        st = await snapshot();
        if (st.hasLayout && st.hasBlock) {
            logger.info('categoryBlock:ensureSvgBlockLayer_after_self_select', { ...logBase, waitMs: Date.now() - ensureStarted });
            return;
        }
        await delay(100);
    }

    logger.warn('categoryBlock:ensureSvgBlockLayer_fallback_openSeatMapStrict', { ...logBase });
    try {
        await openSeatMapStrict(page);
    } catch {}
}

async function selectSvgBlockById(page, blockId, meta = {}) {
    const safeId = String(blockId || '').trim();
    if (!safeId) return false;

    const logBase = {
        svgBlockId: safeId,
        categoryId: meta.categoryId != null ? String(meta.categoryId) : null,
        categoryLabel: meta.categoryLabel != null ? String(meta.categoryLabel) : null,
        categoryType: meta.categoryType != null ? String(meta.categoryType) : null
    };
    logger.info('categoryBlock:selectSvgBlockById_start', logBase);

    await ensureSvgBlockLayerVisible(page, safeId, logBase);

    try {
        await page.waitForSelector('svg.svgLayout, .svgLayout', { timeout: 6000 });
    } catch (e) {
        logger.warn('categoryBlock:selectSvgBlockById_svg_layout_wait', { ...logBase, error: e?.message || String(e) });
    }

    let effectiveId = safeId;
    try {
        await page.waitForFunction(
            (bid) => {
                const el = document.getElementById(bid);
                if (!el) return false;
                try {
                    const r = el.getBoundingClientRect();
                    if (r && r.width > 1 && r.height > 1) return true;
                } catch {}
                try {
                    const b = typeof el.getBBox === 'function' ? el.getBBox() : null;
                    return !!(b && b.width > 0 && b.height > 0);
                } catch {
                    return true;
                }
            },
            { timeout: 10000, polling: 100 },
            effectiveId
        );
    } catch {
        const altId = await page.evaluate((want) => {
            const w = String(want || '').toLowerCase();
            const nodes = document.querySelectorAll('svg.svgLayout g[id], .svgLayout g[id], svg g[id].svgBlock, .svgBlock[id]');
            for (const n of nodes) {
                const id = n.getAttribute?.('id') || n.id;
                if (id && String(id).toLowerCase() === w) return String(id);
            }
            const all = document.querySelectorAll('[id]');
            for (const n of all) {
                const id = n.getAttribute?.('id') || n.id;
                if (id && String(id).toLowerCase() === w && /^block/i.test(String(id))) return String(id);
            }
            return null;
        }, safeId).catch(() => null);

        if (altId) {
            effectiveId = altId;
            try {
                await page.waitForFunction(
                    (bid) => {
                        const el = document.getElementById(bid);
                        if (!el) return false;
                        try {
                            const r = el.getBoundingClientRect();
                            if (r && r.width > 1 && r.height > 1) return true;
                        } catch {}
                        try {
                            const b = typeof el.getBBox === 'function' ? el.getBBox() : null;
                            return !!(b && b.width > 0 && b.height > 0);
                        } catch {
                            return true;
                        }
                    },
                    { timeout: 7000, polling: 120 },
                    effectiveId
                );
            } catch (e2) {
                const diag = await page.evaluate((want) => {
                    const ids = [];
                    const nodes = document.querySelectorAll('svg.svgLayout g[id], .svgLayout g[id]');
                    for (let i = 0; i < Math.min(nodes.length, 14); i++) {
                        ids.push(nodes[i].getAttribute('id') || nodes[i].id || '');
                    }
                    return {
                        want,
                        sampleBlockIds: ids,
                        hasSvgLayout: !!document.querySelector('svg.svgLayout, .svgLayout')
                    };
                }, safeId).catch(() => null);
                logger.warn('categoryBlock:selectSvgBlockById_block_missing', { ...logBase, effectiveId, error: e2?.message || String(e2), diag });
                return false;
            }
        } else {
            const diag = await page.evaluate((want) => {
                const ids = [];
                const nodes = document.querySelectorAll('svg.svgLayout g[id], .svgLayout g[id]');
                for (let i = 0; i < Math.min(nodes.length, 14); i++) {
                    ids.push(nodes[i].getAttribute('id') || nodes[i].id || '');
                }
                return {
                    want,
                    sampleBlockIds: ids,
                    hasSvgLayout: !!document.querySelector('svg.svgLayout, .svgLayout')
                };
            }, safeId).catch(() => null);
            logger.warn('categoryBlock:selectSvgBlockById_block_missing', { ...logBase, diag });
            return false;
        }
    }

    if (effectiveId !== safeId) {
        logger.info('categoryBlock:selectSvgBlockById_id_resolved', { ...logBase, effectiveId });
    }

    try {
        await page.evaluate((bid) => {
            try { window.__passobotLastSvgBlockId = String(bid || ''); } catch {}
        }, effectiveId);
    } catch {}

    const clickPoint = await page.evaluate((targetId) => {
        const el = document.getElementById(targetId);
        if (!el) return { ok: false, id: targetId, reason: 'not_found' };
        const asEl = /** @type {Element} */ (el);
        try { asEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}

        let rect = null;
        try {
            if (typeof asEl.getBoundingClientRect === 'function') rect = asEl.getBoundingClientRect();
        } catch {}

        if (!rect || !rect.width || !rect.height) {
            try {
                const svgEl = /** @type {any} */ (asEl);
                if (typeof svgEl.getBBox === 'function') {
                    const b = svgEl.getBBox();
                    const ctm = svgEl.getScreenCTM && svgEl.getScreenCTM();
                    if (ctm) {
                        const x = (b.x + (b.width / 2)) * ctm.a + ctm.e;
                        const y = (b.y + (b.height / 2)) * ctm.d + ctm.f;
                        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBBox' };
                    }
                }
            } catch {}
        }

        if (!rect) return { ok: false, id: targetId, reason: 'no_rect', tag: asEl.tagName };
        const x = rect.left + (rect.width / 2);
        const y = rect.top + (rect.height / 2);
        const pe = (() => {
            try {
                const s = window.getComputedStyle(asEl);
                return s?.pointerEvents || null;
            } catch {
                return null;
            }
        })();
        const top = (() => {
            try {
                const t = document.elementFromPoint(x, y);
                if (!t) return null;
                return {
                    tag: t.tagName,
                    id: t.getAttribute('id') || t.id || null,
                    className: (t.getAttribute('class') || '').toString().slice(0, 120)
                };
            } catch {
                return null;
            }
        })();
        return { ok: true, id: targetId, tag: asEl.tagName, x, y, method: 'getBoundingClientRect', top, pe };
    }, effectiveId).catch(() => ({ ok: false, id: effectiveId, reason: 'eval_failed' }));

    if (!clickPoint || !clickPoint.ok || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) {
        logger.warn('categoryBlock:selectSvgBlockById_no_click_point', { ...logBase, effectiveId, reason: clickPoint?.reason || null, clickPoint });
        return false;
    }

    logger.info('categoryBlock:selectSvgBlockById_pointer', { ...logBase, effectiveId, method: clickPoint.method || null });

    // If the target block (or its subtree) is not hit-testable, force pointer-events back.
    try {
        if (String(clickPoint?.pe || '').toLowerCase() === 'none') {
            await page.evaluate((bid) => {
                try {
                    const el = document.getElementById(String(bid || ''));
                    const t = /** @type {any} */ (el);
                    if (t && t.style) {
                        try { t.style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                    }
                    try {
                        const p = el?.closest('g.block, .svgBlock, [class*="block" i]');
                        if (p && p.style) {
                            try { p.style.setProperty('pointer-events', 'auto', 'important'); } catch {}
                        }
                    } catch {}
                } catch {}
            }, effectiveId);
        }
    } catch {}

    // Some overlays (cookie consent etc.) can sit on top of the SVG and swallow clicks.
    // If elementFromPoint doesn't look like our target, try to disable obvious blockers once.
    try {
        const top = clickPoint?.top || null;
        const topTag = String(top?.tag || '').toUpperCase();
        const topClass = String(top?.className || '');
        const looksLikeBlocker = (
            topTag.startsWith('EFILLI') ||
            topClass.toLowerCase().includes('efilli') ||
            topClass.toLowerCase().includes('cookie') ||
            topClass.toLowerCase().includes('consent')
        );
        if (looksLikeBlocker) {
            await page.evaluate((x, y) => {
                try {
                    const t = document.elementFromPoint(x, y);
                    const disable = (el) => {
                        if (!el || !el.style) return;
                        try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                        try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                        try { el.style.setProperty('display', 'none', 'important'); } catch {}
                    };
                    disable(t);
                    try { disable(t?.closest('efilli-layout-dynamic, efilli-layout, efilli-consent, [class*="cookie" i], [class*="consent" i]')); } catch {}
                } catch {}
            }, clickPoint.x, clickPoint.y);
        }
    } catch {}

    try {
        // Move like a real user (hover tooltip already appears in some UIs)
        await page.mouse.move(clickPoint.x, clickPoint.y, { steps: 6 });
        await delay(35);
        // Some UIs require pointerover/move to arm the click handler
        try {
            await page.evaluate((x, y) => {
                const hit = document.elementFromPoint(x, y);
                const target = hit?.closest('g.block, .svgBlock') || hit;
                if (!target) return;
                const fire = (el, type) => {
                    try {
                        const base = {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX: x,
                            clientY: y,
                            button: 0,
                            buttons: 0
                        };
                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                        const ev = usePointer
                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                            : new MouseEvent(type, base);
                        el.dispatchEvent(ev);
                    } catch {}
                };
                fire(target, 'pointerover');
                fire(target, 'mouseover');
                fire(target, 'pointermove');
                fire(target, 'mousemove');
            }, clickPoint.x, clickPoint.y);
        } catch {}

        // Prefer down/up with realistic delays; some handlers ignore .click()
        await page.mouse.down();
        await delay(45);
        await page.mouse.up();
        await delay(25);
        await page.mouse.click(clickPoint.x, clickPoint.y, { delay: 35 });
    } catch {
        return false;
    }

    // Some SVG implementations listen to pointer events on the element rather than DOM click.
    // Dispatch a full pointer/mouse event sequence on the hit-tested element (or its closest block).
    try {
        await page.evaluate((x, y) => {
            const fire = (el, type, extra = {}) => {
                try {
                    const base = {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX: x,
                        clientY: y,
                        button: 0,
                        buttons: 1,
                        ...extra
                    };
                    const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                    const ev = usePointer
                        ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                        : new MouseEvent(type, base);
                    el.dispatchEvent(ev);
                } catch {}
            };
            try {
                const hit = document.elementFromPoint(x, y);
                const target = hit?.closest('g.block, .svgBlock') || hit;
                if (!target) return;
                // ensure hit-testable
                try { target.style?.setProperty('pointer-events', 'auto', 'important'); } catch {}
                fire(target, 'pointerdown');
                fire(target, 'mousedown');
                fire(target, 'pointerup');
                fire(target, 'mouseup');
                fire(target, 'click');
            } catch {}
        }, clickPoint.x, clickPoint.y);
    } catch {}

    // Koltukları burada beklemeyin: openSeatMapStrict koltuk node şartı yüzünden +20sn kaybediyordu.
    // Koltuk hazırlığı seat pick aşamasında yapılır.
    try {
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, { timeout: 4500, polling: 120 }, SEAT_NODE_SELECTOR);
    } catch {}
    logger.info('categoryBlock:selectSvgBlockById_done', { ...logBase, effectiveId });
    return true;
}

async function applyCategoryBlockSelection(page, selectionMode, catBlock, seatInfo) {
    // svgBlockId = SVG akışından (svg veya scan+svg) gelen blok id'si
    const svgBlockId =
        (catBlock && catBlock.svgBlockId ? String(catBlock.svgBlockId) : '') ||
        (seatInfo && seatInfo.svgBlockId ? String(seatInfo.svgBlockId) : '') ||
        '';
    if (svgBlockId) {
        return await selectSvgBlockById(page, svgBlockId, {
            categoryLabel: catBlock?.categoryText || null,
            categoryType: catBlock?.categoryText || null
        });
    }
    await setCatBlockOnB(page, catBlock);
    return true;
}

const runStore = (() => {
    const runs = new Map();
    const nowIso = () => {
        try { return new Date().toISOString(); } catch { return null; }
    };
    const safeRunId = (v) => {
        const s = String(v || '').trim();
        if (!s) return null;
        if (!/^[a-zA-Z0-9._:-]{6,120}$/.test(s)) return null;
        return s;
    };
    const get = (id) => runs.get(id) || null;
    const upsert = (id, patch) => {
        const rid = safeRunId(id);
        if (!rid) return null;
        const prev = runs.get(rid) || { runId: rid, createdAt: nowIso() };
        const next = { ...prev, ...patch, updatedAt: nowIso() };
        runs.set(rid, next);
        return next;
    };
    const remove = (id) => {
        const rid = safeRunId(id);
        if (!rid) return false;
        return runs.delete(rid);
    };
    const list = () => Array.from(runs.values());
    const listRunning = () => list().filter(r => r.status === 'running');
    const killAllRunning = () => {
        const running = listRunning();
        running.forEach(r => {
            upsert(r.runId, { status: 'killed', killedAt: nowIso() });
        });
        return running.map(r => r.runId);
    };
    return { get, upsert, remove, safeRunId, list, listRunning, killAllRunning };
})();

/** /kill-sessions sonrası runStore.status === 'killed' ise launch/login beklemelerini keser. */
function assertLaunchRunNotKilled(runId, label = '') {
    const rid = runStore.safeRunId(runId);
    if (!rid) return;
    try {
        const st = runStore.get(rid);
        if (st && st.status === 'killed') {
            const e = new Error(`RUN_KILLED${label ? `:${label}` : ''}`);
            e.code = 'RUN_KILLED';
            throw e;
        }
    } catch (e) {
        if (e && e.code === 'RUN_KILLED') throw e;
    }
}

const runLogBufferStore = (() => {
    const buffers = new Map();
    const MAX_LOGS = 2000;
    const get = (runId) => {
        const key = runStore.safeRunId(runId);
        if (!key) return [];
        return buffers.get(key) || [];
    };
    const append = (runId, entry) => {
        const key = runStore.safeRunId(runId);
        if (!key || !entry) return [];
        const list = buffers.get(key) || [];
        list.push(entry);
        while (list.length > MAX_LOGS) list.shift();
        buffers.set(key, list);
        return list.slice();
    };
    const remove = (runId) => {
        const key = runStore.safeRunId(runId);
        if (!key) return false;
        return buffers.delete(key);
    };
    return { get, append, remove };
})();

/** Panel "aktif oturumları kapat" — tüm Puppeteer oturumlarını buradan kapatır */
const passobotActiveBrowsers = new Set();

function registerPassobotBrowser(browser, runId) {
    if (!browser || typeof browser.close !== 'function') return;
    try {
        browser.__passobotRunId = String(runId || '');
    } catch {}
    passobotActiveBrowsers.add(browser);
}

function unregisterPassobotBrowser(browser) {
    if (!browser) return;
    passobotActiveBrowsers.delete(browser);
}

async function closeAllPassobotBrowsers() {
    const list = Array.from(passobotActiveBrowsers);
    passobotActiveBrowsers.clear();
    for (const br of list) {
        let pid = null;
        try {
            const proc = typeof br.process === 'function' ? br.process() : null;
            pid = proc && Number.isFinite(proc.pid) ? proc.pid : null;
        } catch {}
        try {
            const pages = await br.pages().catch(() => []);
            await Promise.all((pages || []).map((p) => p.close({ runBeforeUnload: false }).catch(() => {})));
        } catch {}
        try {
            await Promise.race([br.close().catch(() => {}), delay(12000)]);
        } catch {}
        if (pid != null) {
            try {
                await treeKillAsync(pid, 'SIGKILL');
            } catch {
                try {
                    if (process.platform === 'win32') {
                        const { execFile } = require('child_process');
                        const execFileAsync = util.promisify(execFile);
                        await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
                    } else {
                        try {
                            process.kill(-pid, 'SIGKILL');
                        } catch {
                            process.kill(pid, 'SIGKILL');
                        }
                    }
                } catch {}
            }
        }
    }
}

/** start-bot-async ön kontrolünde çekilen listeler; startBotAfterValidation aynı body referansıyla tekrar DB çağırmasın */
const accountListsWarmCache = new WeakMap();
const svgLegendEntriesCache = new WeakMap();

function normalizeCanPay(value, fallback = true) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes', 'evet'].includes(v)) return true;
        if (['0', 'false', 'off', 'no', 'hayir', 'hayır'].includes(v)) return false;
    }
    return !!fallback;
}

function normalizeTransferPurpose(value, fallback = false) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes', 'evet'].includes(v)) return true;
        if (['0', 'false', 'off', 'no', 'hayir', 'hayır'].includes(v)) return false;
    }
    return !!fallback;
}

function resolveAIntent(account) {
    const canPay = normalizeCanPay(account?.canPay, false);
    const transferPurpose = normalizeTransferPurpose(account?.transferPurpose, false);
    if (canPay) return 'payment';
    if (transferPurpose) return 'transfer';
    return 'self';
}

async function buildCredentialBackedAccountLists(validatedData) {
    const {
        teamId,
        aCredentialIds, bCredentialIds, payerACredentialIds, transferACredentialIds,
        aAccounts, bAccounts,
        email, password, email2, password2,
        identity, fanCardCode, sicilNo, priorityTicketCode,
    } = validatedData;

    const aCredentialIdsSafe = Array.isArray(aCredentialIds) ? aCredentialIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const bCredentialIdsSafe = Array.isArray(bCredentialIds) ? bCredentialIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const payerACredentialIdSet = new Set(
        Array.isArray(payerACredentialIds)
            ? payerACredentialIds.map((id) => String(id).trim()).filter(Boolean)
            : []
    );
    const transferACredentialIdSet = new Set(
        Array.isArray(transferACredentialIds)
            ? transferACredentialIds.map((id) => String(id).trim()).filter(Boolean)
            : []
    );

    let aAccountsFromTeam = [];
    if (teamId && aCredentialIdsSafe.length) {
        const docs = await credentialRepo.getCredentialsByIds(teamId, aCredentialIdsSafe);
        if (docs.length !== aCredentialIdsSafe.length) {
            return { ok: false, error: 'Seçilen A üyeliklerinden biri bulunamadı veya aktif değil' };
        }
        aAccountsFromTeam = docs.map((item) => ({
            email: String(item.email || ''),
            password: decryptSecret(item.encryptedPassword),
            identity: item.identity || null,
            phone: item.phone || null,
            fanCardCode: item.fanCardCode || null,
            sicilNo: item.sicilNo || null,
            priorityTicketCode: item.priorityTicketCode || null,
            categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds.map(String) : [],
            canPay: payerACredentialIdSet.has(String(item.id || '')),
            transferPurpose: transferACredentialIdSet.has(String(item.id || ''))
        }));
    }

    let bAccountsFromTeam = [];
    if (teamId && bCredentialIdsSafe.length) {
        const docs = await credentialRepo.getCredentialsByIds(teamId, bCredentialIdsSafe);
        if (docs.length !== bCredentialIdsSafe.length) {
            return { ok: false, error: 'Seçilen B üyeliklerinden biri bulunamadı veya aktif değil' };
        }
        bAccountsFromTeam = docs.map((item) => ({
            email: String(item.email || ''),
            password: decryptSecret(item.encryptedPassword),
            identity: item.identity || null,
            phone: item.phone || null,
            fanCardCode: item.fanCardCode || null,
            sicilNo: item.sicilNo || null,
            priorityTicketCode: item.priorityTicketCode || null,
            categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds.map(String) : []
        }));
    }

    const a0Raw = Array.isArray(aAccounts) && aAccounts.length ? aAccounts[0] : null;
    const b0Raw = Array.isArray(bAccounts) && bAccounts.length ? bAccounts[0] : null;

    const aList = (Array.isArray(aAccounts) && aAccounts.length)
        ? aAccounts.map(a => ({
            email: String(a.email || ''),
            password: String(a.password || ''),
            identity: (a && Object.prototype.hasOwnProperty.call(a, 'identity')) ? a.identity : null,
            phone: (a && Object.prototype.hasOwnProperty.call(a, 'phone')) ? a.phone : null,
            fanCardCode: (a && Object.prototype.hasOwnProperty.call(a, 'fanCardCode')) ? a.fanCardCode : null,
            sicilNo: (a && Object.prototype.hasOwnProperty.call(a, 'sicilNo')) ? a.sicilNo : null,
            priorityTicketCode: (a && Object.prototype.hasOwnProperty.call(a, 'priorityTicketCode')) ? a.priorityTicketCode : null,
            transferPurpose: normalizeTransferPurpose(a?.transferPurpose, false),
            canPay: normalizeTransferPurpose(a?.transferPurpose, false) ? false : normalizeCanPay(a?.canPay, false)
        }))
        : (aAccountsFromTeam.length
            ? aAccountsFromTeam
            : [{ email: (a0Raw?.email || email || '').toString(), password: (a0Raw?.password || password || '').toString(), identity: identity ?? null, phone: null, fanCardCode: fanCardCode ?? null, sicilNo: sicilNo ?? null, priorityTicketCode: priorityTicketCode ?? null, transferPurpose: normalizeTransferPurpose(a0Raw?.transferPurpose, false), canPay: normalizeTransferPurpose(a0Raw?.transferPurpose, false) ? false : normalizeCanPay(a0Raw?.canPay, false) }]);
    const bList = (Array.isArray(bAccounts) && bAccounts.length)
        ? bAccounts.map(b => ({
            email: String(b.email || ''),
            password: String(b.password || ''),
            identity: (b && Object.prototype.hasOwnProperty.call(b, 'identity')) ? b.identity : null,
            phone: (b && Object.prototype.hasOwnProperty.call(b, 'phone')) ? b.phone : null,
            fanCardCode: (b && Object.prototype.hasOwnProperty.call(b, 'fanCardCode')) ? b.fanCardCode : null,
            sicilNo: (b && Object.prototype.hasOwnProperty.call(b, 'sicilNo')) ? b.sicilNo : null,
            priorityTicketCode: (b && Object.prototype.hasOwnProperty.call(b, 'priorityTicketCode')) ? b.priorityTicketCode : null
        }))
        : (bAccountsFromTeam.length
            ? bAccountsFromTeam
            : [{ email: (b0Raw?.email || email2 || '').toString(), password: (b0Raw?.password || password2 || '').toString(), identity: identity ?? null, phone: null, fanCardCode: fanCardCode ?? null, sicilNo: sicilNo ?? null, priorityTicketCode: priorityTicketCode ?? null }]);

    const hasRealB = bList.some(b => (b.email || '').trim() && (b.password || '').trim());
    return { ok: true, aList, bList, hasRealB };
}

function validateDivanPriorityAccounts(aList, bList, hasRealB, prioritySale, sicilNo, priorityTicketCode) {
    if (typeof prioritySale !== 'string' || !isDivanPrioritySaleCategory(prioritySale)) return null;
    const reqS = String(sicilNo || '').trim();
    const reqP = String(priorityTicketCode || '').trim();
    for (const acc of aList) {
        const s = String(acc.sicilNo || '').trim() || reqS;
        const p = String(acc.priorityTicketCode || '').trim() || reqP;
        if (!s || !p) {
            return 'Divan önceliği: her A hesabı için üyelikte veya başlatma formunda Sicil No ve Öncelikli Bilet Kodu gerekir.';
        }
    }
    if (hasRealB) {
        for (const acc of bList) {
            if (!(String(acc.email || '').trim() && String(acc.password || '').trim())) continue;
            const s = String(acc.sicilNo || '').trim() || reqS;
            const p = String(acc.priorityTicketCode || '').trim() || reqP;
            if (!s || !p) {
                return 'Divan önceliği: her B hesabı için üyelikte veya başlatma formunda Sicil No ve Öncelikli Bilet Kodu gerekir.';
            }
        }
    }
    return null;
}

function normalizePriorityFormDigits(s) {
    return String(s || '').replace(/\D/g, '');
}

function validateGsPlusPremiumAccounts(aList, bList, hasRealB, prioritySale, priorityPhone) {
    if (typeof prioritySale !== 'string' || !isGsPlusPremiumPriorityCategory(prioritySale)) return null;
    const globalPhone = normalizePriorityFormDigits(priorityPhone);
    // Her A hesabı için: önce hesapta kayıtlı phone, yoksa form değeri
    for (const acc of aList) {
        const accPhone = normalizePriorityFormDigits(acc.phone);
        const effective = accPhone.length >= 10 ? accPhone : globalPhone;
        if (effective.length < 10) {
            return `GS PLUS Premium önceliği: "${acc.email || 'A hesabı'}" için üyelikte cep telefonu kayıtlı değil ve başlatma formunda ortak telefon girilmemiş.`;
        }
    }
    if (hasRealB) {
        for (const acc of bList) {
            if (!(String(acc.email || '').trim() && String(acc.password || '').trim())) continue;
            const accPhone = normalizePriorityFormDigits(acc.phone);
            const effective = accPhone.length >= 10 ? accPhone : globalPhone;
            if (effective.length < 10) {
                return `GS PLUS Premium önceliği: "${acc.email || 'B hesabı'}" için üyelikte cep telefonu kayıtlı değil ve başlatma formunda ortak telefon girilmemiş.`;
            }
        }
    }
    return null;
}

function validateGsParaPriorityAccounts(aList, bList, hasRealB, prioritySale, identity, priorityTckn) {
    if (typeof prioritySale !== 'string' || !isGsParaPriorityCategory(prioritySale)) return null;
    const reqId = normalizePriorityFormDigits(priorityTckn) || normalizePriorityFormDigits(identity);
    for (const acc of aList) {
        const id = normalizePriorityFormDigits(acc.identity) || reqId;
        if (!/^\d{11}$/.test(id)) {
            return 'GSPara Öncelik: her A hesabı için üyelikte TCKN veya formdaki GSPara / ortak TCKN alanı (11 hane) gerekir.';
        }
    }
    if (hasRealB) {
        for (const acc of bList) {
            if (!(String(acc.email || '').trim() && String(acc.password || '').trim())) continue;
            const id = normalizePriorityFormDigits(acc.identity) || reqId;
            if (!/^\d{11}$/.test(id)) {
                return 'GSPara Öncelik: her B hesabı için üyelikte TCKN veya formdaki GSPara / ortak TCKN alanı (11 hane) gerekir.';
            }
        }
    }
    return null;
}

async function startBotAsync(req, res) {
    let validatedData;
    try {
        validatedData = botRequestSchema.parse(req.body);
    } catch (error) {
        if (error.issues && Array.isArray(error.issues)) {
            logger.warnSafe('Validation hatası', { errors: error.issues, body: req.body });
            return res.status(400).json({
                error: formatError('VALIDATION_ERROR'),
                details: error.issues.map(e => ({ path: e.path.join('.'), message: e.message, code: e.code }))
            });
        }
        logger.errorSafe('Validation hatası (beklenmeyen format)', error, { body: req.body });
        return res.status(400).json({ error: formatError('INVALID_REQUEST_DATA') });
    }

    const builtLists = await buildCredentialBackedAccountLists(validatedData);
    if (!builtLists.ok) {
        return res.status(400).json({ error: builtLists.error });
    }
    const divanPreflightErr = validateDivanPriorityAccounts(
        builtLists.aList,
        builtLists.bList,
        builtLists.hasRealB,
        validatedData.prioritySale,
        validatedData.sicilNo,
        validatedData.priorityTicketCode
    );
    if (divanPreflightErr) {
        return res.status(400).json({ error: divanPreflightErr });
    }
    const gsPlusPreflightErr = validateGsPlusPremiumAccounts(
        builtLists.aList,
        builtLists.bList,
        builtLists.hasRealB,
        validatedData.prioritySale,
        validatedData.priorityPhone
    );
    if (gsPlusPreflightErr) {
        return res.status(400).json({ error: gsPlusPreflightErr });
    }
    const gsParaPreflightErr = validateGsParaPriorityAccounts(
        builtLists.aList,
        builtLists.bList,
        builtLists.hasRealB,
        validatedData.prioritySale,
        validatedData.identity,
        validatedData.priorityTckn
    );
    if (gsParaPreflightErr) {
        return res.status(400).json({ error: gsParaPreflightErr });
    }

    // Proxy havuzu ön kontrolü: manuel proxy girilmemişse havuz boşsa 400 dön (step 2'ye geçmeden önce)
    const _preManualProxy = !!(String(validatedData.proxyHost || '').trim() && String(validatedData.proxyPort || '').trim());
    const _preUsePool = validatedData.useProxyPool !== false;
    if (_preUsePool && !_preManualProxy) {
        try {
            const _proxyCount = await proxyRepo.countAssignableProxies();
            if (_proxyCount === 0) {
                return res.status(400).json({ error: 'Proxy havuzu boş. Lütfen Proxy Yönetimi\'nden en az bir aktif proxy ekleyin.' });
            }
        } catch (_proxyCheckErr) {
            logger.warnSafe('proxy_preflight_count_failed', { error: _proxyCheckErr?.message || String(_proxyCheckErr) });
        }
    }

    accountListsWarmCache.set(validatedData, {
        aList: builtLists.aList,
        bList: builtLists.bList,
        hasRealB: builtLists.hasRealB,
    });

    const runId = (() => {
        try { return randomUUID(); } catch { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
    })();

    runStore.upsert(runId, {
        status: 'running',
        finalizeRequested: false,
        finalizeRequestedAt: null,
        cAccount: null,
        cTransferPairIndex: validatedData.cTransferPairIndex ?? 1,
        paymentQueue: { activePairIndex: null, queue: [], updatedAt: new Date().toISOString() },
        result: null,
        error: null
    });

    res.json({ success: true, runId, status: 'running' });

    const pushCapturedRunLog = (entry) => {
        try {
            const entryRunId = String(entry?.runId || entry?.meta?.runId || '').trim();
            if (!entryRunId || entryRunId !== runId) return;
            const capturedRunLogs = runLogBufferStore.append(runId, entry);
            runStore.upsert(runId, {
                logCount: capturedRunLogs.length,
                logTail: capturedRunLogs.slice(-120)
            });
        } catch {}
    };
    const detachRunLogCapture = logger.subscribeLogs(pushCapturedRunLog);
    let failureLogsPersisted = false;
    const persistRunFailureLogs = async (errorText) => {
        try {
            if (failureLogsPersisted) return;
            const capturedRunLogs = runLogBufferStore.get(runId);
            if (!capturedRunLogs.length) return;
            const attached = await orderRecordRepo.attachSessionLogsToRun(runId, {
                failureReason: errorText,
                sessionLogs: capturedRunLogs
            });
            if (!Array.isArray(attached) || !attached.length) {
                await orderRecordRepo.markFailed(`${runId}:run_failure`, {
                    recordKey: `${runId}:run_failure`,
                    runId,
                    teamId: validatedData?.teamId || '',
                    teamName: validatedData?.team || '',
                    eventUrl: validatedData?.eventAddress || '',
                    ticketType: validatedData?.ticketType || '',
                    pairIndex: 0,
                    sourceRole: 'RUN',
                    holderRole: '',
                    paymentOwnerRole: '',
                    paymentState: 'failed',
                    finalizeState: 'failed',
                    recordStatus: 'failed',
                    aAccountEmail: builtLists?.aList?.[0]?.email || '',
                    bAccountEmail: builtLists?.bList?.[0]?.email || '',
                    failureReason: errorText,
                    auditMeta: {
                        phase: 'run_failure',
                        error: errorText
                    },
                    sessionLogs: capturedRunLogs,
                    basketStatus: 'failed'
                });
            }
            failureLogsPersisted = true;
        } catch (error) {
            logger.warnSafe('order_record_attach_run_logs_failed', { runId, error: error?.message || String(error) });
        }
    };

    const reqLike = {
        body: validatedData,
        get: (h) => {
            try {
                if (String(h || '').toLowerCase() === 'x-run-id') return runId;
            } catch {}
            return null;
        }
    };
    let resLikeStatusCode = 200;
    const resLike = {
        status: (code) => {
            const n = Number(code);
            if (Number.isFinite(n) && n >= 100) resLikeStatusCode = n;
            return resLike;
        },
        json: (payload) => {
            if (resLikeStatusCode >= 400) {
                runStore.upsert(runId, {
                    status: 'error',
                    result: payload || null,
                    error: payload?.error || null
                });
            } else {
                runStore.upsert(runId, { status: 'completed', result: payload || null, error: null });
            }
            return payload;
        }
    };

    Promise.resolve()
        .then(() => logger.runWithContext({ runId }, () => startBot(reqLike, resLike)))
        .catch(async (e) => {
            if (e && e.code === 'RUN_KILLED') {
                try {
                    runStore.upsert(runId, { status: 'killed', error: e?.message || 'Oturum panelden sonlandırıldı', result: null });
                } catch {}
                try { await persistRunFailureLogs(e?.message || 'Oturum panelden sonlandırıldı'); } catch {}
                try { detachRunLogCapture && detachRunLogCapture(); } catch {}
                return;
            }
            runStore.upsert(runId, { status: 'error', error: e?.message || String(e) });
            try { await persistRunFailureLogs(e?.message || String(e)); } catch {}
        })
        .finally(async () => {
            try {
                const current = runStore.get(runId);
                if (current?.status === 'error') {
                    await persistRunFailureLogs(current?.error || 'Oturum hata ile sonlandı');
                }
            } catch {}
            try { detachRunLogCapture && detachRunLogCapture(); } catch {}
            try { runLogBufferStore.remove(runId); } catch {}
        });
}

async function registerCAccount(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const email = String(req?.body?.email || '').trim();
    const password = String(req?.body?.password || '').trim();
    if (!email || !password) return res.status(400).json({ error: 'email/password required' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    const transferEligiblePairIndices = Array.isArray(cur?.pairDashboard?.pairs)
        ? cur.pairDashboard.pairs
            .filter((pair) => String(pair?.aIntent || '').trim().toLowerCase() === 'transfer')
            .map((pair) => Math.max(1, Math.floor(Number(pair?.pairIndex) || 1)))
        : [];
    const rawPair = req?.body?.cTransferPairIndex ?? req?.body?.pairIndex;
    const patch = { cAccount: { email, password } };
    if (rawPair !== undefined && rawPair !== null && String(rawPair).trim() !== '') {
        const n = parseInt(String(rawPair).trim(), 10);
        if (Number.isFinite(n) && n >= 1) patch.cTransferPairIndex = n;
    }
    if (transferEligiblePairIndices.length && !transferEligiblePairIndices.includes(Number(patch.cTransferPairIndex || 1))) {
        return res.status(400).json({
            error: 'C hesabi sadece transfer amaçlı çiftlerden seçilebilir',
            allowedPairIndices: transferEligiblePairIndices
        });
    }
    runStore.upsert(runId, patch);
    return res.json({ success: true, runId });
}

/**
 * Çoklu koşu çalışırken ek A hesapları (credential id) kuyruğa alınır; bot aynı multi akışta işler.
 * Body: { teamId, aCredentialIds: string[], payerACredentialIds?: string[], transferACredentialIds?: string[] }
 */
async function enqueueHotAccountsForRun(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    if (cur.status !== 'running') {
        return res.status(409).json({ error: 'Run is not active', status: cur.status });
    }
    if (cur.runMode !== 'multi' && cur.pairDashboard?.mode !== 'multi') {
        return res.status(400).json({ error: 'Hot account enqueue is only supported for multi runs' });
    }
    const teamIdBody = String(req?.body?.teamId || '').trim();
    if (!teamIdBody || teamIdBody !== String(cur.teamId || '').trim()) {
        return res.status(403).json({ error: 'teamId mismatch' });
    }
    const rawIds = req?.body?.aCredentialIds ?? req?.body?.credentialIds;
    const ids = Array.isArray(rawIds) ? rawIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'aCredentialIds required' });
    const prev = cur.pendingHotAccounts || {};
    const existingA = Array.isArray(prev.aCredentialIds) ? prev.aCredentialIds.slice() : [];
    const newPayer = Array.isArray(req?.body?.payerACredentialIds)
        ? req.body.payerACredentialIds.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    const newTransfer = Array.isArray(req?.body?.transferACredentialIds)
        ? req.body.transferACredentialIds.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
    const payerACredentialIds = [
        ...(Array.isArray(prev.payerACredentialIds) ? prev.payerACredentialIds.map((x) => String(x || '').trim()).filter(Boolean) : []),
        ...newPayer
    ];
    const transferACredentialIds = [
        ...(Array.isArray(prev.transferACredentialIds) ? prev.transferACredentialIds.map((x) => String(x || '').trim()).filter(Boolean) : []),
        ...newTransfer
    ];
    const nextA = existingA.concat(ids);
    runStore.upsert(runId, {
        pendingHotAccounts: {
            ...prev,
            aCredentialIds: nextA,
            payerACredentialIds,
            transferACredentialIds
        }
    });
    return res.json({
        success: true,
        runId,
        queued: ids.length,
        pendingCount: nextA.length
    });
}

async function requestFinalize(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    const transferEligiblePairIndices = Array.isArray(cur?.pairDashboard?.pairs)
        ? cur.pairDashboard.pairs
            .filter((pair) => String(pair?.aIntent || '').trim().toLowerCase() === 'transfer')
            .map((pair) => Math.max(1, Math.floor(Number(pair?.pairIndex) || 1)))
        : [];
    const email = req?.body?.email != null ? String(req.body.email).trim() : '';
    const password = req?.body?.password != null ? String(req.body.password).trim() : '';
    const identity = req?.body?.identity != null ? String(req.body.identity).trim() : null;
    const cardHolder = req?.body?.cardHolder != null ? String(req.body.cardHolder).trim() : null;
    const cardNumber = req?.body?.cardNumber != null ? String(req.body.cardNumber).trim() : null;
    const expiryMonth = req?.body?.expiryMonth != null ? String(req.body.expiryMonth).trim() : null;
    const expiryYear = req?.body?.expiryYear != null ? String(req.body.expiryYear).trim() : null;
    const cvv = req?.body?.cvv != null ? String(req.body.cvv).trim() : null;
    const paymentRequired = (() => {
        const v = req?.body?.paymentRequired;
        if (v === true || v === 'true' || v === 1 || v === '1' || v === 'on') return true;
        return false;
    })();
    const autoPay = (() => {
        const v = req?.body?.autoPay;
        if (v === true || v === 'true' || v === 1 || v === '1' || v === 'on') return true;
        return false;
    })();
    const patch = {
        finalizeRequested: true,
        finalizeRequestedAt: new Date().toISOString(),
        finalizeMeta: {
            identity: identity || null,
            cardHolder: cardHolder || null,
            cardNumber: cardNumber || null,
            expiryMonth: expiryMonth || null,
            expiryYear: expiryYear || null,
            cvv: cvv || null,
            paymentRequired,
            autoPay
        }
    };
    if (email && password) {
        patch.cAccount = { email, password };
    }
    const rawPair = req?.body?.cTransferPairIndex ?? req?.body?.pairIndex;
    if (rawPair !== undefined && rawPair !== null && String(rawPair).trim() !== '') {
        const n = parseInt(String(rawPair).trim(), 10);
        if (Number.isFinite(n) && n >= 1) patch.cTransferPairIndex = n;
    }
    if (!transferEligiblePairIndices.length) {
        return res.status(400).json({ error: 'C hesabi sadece transfer amaçlı çiftlerde çalışır; uygun çift yok' });
    }
    if (!transferEligiblePairIndices.includes(Number(patch.cTransferPairIndex || 1))) {
        return res.status(400).json({
            error: 'C hesabi sadece transfer amaçlı çiftlerden seçilebilir',
            allowedPairIndices: transferEligiblePairIndices
        });
    }
    runStore.upsert(runId, patch);
    return res.json({ success: true, runId });
}

async function getRunStatus(req, res) {
    const runId = runStore.safeRunId(req?.params?.runId);
    if (!runId) return res.status(400).json({ error: 'Invalid runId' });
    const cur = runStore.get(runId);
    if (!cur) return res.status(404).json({ error: 'runId not found' });
    const safe = { ...cur };
    try {
        if (safe?.cAccount?.password) safe.cAccount = { ...safe.cAccount, password: '***' };
    } catch {}
    try {
        if (safe?.finalizeMeta) {
            const fm = { ...(safe.finalizeMeta || {}) };
            if (fm.cardNumber) fm.cardNumber = '***';
            if (fm.cvv) fm.cvv = '***';
            safe.finalizeMeta = fm;
        }
    } catch {}
    return res.json({ success: true, run: safe });
}

async function killSessions(req, res) {
    const running = runStore.listRunning();
    const killedRunIds = runStore.killAllRunning();
    const browserCloseCount = passobotActiveBrowsers.size;

    try {
        await closeAllPassobotBrowsers();
    } catch (e) {
        try { logger.warnSafe('KILL_SESSIONS: tarayıcı kapatma hatası', e); } catch {}
    }

    // Log separator for visual distinction in logs
    logger.info('==================================================');
    logger.info('KILL_SESSIONS: Aktif oturumlar kapatılıyor', {
        runningCount: running.length,
        killedRunIds,
        browsersQueued: browserCloseCount,
        timestamp: new Date().toISOString()
    });
    logger.info('==================================================');

    // Also emit a special log entry that UI can detect
    logger.info('[SEPARATOR] ------------------- OTURUMLAR KAPATILDI -------------------');

    return res.json({
        success: true,
        killedCount: killedRunIds.length,
        killedRunIds,
        runningCount: running.length,
        browsersClosed: browserCloseCount
    });
}

module.exports = {
    startBot,
    startBotAsync,
    startSnipe,
    registerCAccount,
    enqueueHotAccountsForRun,
    requestFinalize,
    getRunStatus,
    killSessions,
    launchAndLogin,
    registerPassobotBrowser,
    unregisterPassobotBrowser,
};

// Global semaphore to avoid hammering captcha provider with too many parallel solves.
// This helps reduce queueing and long tail solve times in multi-account runs.
const createSemaphore = (max) => {
    const limit = Math.max(1, Number(max) || 1);
    let active = 0;
    const q = [];
    const acquire = async () => {
        if (active < limit) {
            active += 1;
            return;
        }
        await new Promise((resolve) => q.push(resolve));
        active += 1;
    };
    const release = () => {
        active = Math.max(0, active - 1);
        const next = q.shift();
        if (next) next();
    };
    const stats = () => ({ limit, active, queued: q.length });
    return { acquire, release, stats };
};

const turnstileSemCache = new Map();
function getTurnstileSolveSem() {
    const lim = Math.max(1, Number(getCfg()?.TIMEOUTS?.TURNSTILE_SOLVE_CONCURRENCY) || 2);
    if (!turnstileSemCache.has(lim)) turnstileSemCache.set(lim, createSemaphore(lim));
    return turnstileSemCache.get(lim);
}

async function evalOnPage(page, scriptBody, args) {
    const payload = JSON.stringify(Array.isArray(args) ? args : []).replace(/</g, '\\u003c');
    const script = `(function(){var __args=${payload};${scriptBody}})()`;
    return evaluateSafe(page, script);
}

async function evalOnTarget(target, scriptBody, args) {
    const payload = JSON.stringify(Array.isArray(args) ? args : []).replace(/</g, '\\u003c');
    const script = `(function(){var __args=${payload};${scriptBody}})()`;
    return evaluateSafe(target, script);
}

function turnstileExtractKeyFromUrlString(u) {
    try {
        const s = String(u || '');
        if (s.indexOf('challenges.cloudflare.com') < 0) return null;
        const mPath = s.match(/turnstile\/[^\s"'<>]*?\/(0x[0-9A-Za-z]+)(?:\/|\b)/i);
        if (mPath && mPath[1]) return mPath[1];
        const mAny = s.match(/\b(0x[0-9A-Za-z]{10,})\b/);
        if (mAny && mAny[1] && s.indexOf('/turnstile/') >= 0) return mAny[1];
        const mQuery = s.match(/[?&](?:k|sitekey|render)=((?:0x)?[0-9A-Za-z_-]+)/i);
        if (mQuery && mQuery[1]) {
            const v = String(mQuery[1]);
            return v.startsWith('0x') ? v : ('0x' + v);
        }
        return null;
    } catch {
        return null;
    }
}

async function getBrowserFromPage(page) {
    try {
        if (page && typeof page.browser === 'function') return await page.browser();
    } catch {}
    return null;
}

function readBrowserStoredTurnstileKey(browser) {
    try {
        const k = browser && browser.__passoTurnstileSiteKey;
        if (k && /^0x[0-9A-Za-z]{10,}$/i.test(String(k))) return String(k);
    } catch {}
    return null;
}

function storeBrowserTurnstileKey(browser, key) {
    try {
        if (browser && key && /^0x[0-9A-Za-z]{10,}$/i.test(String(key))) browser.__passoTurnstileSiteKey = String(key);
    } catch {}
}

/** İlk navigasyondan önce kurulmalı; koltuk sayfasındaki Turnstile istekleri kaçmasın. */
async function installTurnstileSiteKeyNetworkWatcher(page) {
    if (!page || page.__turnstileSiteKeyWatcherInstalled) return;
    page.__turnstileSiteKeyWatcherInstalled = true;
    const extractKey = turnstileExtractKeyFromUrlString;
    const onReq = (req) => {
        try {
            const key = extractKey(req?.url?.());
            if (key) page.__turnstileLastSiteKey = key;
        } catch {}
    };
    const onResp = (resp) => {
        try {
            const key = extractKey(resp?.url?.());
            if (key) page.__turnstileLastSiteKey = key;
        } catch {}
    };
    try {
        page.on('request', onReq);
    } catch {}
    try {
        page.on('response', onResp);
    } catch {}

    try {
        const t = page.target?.();
        const create = t && typeof t.createCDPSession === 'function' ? t.createCDPSession.bind(t) : null;
        if (create) {
            const client = await create();
            page.__turnstileCdpClient = client;
            try {
                await client.send('Network.enable');
            } catch {}
            try {
                client.on('Network.requestWillBeSent', (ev) => {
                    try {
                        const key = extractKey(ev?.request?.url);
                        if (key) page.__turnstileLastSiteKey = key;
                    } catch {}
                });
            } catch {}
            try {
                client.on('Network.responseReceived', (ev) => {
                    try {
                        const key = extractKey(ev?.response?.url);
                        if (key) page.__turnstileLastSiteKey = key;
                    } catch {}
                });
            } catch {}
        }
    } catch {}
    logger.debug('turnstile:sitekey_watcher_installed');
}

async function ensureTurnstileTokenOnPage(page, email, label, options) {
    if (!page) return { attempted: false };

    const opts = options && typeof options === 'object' ? options : {};
    const background = !!opts.background;
    const targetFrame = opts.targetFrame || null;

    const evalTarget = targetFrame || page;

    await installTurnstileSiteKeyNetworkWatcher(page);

    // Cache in-flight solves per Page to avoid starting multiple expensive captcha requests.
    const getCache = () => {
        try {
            if (!page.__turnstileCache) page.__turnstileCache = { inFlight: null, startedAt: 0 };
            return page.__turnstileCache;
        } catch {
            return { inFlight: null, startedAt: 0 };
        }
    };
    const cache = getCache();

    const maxAttempts = Math.max(1, Number(getCfg()?.TIMEOUTS?.TURNSTILE_MAX_ATTEMPTS) || 2);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const state = await evaluateSafe(evalTarget, () => {
                const body = document.body;
                const bodyText = body && body.innerText ? String(body.innerText).toLowerCase() : '';
                const hasVerifyHuman = bodyText.indexOf('verify you are human') >= 0;
                const hasWidget = !!document.querySelector('.cf-turnstile');
                const widget = document.querySelector('.cf-turnstile');
                const siteKeyFromWidget = widget ? (widget.getAttribute('data-sitekey') || null) : null;
                const allKeyNodes = Array.from(document.querySelectorAll('[data-sitekey]'));
                const allSiteKeys = allKeyNodes
                    .map(n => (n.getAttribute('data-sitekey') || '').trim())
                    .filter(Boolean)
                    .slice(0, 6);
                let siteKeyFromIframe = null;
                try {
                    const ifr = document.querySelector('#turnstile-container iframe, .cf-turnstile iframe');
                    const src = ifr ? (ifr.getAttribute('src') || '') : '';
                    const m = src.match(/\/(0x[0-9A-Za-z]+)\//);
                    if (m && m[1]) siteKeyFromIframe = m[1];
                } catch {}

                function keyFromChallengeUrl(name) {
                    if (!name || name.indexOf('challenges.cloudflare.com') < 0) return null;
                    const m2 = name.match(/turnstile\/[^\s"'<>]*?\/(0x[0-9A-Za-z]+)(?:\/|\b)/i);
                    if (m2 && m2[1]) return m2[1];
                    const mq = name.match(/[?&](?:k|sitekey|render)=((?:0x)?[0-9A-Za-z_-]+)/i);
                    if (mq && mq[1]) return String(mq[1]).startsWith('0x') ? mq[1] : ('0x' + mq[1]);
                    const m0 = name.match(/\b(0x[0-9A-Za-z]{10,})\b/);
                    if (m0 && m0[1] && name.indexOf('/turnstile/') >= 0) return m0[1];
                    return null;
                }
                function walkShadowIframes(root, depth) {
                    if (!root || depth > 12) return null;
                    try {
                        const iframes = root.querySelectorAll ? root.querySelectorAll('iframe') : [];
                        for (let i = 0; i < iframes.length; i++) {
                            const src = iframes[i].getAttribute('src') || '';
                            const k = keyFromChallengeUrl(src);
                            if (k) return k;
                        }
                        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
                        for (let j = 0; j < nodes.length; j++) {
                            const el = nodes[j];
                            if (el && el.shadowRoot) {
                                const k2 = walkShadowIframes(el.shadowRoot, depth + 1);
                                if (k2) return k2;
                            }
                        }
                    } catch (e) {}
                    return null;
                }
                const siteKeyFromShadow = walkShadowIframes(document, 0);
                let siteKeyFromScriptSrc = null;
                try {
                    const sc = document.querySelectorAll('script[src*="cloudflare"], script[src*="turnstile"], script[src*="challenges"]');
                    for (let s = 0; s < sc.length; s++) {
                        const href = sc[s].getAttribute('src') || '';
                        const ks = keyFromChallengeUrl(href);
                        if (ks) {
                            siteKeyFromScriptSrc = ks;
                            break;
                        }
                    }
                } catch (e) {}
                let siteKeyFromInline = null;
                try {
                    const sx = document.querySelectorAll('script:not([src])');
                    for (let z = 0; z < sx.length; z++) {
                        const tx = sx[z].textContent || '';
                        if (tx.indexOf('turnstile') < 0 && tx.indexOf('challenges') < 0 && tx.indexOf('0x') < 0) continue;
                        const mi = tx.match(/\b(0x[0-9A-Za-z]{10,})\b/);
                        if (mi && mi[1]) {
                            siteKeyFromInline = mi[1];
                            break;
                        }
                    }
                } catch (e2) {}

                let siteKeyFromPerf = null;
                try {
                    const ents = (performance && typeof performance.getEntriesByType === 'function')
                        ? performance.getEntriesByType('resource')
                        : [];
                    for (let i = Math.max(0, ents.length - 120); i < ents.length; i++) {
                        const name = ents[i] && ents[i].name ? String(ents[i].name) : '';
                        if (!name) continue;
                        if (name.indexOf('challenges.cloudflare.com') < 0) continue;
                        if (name.indexOf('/turnstile/') < 0) continue;
                        const m2 = name.match(/turnstile\/[^\s"'<>]*?\/(0x[0-9A-Za-z]+)(?:\/|\b)/i);
                        if (m2 && m2[1]) { siteKeyFromPerf = m2[1]; break; }
                        const mq = name.match(/[?&](?:k|sitekey|render)=((?:0x)?[0-9A-Za-z_-]+)/i);
                        if (mq && mq[1]) { siteKeyFromPerf = String(mq[1]).startsWith('0x') ? mq[1] : ('0x' + mq[1]); break; }
                    }
                } catch {}

                let siteKeyFromHtml = null;
                try {
                    const html = document.documentElement && document.documentElement.outerHTML
                        ? String(document.documentElement.outerHTML)
                        : '';
                    if (html && html.indexOf('challenges.cloudflare.com') >= 0 && html.indexOf('/turnstile/') >= 0) {
                        const re1 = /challenges\.cloudflare\.com[^"'<>]*\/turnstile\/[^"'<>]*\/(0x[0-9A-Za-z]+)(?:\/|\b)/i;
                        const m3 = html.match(re1);
                        if (m3 && m3[1]) siteKeyFromHtml = m3[1];
                        if (!siteKeyFromHtml) {
                            const re2 = /challenges\.cloudflare\.com[^"'<>]*\/turnstile\/[^"'<>]*[?&](?:k|sitekey|render)=((?:0x)?[0-9A-Za-z_-]+)/i;
                            const m4 = html.match(re2);
                            if (m4 && m4[1]) siteKeyFromHtml = String(m4[1]).startsWith('0x') ? m4[1] : ('0x' + m4[1]);
                        }
                    }
                } catch {}

                const siteKey =
                    siteKeyFromWidget ||
                    siteKeyFromIframe ||
                    siteKeyFromShadow ||
                    siteKeyFromScriptSrc ||
                    siteKeyFromInline ||
                    siteKeyFromPerf ||
                    siteKeyFromHtml ||
                    (allSiteKeys.length ? allSiteKeys[0] : null);
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                const hasTokenField = !!input;
                const tokenLen = (input && input.value) ? String(input.value).length : 0;
                let href = null;
                try { href = location && location.href ? String(location.href) : null; } catch {}
                return {
                    hasVerifyHuman,
                    hasWidget,
                    hasTokenField,
                    tokenLen,
                    siteKey,
                    href,
                    allSiteKeys,
                    siteKeyFromIframe,
                    siteKeyFromShadow,
                    siteKeyFromScriptSrc,
                    siteKeyFromPerf,
                    siteKeyFromHtml
                };
            }).catch(() => ({ hasVerifyHuman: false, hasWidget: false, hasTokenField: false, tokenLen: 0 }));

            const shouldSolve = (state.hasVerifyHuman || state.hasWidget || state.hasTokenField) && state.tokenLen <= 0;
            if (shouldSolve) {
                logger.info('turnstile:state', { email, label, attempt, state, background });
            } else {
                logger.debug('turnstile:state', { email, label, attempt, state, background });
            }
            if (!shouldSolve) return { attempted: false, state };

            let cachedKey = (() => { try { return page.__turnstileLastSiteKey || null; } catch { return null; } })();
            // Seat selection pages often keep the Turnstile iframe in a closed shadow root; the key may
            // not be available immediately. Poll briefly to capture it from network watchers/perf/frames.
            if (!cachedKey && !state?.siteKey) {
                const effectiveUrl0 = state?.href || (() => { try { return page.url(); } catch { return null; } })() || '';
                const isSeatSel = /\/koltuk-secim(\b|\/|\?|#)/i.test(String(effectiveUrl0 || ''));
                if (isSeatSel) {
                    const seatPollRaw = Number(getCfg()?.TIMEOUTS?.TURNSTILE_SEAT_SITEKEY_POLL_MS);
                    const seatPollMs = Math.min(
                        25000,
                        Math.max(3500, Number.isFinite(seatPollRaw) && seatPollRaw > 0 ? seatPollRaw : 12000)
                    );
                    const until = Date.now() + seatPollMs;
                    while (Date.now() < until) {
                        try { cachedKey = page.__turnstileLastSiteKey || null; } catch {}
                        if (cachedKey) break;
                        try {
                            const k2 = await evaluateSafe(evalTarget, () => {
                                try {
                                    const ents = (performance && typeof performance.getEntriesByType === 'function')
                                        ? performance.getEntriesByType('resource')
                                        : [];
                                    for (let i = Math.max(0, ents.length - 160); i < ents.length; i++) {
                                        const name = ents[i] && ents[i].name ? String(ents[i].name) : '';
                                        if (!name) continue;
                                        if (name.indexOf('challenges.cloudflare.com') < 0) continue;
                                        if (name.indexOf('/turnstile/') < 0) continue;
                                        const m = name.match(/\/(0x[0-9A-Za-z]+)\//);
                                        if (m && m[1]) return m[1];
                                    }
                                } catch {}
                                return null;
                            }).catch(() => null);
                            if (k2) { cachedKey = k2; try { page.__turnstileLastSiteKey = k2; } catch {} break; }
                        } catch {}
                        try { await delay(250); } catch {}
                    }
                    if (!cachedKey) {
                        try {
                            const hint = await evaluateSafe(evalTarget, () => {
                                try {
                                    const ents = (performance && typeof performance.getEntriesByType === 'function')
                                        ? performance.getEntriesByType('resource')
                                        : [];
                                    const last = [];
                                    for (let i = Math.max(0, ents.length - 30); i < ents.length; i++) {
                                        const n = ents[i] && ents[i].name ? String(ents[i].name) : '';
                                        if (n && n.indexOf('challenges.cloudflare.com') >= 0) last.push(n.slice(0, 200));
                                    }
                                    return { count: ents.length, last };
                                } catch { return null; }
                            }).catch(() => null);
                            if (hint?.last?.length) logger.debug('turnstile:sitekey_missing_hint', { email, label, hint });
                        } catch {}
                    }
                }
            }
            if (!cachedKey && !state?.siteKey) {
                // Last-resort: scan frame URLs for the Turnstile key (works when iframe is in closed shadow root).
                try {
                    const frames = typeof page.frames === 'function' ? page.frames() : [];
                    for (const fr of frames) {
                        const u = (() => { try { return fr?.url?.() || ''; } catch { return ''; } })();
                        const k = turnstileExtractKeyFromUrlString(u);
                        if (k) {
                            cachedKey = k;
                            try { page.__turnstileLastSiteKey = k; } catch {}
                            break;
                        }
                    }
                } catch {}
            }
            const effectiveUrl = state?.href || (() => { try { return page.url(); } catch { return null; } })() || getCfg().PASSO_LOGIN;
            const isSeatSel2 = /\/koltuk-secim(\b|\/|\?|#)/i.test(String(effectiveUrl || ''));

            const browserForKey = await getBrowserFromPage(page);
            const sessionTurnstileKey = readBrowserStoredTurnstileKey(browserForKey);
            const cfgPassoKey = (getCfg().PASSO_SITE_KEY || '').trim() || null;
            const allowSeatCfgFallback = !!getCfg().PASSO_TURNSTILE_ALLOW_SEAT_FALLBACK;
            const effectiveSiteKey =
                state?.siteKey ||
                cachedKey ||
                sessionTurnstileKey ||
                (!isSeatSel2 && cfgPassoKey) ||
                (isSeatSel2 && allowSeatCfgFallback && cfgPassoKey) ||
                null;

            if (effectiveSiteKey && !state?.siteKey && !cachedKey) {
                logger.info('turnstile:sitekey_resolved_without_dom', {
                    email,
                    label,
                    via: sessionTurnstileKey ? 'browser_session' : 'PASSO_SITE_KEY',
                    isSeatSel: isSeatSel2
                });
            }

            if (!effectiveSiteKey || !hasCaptchaSolverCredentials(getCfg())) {
                logger.warn('turnstile:cannot_solve_missing_keys', {
                    email,
                    label,
                    hasSiteKey: !!effectiveSiteKey,
                    hasSolverCredentials: hasCaptchaSolverCredentials(getCfg()),
                    providers: buildProviderChain(getCfg())
                });
                return { attempted: false, state, missingKeys: true };
            }

            // If a solve is already in-flight, reuse it.
            if (cache?.inFlight) {
                logger.info('turnstile:reuse_inflight', { email, label, attempt, background });
                if (background) return { attempted: false, state, inFlight: true, background: true };
                return await cache.inFlight;
            }

            const solveWork = (async () => {
                logger.warn('turnstile:solve_attempt', { email, label, attempt, hasCachedKey: !!cachedKey });
                const solveStart = Date.now();

                const semStart = Date.now();
                await getTurnstileSolveSem().acquire();
                const waitedMs = Date.now() - semStart;
                if (waitedMs > 250) {
                    logger.info('turnstile:semaphore_wait', { email, label, waitedMs, sem: getTurnstileSolveSem().stats() });
                }

                let tok;
                let provider = 'unknown';
                try {
                    const solveTimeoutMs = Math.max(15000, Number(getCfg()?.TIMEOUTS?.TURNSTILE_SOLVE_TIMEOUT) || 120000);
                    const solved = await Promise.race([
                        solveTurnstileProxyless({
                            url: String(effectiveUrl),
                            siteKey: String(effectiveSiteKey),
                            cfg: getCfg()
                        }),
                        delay(solveTimeoutMs).then(() => {
                            throw new Error(`TURNSTILE_SOLVE_TIMEOUT_${solveTimeoutMs}`);
                        })
                    ]);
                    tok = solved?.token || '';
                    provider = solved?.provider || provider;
                } finally {
                    getTurnstileSolveSem().release();
                }
                try {
                    const br = await getBrowserFromPage(page);
                    storeBrowserTurnstileKey(br, effectiveSiteKey);
                } catch {}
                logger.info('turnstile:solve_result', {
                    email,
                    label,
                    attempt,
                    solveMs: Date.now() - solveStart,
                    tokenLength: tok ? String(tok).length : 0,
                    provider,
                    siteKey: String(effectiveSiteKey || '').slice(0, 80),
                    url: String(effectiveUrl || '').slice(0, 200)
                });

                await evalOnTarget(evalTarget, `
                    var token = (__args && __args.length) ? __args[0] : '';
                    var container = document.querySelector('#turnstile-container') || document.querySelector('.cf-turnstile') || document.querySelector('quick-form[name="loginform"]') || document.querySelector('quick-form');
                    var i = document.querySelector('#turnstile-container input[name="cf-turnstile-response"]') || document.querySelector('.cf-turnstile input[name="cf-turnstile-response"]') || document.querySelector('input[name="cf-turnstile-response"]');
                    if (!i) {
                        var parent = container || document.querySelector('form') || document.body;
                        i = document.createElement('input');
                        i.type = 'hidden';
                        i.name = 'cf-turnstile-response';
                        parent.appendChild(i);
                    }
                    i.value = token;
                    i.dispatchEvent(new Event('input', { bubbles: true }));
                    i.dispatchEvent(new Event('change', { bubbles: true }));
                    i.dispatchEvent(new Event('blur', { bubbles: true }));
                    if (typeof window.__passobotTurnstileCallback === 'function') {
                        try { window.__passobotTurnstileCallback(token); } catch (e) {}
                    }
                    var turnstileEl = document.querySelector('#turnstile-container') || document.querySelector('.cf-turnstile');
                    var cb = turnstileEl ? turnstileEl.getAttribute('data-callback') : null;
                    if (cb && typeof window[cb] === 'function') { try { window[cb](token); } catch (e) {} }
                    var tryNames = ['onTurnstileSuccess', 'onTurnstileCallback', 'handleTurnstileSuccess', 'turnstileCallback', 'cfCallback'];
                    for (var n = 0; n < tryNames.length; n++) {
                        if (typeof window[tryNames[n]] === 'function') { try { window[tryNames[n]](token); break; } catch (e) {} }
                    }
                `, [tok]);

                const after = await evaluateSafe(evalTarget, () => {
                    const input = document.querySelector('input[name="cf-turnstile-response"]');
                    const tokenLen = (input && input.value) ? String(input.value).length : 0;
                    return { hasTokenField: !!input, tokenLen };
                }).catch(() => ({ hasTokenField: false, tokenLen: 0 }));
                logger.info('turnstile:inject_check', { email, label, attempt, after, targetFrame: !!targetFrame });
                return { attempted: true, state, after };
            })();

            try {
                cache.inFlight = solveWork;
                cache.startedAt = Date.now();
            } catch {}

            if (background) {
                // do not block main flow; caller will await on next ensure call if needed
                solveWork.catch(() => {}).finally(() => {
                    try { if (cache) cache.inFlight = null; } catch {}
                });
                return { attempted: false, state, started: true, background: true };
            }

            try {
                const res = await solveWork;
                return res;
            } finally {
                try { if (cache) cache.inFlight = null; } catch {}
            }
        } catch (e) {
            const msg = e?.message || String(e);
            logger.warn('turnstile:ensure_failed', { email, label, attempt, background, error: msg });

            try { if (cache) cache.inFlight = null; } catch {}

            if (/detached|Target closed|Protocol error/i.test(msg)) {
                throw new Error('Sayfa oturumu sonlandı (uzun süreli Turnstile çözümü sırasında sayfa değişti). Lütfen tekrar deneyin.');
            }
            const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
            if (!transient || attempt >= maxAttempts) {
                return { attempted: false, error: msg, attempt };
            }
            const backoff = 900 * attempt;
            await delay(backoff);
        }
    }

    return { attempted: false, error: 'unknown', attempt: maxAttempts };
}

/**
 * reCAPTCHA v2 detection & solve.
 * Some Passo pages (e.g. /koltuk-secim) use Google reCAPTCHA v2 instead of Turnstile.
 * This function detects the reCAPTCHA iframe, extracts the sitekey, solves it via AntiCaptcha,
 * and injects the token into the page.
 */
async function ensureRecaptchaV2OnPage(page, email, label, options) {
    if (!page) return { attempted: false, type: 'recaptcha' };
    const opts = (options && typeof options === 'object') ? options : {};
    const background = !!opts.background;
    const waitForIframe = opts.waitForIframe !== false; // default true

    try {
        const extractRecaptchaKey = async () => {
            let key = null;
            try {
                const frames = typeof page.frames === 'function' ? page.frames() : [];
                for (const fr of frames) {
                    const u = (() => { try { return fr?.url?.() || ''; } catch { return ''; } })();
                    if (!u) continue;
                    if (u.indexOf('google.com/recaptcha') < 0 && u.indexOf('recaptcha/api2') < 0 && u.indexOf('recaptcha/enterprise') < 0) continue;
                    const m = u.match(/[?&]k=([0-9A-Za-z_-]+)/);
                    if (m && m[1]) { key = m[1]; break; }
                }
            } catch {}
            if (!key) {
                try {
                    key = await evaluateSafe(page, () => {
                        const el = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
                        if (el) return el.getAttribute('data-sitekey') || null;
                        try {
                            const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
                            for (const ifr of iframes) {
                                const src = ifr.getAttribute('src') || '';
                                const m = src.match(/[?&]k=([0-9A-Za-z_-]+)/);
                                if (m && m[1]) return m[1];
                            }
                        } catch {}
                        return null;
                    }).catch(() => null);
                } catch {}
            }
            return key;
        };

        // Poll for reCAPTCHA iframe to appear (it loads late on some pages)
        let recaptchaSiteKey = await extractRecaptchaKey();
        if (!recaptchaSiteKey && waitForIframe) {
            const pollEnd = Date.now() + 10000;
            while (!recaptchaSiteKey && Date.now() < pollEnd) {
                await delay(800);
                recaptchaSiteKey = await extractRecaptchaKey();
            }
            if (recaptchaSiteKey) {
                logger.info('recaptcha:key_found_after_poll', { email, label, siteKey: recaptchaSiteKey });
            }
        }

        if (!recaptchaSiteKey) {
            return { attempted: false, type: 'recaptcha', reason: 'no_sitekey' };
        }

        logger.info('recaptcha:detected', { email, label, siteKey: recaptchaSiteKey, background });

        if (background) {
            // Start solve in background, don't block
            const work = (async () => {
                try {
                    const pageUrl = (() => { try { return page.url(); } catch { return ''; } })();
                    const solveStart = Date.now();
                    await getTurnstileSolveSem().acquire();
                    let tok;
                    let provider = 'unknown';
                    try {
                        const solveTimeoutMs = Math.max(15000, Number(getCfg()?.TIMEOUTS?.TURNSTILE_SOLVE_TIMEOUT) || 120000);
                        const solved = await Promise.race([
                            solveRecaptchaV2Proxyless({
                                url: String(pageUrl),
                                siteKey: String(recaptchaSiteKey),
                                invisible: false,
                                cfg: getCfg()
                            }),
                            delay(solveTimeoutMs).then(() => { throw new Error(`RECAPTCHA_SOLVE_TIMEOUT_${solveTimeoutMs}`); })
                        ]);
                        tok = solved?.token || '';
                        provider = solved?.provider || provider;
                    } finally {
                        getTurnstileSolveSem().release();
                    }
                    logger.info('recaptcha:solve_result', { email, label, solveMs: Date.now() - solveStart, tokenLength: tok ? String(tok).length : 0, provider });
                    await injectRecaptchaToken(page, tok);
                    return { attempted: true, type: 'recaptcha', tokenLength: tok ? String(tok).length : 0 };
                } catch (e) {
                    logger.warn('recaptcha:solve_failed', { email, label, error: e?.message || String(e) });
                    return { attempted: false, type: 'recaptcha', error: e?.message || String(e) };
                }
            })();
            work.catch(() => {});
            return { attempted: false, type: 'recaptcha', started: true, background: true };
        }

        // Blocking solve — try invisible v2 FIRST (Passo always uses invisible reCAPTCHA on koltuk-secim),
        // then fall back to standard v2 if invisible fails. Saves ~10s per solve.
        const pageUrl = (() => { try { return page.url(); } catch { return ''; } })();
        const solveStart = Date.now();
        const solveTimeoutMs = Math.max(15000, Number(getCfg()?.TIMEOUTS?.TURNSTILE_SOLVE_TIMEOUT) || 120000);

        let tok = null;
        let solveType = 'v2';
        let provider = 'unknown';
        for (const invisible of [true, false]) {
            try {
                await getTurnstileSolveSem().acquire();
                try {
                    const solved = await Promise.race([
                        solveRecaptchaV2Proxyless({
                            url: String(pageUrl),
                            siteKey: String(recaptchaSiteKey),
                            invisible,
                            cfg: getCfg()
                        }),
                        delay(solveTimeoutMs).then(() => { throw new Error(`RECAPTCHA_SOLVE_TIMEOUT_${solveTimeoutMs}`); })
                    ]);
                    tok = solved?.token || '';
                    provider = solved?.provider || provider;
                    solveType = invisible ? 'v2-invisible' : 'v2';
                } finally {
                    getTurnstileSolveSem().release();
                }
                break;
            } catch (e) {
                const msg = e?.message || String(e);
                if (invisible && /INVALID_KEY_TYPE/i.test(msg)) {
                    logger.info('recaptcha:retry_standard', { email, label, error: msg });
                    continue;
                }
                throw e;
            }
        }

        logger.info('recaptcha:solve_result', { email, label, solveMs: Date.now() - solveStart, tokenLength: tok ? String(tok).length : 0, siteKey: recaptchaSiteKey, solveType, provider });

        await injectRecaptchaToken(page, tok);
        return { attempted: true, type: 'recaptcha', tokenLength: tok ? String(tok).length : 0, solveType };
    } catch (e) {
        logger.warn('recaptcha:ensure_failed', { email, label, error: e?.message || String(e) });
        return { attempted: false, type: 'recaptcha', error: e?.message || String(e) };
    }
}

async function injectRecaptchaToken(page, token) {
    if (!page || !token) return;
    try {
        const cbResult = await evaluateSafe(page, (tok) => {
            var result = { textarea: false, interceptedCallback: false, dataCallback: false, cfgCallback: false, executeTriggered: false };

            // 1. Set textarea value (all matching textareas)
            var tas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            if (!tas.length) {
                var form = document.querySelector('form') || document.body;
                var ta = document.createElement('textarea');
                ta.id = 'g-recaptcha-response';
                ta.name = 'g-recaptcha-response';
                ta.style.display = 'none';
                form.appendChild(ta);
                tas = [ta];
            }
            for (var i = 0; i < tas.length; i++) {
                tas[i].value = tok;
                tas[i].innerHTML = tok;
            }
            result.textarea = true;

            // 2. Store token for intercepted grecaptcha.execute() override
            window.__passobotRecaptchaToken = tok;

            // 3. PRIORITY: use intercepted callback from installRecaptchaCallbackInterceptor
            if (typeof window.__passobotRecaptchaCallback === 'function') {
                try {
                    window.__passobotRecaptchaCallback(tok);
                    result.interceptedCallback = true;
                } catch (e1) { result.interceptedCallbackErr = String(e1); }
            }

            // 4. data-callback attribute
            if (!result.interceptedCallback) {
                try {
                    var els = document.querySelectorAll('.g-recaptcha[data-callback], [data-callback]');
                    for (var j = 0; j < els.length; j++) {
                        var cbName = els[j].getAttribute('data-callback');
                        if (cbName && typeof window[cbName] === 'function') {
                            window[cbName](tok);
                            result.dataCallback = true;
                        }
                    }
                } catch (e2) {}
            }

            // 5. ___grecaptcha_getCfg().clients — find callback named 'callback' in widget config
            if (!result.interceptedCallback && !result.dataCallback) {
                try {
                    if (window.___grecaptcha_cfg && window.___grecaptcha_getCfg().clients) {
                        var clients = window.___grecaptcha_getCfg().clients;
                        var called = false;
                        for (var ck in clients) {
                            if (!clients.hasOwnProperty(ck)) continue;
                            var client = clients[ck];
                            var findCallback = function(obj, depth) {
                                if (depth > 6 || !obj || typeof obj !== 'object') return null;
                                if (typeof obj.callback === 'function') return obj.callback;
                                for (var fp in obj) {
                                    if (!obj.hasOwnProperty(fp)) continue;
                                    if (typeof obj[fp] === 'object') {
                                        var r = findCallback(obj[fp], depth + 1);
                                        if (r) return r;
                                    }
                                }
                                return null;
                            };
                            var cb = findCallback(client, 0);
                            if (cb) { try { cb(tok); called = true; } catch (e3) {} break; }
                        }
                        result.cfgCallback = called;
                    }
                } catch (e4) {}
            }

            // 6. Override grecaptcha.getResponse to return our token
            try {
                if (window.grecaptcha && typeof window.grecaptcha.getResponse === 'function') {
                    window.grecaptcha.getResponse = function() { return tok; };
                }
            } catch (e5) {}

            // 7. Try grecaptcha.execute() to trigger the site's invisible reCAPTCHA flow
            if (!result.interceptedCallback && !result.dataCallback) {
                try {
                    if (window.grecaptcha && typeof window.grecaptcha.execute === 'function') {
                        window.grecaptcha.execute();
                        result.executeTriggered = true;
                    }
                } catch (e6) { result.executeErr = String(e6); }
            }

            return result;
        }, token);

        logger.info('recaptcha:inject_callbacks', { cbResult });

        // After injection, wait briefly then check if page reacted
        await delay(1500);

        const check = await evaluateSafe(page, () => {
            var ta = document.querySelector('textarea[name="g-recaptcha-response"]');
            var hasDropdown = !!document.querySelector('.custom-select-box, select option, .dropdown-option');
            var hasSeatmap = document.querySelectorAll('svg.seatmap-svg, .seatmap-container, [class*="seatmap"]').length > 0;
            var hasSeatBtn = false;
            try {
                var norm = function(s) { return (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase(); };
                var btns = document.querySelectorAll('button, a, [role="button"]');
                for (var b = 0; b < btns.length; b++) {
                    if (norm(btns[b].innerText || btns[b].textContent || '').includes('kendim seçmek istiyorum')) { hasSeatBtn = true; break; }
                }
            } catch (e) {}
            return {
                hasField: !!ta,
                tokenLen: ta ? String(ta.value || '').length : 0,
                hasDropdown: hasDropdown,
                hasSeatmap: hasSeatmap,
                hasSeatBtn: hasSeatBtn,
                hasInterceptedCb: typeof window.__passobotRecaptchaCallback === 'function',
                hasParams: !!window.__passobotRecaptchaParams
            };
        }).catch(() => ({ hasField: false, tokenLen: 0 }));
        logger.info('recaptcha:inject_check', { check });
    } catch (e) {
        logger.warn('recaptcha:inject_failed', { error: e?.message || String(e) });
    }
}

async function detectRecaptchaPresence(page) {
    if (!page) return { hasRecaptcha: false, siteKey: null };
    try {
        const fromFrames = (() => {
            try {
                const frames = typeof page.frames === 'function' ? page.frames() : [];
                for (const fr of frames) {
                    const u = (() => { try { return fr?.url?.() || ''; } catch { return ''; } })();
                    if (!u) continue;
                    if (u.indexOf('google.com/recaptcha') < 0 && u.indexOf('recaptcha/api2') < 0 && u.indexOf('recaptcha/enterprise') < 0) continue;
                    const m = u.match(/[?&]k=([0-9A-Za-z_-]+)/);
                    return { hasRecaptcha: true, siteKey: m && m[1] ? m[1] : null };
                }
            } catch {}
            return null;
        })();
        if (fromFrames) return fromFrames;
        const fromDom = await evaluateSafe(page, () => {
            const iframe = document.querySelector('iframe[src*="recaptcha" i], iframe[src*="google.com/recaptcha" i]');
            const recNode = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey*="6L"], [data-sitekey*="6l"]');
            let siteKey = null;
            if (recNode) {
                try { siteKey = recNode.getAttribute('data-sitekey') || null; } catch {}
            }
            if (!siteKey && iframe) {
                try {
                    const src = iframe.getAttribute('src') || '';
                    const m = src.match(/[?&]k=([0-9A-Za-z_-]+)/);
                    if (m && m[1]) siteKey = m[1];
                } catch {}
            }
            return {
                hasRecaptcha: !!(iframe || recNode),
                siteKey: siteKey || null
            };
        }).catch(() => ({ hasRecaptcha: false, siteKey: null }));
        return fromDom || { hasRecaptcha: false, siteKey: null };
    } catch {
        return { hasRecaptcha: false, siteKey: null };
    }
}

/**
 * Wrapper: tries Turnstile first, then falls back to reCAPTCHA v2 if Turnstile can't solve.
 */
async function ensureCaptchaOnPage(page, email, label, options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const allowRecaptchaFallback = opts.recaptchaFallback !== false;
    const turnstileResult = await ensureTurnstileTokenOnPage(page, email, label, options);
    // If Turnstile solved successfully or is in-flight, return
    if (turnstileResult?.attempted || turnstileResult?.started || turnstileResult?.inFlight) {
        logger.info('captcha:wrapper_turnstile_ok', { email, label, attempted: turnstileResult?.attempted, started: turnstileResult?.started });
        return turnstileResult;
    }
    // If Turnstile found a widget with token already set, no need to solve
    if (turnstileResult?.state?.tokenLen > 0) {
        return turnstileResult;
    }
    if (!allowRecaptchaFallback) {
        logger.info('captcha:wrapper_skip_recaptcha', { email, label, reason: 'recaptcha_fallback_disabled' });
        return turnstileResult;
    }
    // If Turnstile couldn't solve (missing keys / no widget), try reCAPTCHA v2
    // Only attempt reCAPTCHA fallback when recaptcha presence is actually detected.
    const recaptchaPresence = await detectRecaptchaPresence(page);
    if (!recaptchaPresence?.hasRecaptcha) {
        logger.info('captcha:wrapper_skip_recaptcha', { email, label, reason: 'recaptcha_not_detected' });
        return turnstileResult;
    }
    // On /koltuk-secim pages, reCAPTCHA iframe can load late; if already detected, allow polling.
    const isKoltukSecim = (() => { try { return /\/koltuk-secim/i.test(page.url()); } catch { return false; } })();
    logger.info('captcha:wrapper_try_recaptcha', { email, label, isKoltukSecim, turnstileMissingKeys: !!turnstileResult?.missingKeys, recaptchaDetected: true, hasSiteKey: !!recaptchaPresence?.siteKey });
    const recaptchaOpts = { ...(options || {}), waitForIframe: isKoltukSecim };
    const recaptchaResult = await ensureRecaptchaV2OnPage(page, email, label, recaptchaOpts);
    logger.info('captcha:wrapper_recaptcha_result', { email, label, attempted: recaptchaResult?.attempted, started: recaptchaResult?.started, reason: recaptchaResult?.reason, solveType: recaptchaResult?.solveType });
    if (recaptchaResult?.attempted || recaptchaResult?.started) {
        return recaptchaResult;
    }
    return turnstileResult;
}

const FINALIZE_C_MIN_CHALLENGE_TOKEN_LEN = 80;

async function readFinalizeCChallengeTokens(page) {
    if (!page) return { tsLen: 0, hasTsWidget: false, tsFieldPresent: false, recLen: 0, hasRec: false };
    return await evaluateSafe(page, () => {
        const tsIn = document.querySelector('input[name="cf-turnstile-response"]');
        const tsLen = tsIn && tsIn.value ? String(tsIn.value).length : 0;
        const tsFieldPresent = !!tsIn;
        const hasTsWidget = !!document.querySelector('.cf-turnstile, #turnstile-container');
        const recTa = document.querySelector('textarea[name="g-recaptcha-response"]');
        const recLen = recTa && recTa.value ? String(recTa.value).length : 0;
        const hasRec =
            !!document.querySelector('iframe[src*="recaptcha" i]') ||
            !!document.querySelector('iframe[src*="google.com/recaptcha" i]') ||
            !!document.querySelector('.g-recaptcha');
        return { tsLen, hasTsWidget, tsFieldPresent, recLen, hasRec };
    }).catch(() => ({ tsLen: 0, hasTsWidget: false, tsFieldPresent: false, recLen: 0, hasRec: false }));
}

/** Passo /koltuk-secim: Turnstile + reCAPTCHA birlikte; sadece biri dolu olsa holder kaldırma yapılmamalı. */
function isFinalizeCHumanChallengeSatisfied(s) {
    const minL = FINALIZE_C_MIN_CHALLENGE_TOKEN_LEN;
    const needTsToken = !!(s.hasTsWidget || s.tsFieldPresent);
    if (needTsToken && s.tsLen < minL) return false;
    if (s.hasRec && s.recLen < minL) return false;
    if (!needTsToken && !s.hasRec && s.tsLen < minL && s.recLen < minL) return false;
    return true;
}

/** Finalize: holder A/B sepetten çıkarmadan önce C /koltuk-secim sayfasında gerçek token olmalı. */
async function waitUntilFinalizeCHumanChallengeReady(page, email) {
    const solveCap = Math.max(60000, Number(getCfg()?.TIMEOUTS?.TURNSTILE_SOLVE_TIMEOUT) || 120000);
    const until = Date.now() + solveCap + 45000;
    let iteration = 0;
    while (Date.now() < until) {
        iteration += 1;
        const s = await readFinalizeCChallengeTokens(page);
        if (isFinalizeCHumanChallengeSatisfied(s)) {
            logger.info('finalize_c_challenge_ready', { email, iteration, ...s });
            return;
        }
        logger.warn('finalize_c_challenge_still_waiting', { email, iteration, ...s });
        try {
            await ensureCaptchaOnPage(page, email, `C.waitHumanTok.${iteration}`, { background: false });
        } catch (e) {
            logger.warnSafe('finalize_c_challenge_ensure_tick_failed', { email, iteration, error: e?.message || String(e) });
        }
        await delay(Math.min(5000, 700 + iteration * 150));
    }
    const fin = await readFinalizeCChallengeTokens(page);
    if (!isFinalizeCHumanChallengeSatisfied(fin)) {
        throw new Error(
            `FINALIZE_C_CAPTCHA_NOT_READY:ts=${fin.tsLen},rec=${fin.recLen},hasTs=${fin.hasTsWidget},hasRec=${fin.hasRec}`
        );
    }
}

/**
 * Turnstile render intercept: window.turnstile.render çağrılmadan önce
 * callback'i yakalar. 2Captcha/Stack Overflow yöntemi - addInitScript ile
 * sayfa yüklenmeden önce enjekte edilir.
 * Kaynak: https://stackoverflow.com/questions/79027476/how-to-inject-a-cloudflare-turnstile-token-into-puppeteer
 * Kaynak: https://2captcha.com/api-docs/cloudflare-turnstile
 */
async function installTurnstileCallbackInterceptor(page) {
    const addScript = page?.addInitScript || page?.evaluateOnNewDocument;
    if (!page || typeof addScript !== 'function') return;
    try {
        await addScript.call(page, () => {
            (function () {
                var check = setInterval(function () {
                    if (typeof window.turnstile !== 'undefined') {
                        clearInterval(check);
                        var orig = window.turnstile.render;
                        if (!orig) return;
                        window.turnstile.render = function (a, b) {
                            if (b && typeof b.callback === 'function') {
                                window.__passobotTurnstileCallback = b.callback;
                            }
                            return orig.apply(this, arguments);
                        };
                    }
                }, 5);
                setTimeout(function () { clearInterval(check); }, 30000);
            })();
        });
        logger.debug('installTurnstileCallbackInterceptor: init script eklendi');
    } catch (e) {
        logger.warn('installTurnstileCallbackInterceptor: hata', { error: e?.message });
    }
}

/**
 * reCAPTCHA render intercept: grecaptcha.render çağrılmadan önce
 * callback'i yakalar ve grecaptcha.execute()'u override eder.
 * Bu sayede invisible reCAPTCHA'da token enjeksiyonu sonrası
 * sitenin callback'i doğru tetiklenir.
 */
async function installRecaptchaCallbackInterceptor(page) {
    const addScript = page?.addInitScript || page?.evaluateOnNewDocument;
    if (!page || typeof addScript !== 'function') return;
    try {
        await addScript.call(page, () => {
            (function () {
                var check = setInterval(function () {
                    if (typeof window.grecaptcha !== 'undefined' && window.grecaptcha) {
                        clearInterval(check);

                        // Intercept grecaptcha.render to capture callback
                        var origRender = window.grecaptcha.render;
                        if (origRender && typeof origRender === 'function') {
                            window.grecaptcha.render = function (container, params) {
                                if (params && typeof params.callback === 'function') {
                                    window.__passobotRecaptchaCallback = params.callback;
                                }
                                if (params && typeof params === 'object') {
                                    window.__passobotRecaptchaParams = JSON.parse(JSON.stringify({
                                        sitekey: params.sitekey || null,
                                        size: params.size || null,
                                        badge: params.badge || null
                                    }));
                                }
                                return origRender.apply(this, arguments);
                            };
                        }

                        // Intercept grecaptcha.execute to allow token injection
                        var origExecute = window.grecaptcha.execute;
                        if (origExecute && typeof origExecute === 'function') {
                            window.grecaptcha.execute = function () {
                                // If we have a pre-solved token, call the callback directly
                                if (window.__passobotRecaptchaToken && window.__passobotRecaptchaCallback) {
                                    try {
                                        window.__passobotRecaptchaCallback(window.__passobotRecaptchaToken);
                                        window.__passobotRecaptchaToken = null; // consume
                                        return;
                                    } catch (e) {}
                                }
                                return origExecute.apply(this, arguments);
                            };
                        }
                    }
                }, 50);
                setTimeout(function () { clearInterval(check); }, 60000);
            })();
        });
        logger.debug('installRecaptchaCallbackInterceptor: init script eklendi');
    } catch (e) {
        logger.warn('installRecaptchaCallbackInterceptor: hata', { error: e?.message });
    }
}

/** Ticketing API'den captchaGuid alır */
async function getcaptchaGuid() {
    const base = (getCfg().TICKETING_API_BASE || 'https://ticketingweb.passo.com.tr').replace(/\/$/, '');
    const url = `${base}/api/passoweb/getcaptcha`;
    try {
        const res = await axios.post(url, {}, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
        const guid = res?.data?.captchaGuid || res?.data?.data?.captchaGuid;
        if (guid) return guid;
        logger.warn('getcaptchaGuid: captchaGuid bulunamadı', { data: res?.data });
        return null;
    } catch (e) {
        logger.warn('getcaptchaGuid: hata', { error: e?.message });
        return null;
    }
}

/**
 * Snipe sırasında sayfa içi fetch('/api/passoweb/...') same-origin olmalı.
 * www etkinlik URL'sini ticketingweb host'una taşır (path/query korunur).
 */
function seedTicketingWebUrlForSnipePoll(eventAddress) {
    const tw = (getCfg().TICKETING_API_BASE || 'https://ticketingweb.passo.com.tr').replace(/\/$/, '');
    const s = String(eventAddress || '').trim();
    if (!s) return `${tw}/`;
    try {
        const u = new URL(s);
        const h = u.hostname.toLowerCase();
        if (h === 'www.passo.com.tr' || h === 'passo.com.tr') {
            u.hostname = 'ticketingweb.passo.com.tr';
            return u.toString();
        }
        if (h === 'ticketingweb.passo.com.tr') return s;
    } catch {}
    return `${tw}/`;
}

/**
 * Form submit başarısızsa doğrudan API ile giriş dener.
 * Şifreleme sayfa tarafında yapıldığı için page.evaluate ile form submit'ı tetikler.
 */
async function tryLoginViaApi(page, email, password, cloudflareToken, captchaGuid, evalTarget) {
    if (!page || !email || !password || !cloudflareToken) return false;
    const target = evalTarget || page;
    const base = (getCfg().TICKETING_API_BASE || 'https://ticketingweb.passo.com.tr').replace(/\/$/, '');
    const loginUrl = `${base}/api/passoweb/login`;

    try {
        const result = await evalOnTarget(target, `
            var email = __args[0];
            var password = __args[1];
            var token = __args[2];
            var loginUrl = __args[3];

            var trySubmit = function() {
                    var userEl = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]');
                    var passEl = document.querySelector('input[autocomplete="current-password"], input[type="password"], input[name*="pass"]');
                    if (!userEl || !passEl) return false;

                    var form = userEl.closest('form') || passEl.closest('form');
                    var quickForm = userEl.closest('quick-form') || passEl.closest('quick-form') || document.querySelector('quick-form[name="loginform"]') || document.querySelector('quick-form');

                    if (form && typeof form.requestSubmit === 'function') {
                        try { form.requestSubmit(); return 'form'; } catch (e) {}
                    }
                    if (quickForm) {
                        var btns = quickForm.querySelectorAll('button.black-btn, button');
                        for (var i = 0; i < btns.length; i++) {
                            var btn = btns[i];
                            var t = (btn.innerText || btn.textContent || '').trim().toUpperCase();
                            if ((t.indexOf('GİRİŞ') >= 0 || t.indexOf('GIRIS') >= 0) && t.indexOf('ÜYE') < 0 && t.indexOf('KAYIT') < 0) {
                                btn.style.display = 'block';
                                btn.style.visibility = 'visible';
                                btn.style.opacity = '1';
                                btn.removeAttribute('disabled');
                                btn.disabled = false;
                                btn.click();
                                return 'quick_form';
                            }
                        }
                        if (quickForm.shadowRoot) {
                            var sBtns = quickForm.shadowRoot.querySelectorAll('button');
                            for (var j = 0; j < sBtns.length; j++) {
                                var sBtn = sBtns[j];
                                var st = (sBtn.innerText || sBtn.textContent || '').trim().toUpperCase();
                                if ((st.indexOf('GİRİŞ') >= 0 || st.indexOf('GIRIS') >= 0)) {
                                    sBtn.click();
                                    return 'shadow_btn';
                                }
                            }
                        }
                    }
                    return false;
                };

                var originalFetch = window.fetch;
                var captured = null;
                window.fetch = function() {
                    var url = arguments[0];
                    if (url && String(url).indexOf('/api/passoweb/login') >= 0 && arguments[1] && arguments[1].body) {
                        captured = arguments[1].body;
                    }
                    return originalFetch.apply(this, arguments);
                };

                var userEl = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"]');
                var passEl = document.querySelector('input[autocomplete="current-password"], input[type="password"], input[name*="pass"]');
                if (userEl && passEl) {
                    userEl.value = email;
                    userEl.dispatchEvent(new Event('input', { bubbles: true }));
                    userEl.dispatchEvent(new Event('change', { bubbles: true }));
                    passEl.value = password;
                    passEl.dispatchEvent(new Event('input', { bubbles: true }));
                    passEl.dispatchEvent(new Event('change', { bubbles: true }));
                }

                var tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
                if (tokenInput) {
                    tokenInput.value = token;
                    tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
                    tokenInput.dispatchEvent(new Event('change', { bubbles: true }));
                }

                var submitResult = trySubmit();
                if (submitResult) {
                    return { ok: true, method: submitResult, captured: !!captured };
                }

                window.fetch = originalFetch;
                if (captured) return { ok: false, captured: true };

                var ng = window.ng;
                if (ng && typeof ng.getComponent === 'function') {
                    var qf = document.querySelector('quick-form');
                    if (qf) {
                        try {
                            var comp = ng.getComponent(qf);
                            if (comp && typeof comp.onSubmit === 'function') {
                                comp.onSubmit();
                                return { ok: true, method: 'ng_component' };
                            }
                        } catch (e) {}
                    }
                }
                return { ok: false };
        `, [email, password, cloudflareToken, loginUrl]);

        if (result?.ok) {
            logger.info('tryLoginViaApi: submit tetiklendi', { method: result.method });
            return true;
        }
        return false;
    } catch (e) {
        logger.warn('tryLoginViaApi: hata', { error: e?.message });
        return false;
    }
}

function buildProxyArgs(proxyHost, proxyPort) {
    const c = getCfg();
    const windowSize = c.BROWSER_WINDOW_SIZE || '1280,720';
    const useMinimalArgs = c.FLAGS.BROWSER_MINIMAL_ARGS === true;
    let args = useMinimalArgs
        ? [`--window-size=${windowSize}`]
        : [
            `--window-size=${windowSize}`,
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--mute-audio',
            '--no-first-run',
            '--disable-default-apps',
            '--disable-background-networking',
            '--disable-background-downloads',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--metrics-recording-only',
            '--safebrowsing-disable-auto-update',
            '--disable-client-side-phishing-detection'
        ];
    if (process.platform !== 'win32') {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
        args.push('--disable-dev-shm-usage');
        if (!useMinimalArgs) {
            args.push('--disable-gpu', '--disable-software-rasterizer');
            args.push('--disable-features=VizDisplayCompositor');
        }
    }
    let proxyApplied = false;
    if (proxyHost && proxyPort) {
        let host = String(proxyHost).trim();
        if (!/^(http|https|socks4|socks5):\/\//i.test(host)) host = `http://${host}`;
        const u = new URL(host);
        u.port = String(proxyPort);
        args.push(`--proxy-server=${u.protocol}//${u.hostname}:${u.port}`);
        proxyApplied = true;
    }
    return {args, proxyApplied, useMinimalArgs};
}

function resolveBrowserExecutablePath(configuredPath) {
    const raw = String(configuredPath || '').trim().replace(/^['"]|['"]$/g, '');
    const isWin = process.platform === 'win32';
    const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

    const candidates = isWin ? [
        raw,
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${programFilesX86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`
    ] : [
        raw,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/chromium-browser-unstable'
    ];

    for (const candidate of candidates.filter(Boolean)) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {}
    }
    return null;
}

async function connectStableBrowser({ chromePath, userDataDir, args, ignoreAllFlags }) {
    try {
        return await realBrowserConnect({
            headless: false,
            turnstile: false,
            args,
            ignoreAllFlags: !!ignoreAllFlags,
            customConfig: {
                chromePath,
                userDataDir
            },
            connectOption: {
                defaultViewport: null
            }
        });
    } catch (e) {
        const msg = e?.message || String(e);
        const canFallback = /Invalid host defined options/i.test(msg) || !!process.pkg;
        if (!canFallback) throw e;

        logger.warn('launchAndLogin: real-browser connect failed, using puppeteer-core fallback', { error: msg });

        if (!chromePath) {
            throw new Error(
                'Chrome/Brave/Edge bulunamadi. CHROME_PATH ayarlayin veya tarayici kurulumunu kontrol edin.'
            );
        }

        const launchOpts = {
            headless: false,
            executablePath: chromePath,
            userDataDir,
            args,
            defaultViewport: null
        };
        const browser = await rebrowserPuppeteer.launch(launchOpts);
        let [page] = await browser.pages();
        if (!page) page = await browser.newPage();
        return { browser, page };
    }
}

/** Giriş aşamasında hata olunca açık kalan Chromium sürecini kapat (proxy/network hatalarında zombi pencereleri önler). */
async function disposeBrowserAfterFailedLogin(browser, email, err) {
    if (!browser) return;
    try {
        unregisterPassobotBrowser(browser);
    } catch {}
    try {
        const pages = await browser.pages().catch(() => []);
        for (const p of pages || []) {
            try {
                await p.close({ runBeforeUnload: false });
            } catch {}
        }
    } catch {}
    try {
        await browser.close();
        logger.info('launchAndLogin: tarayıcı kapatıldı (giriş başarısız)', {
            email,
            reason: err?.message || String(err)
        });
    } catch (e) {
        logger.warn('launchAndLogin: tarayıcı kapatılamadı', {
            email,
            error: e?.message || String(e)
        });
    }
}

/** Çerez / EFILLI / OneTrust overlay giriş SPA'sını kilitliyebilir; tıkla veya overlay'i devre dışı bırak. */
async function dismissPassoLoginShellOverlays(page, email, tag) {
    if (!page) return;
    try {
        const summary = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const wants = (t) => {
                const x = norm(t);
                return (
                    x.includes('kabul') ||
                    x.includes('accept') ||
                    x.includes('onay') ||
                    x.includes('tamam') ||
                    x.includes('anlad') ||
                    x.includes('allow') ||
                    x.includes('agree') ||
                    x.includes('tümünü') ||
                    x.includes('tumunu') ||
                    (x.includes('devam') && x.length < 28) ||
                    x === 'evet'
                );
            };
            let clicks = 0;
            const clickIf = (el) => {
                if (!el) return;
                try {
                    el.click();
                    clicks++;
                } catch {}
            };
            try {
                clickIf(document.querySelector('#onetrust-accept-btn-handler'));
                clickIf(document.querySelector('#accept-recommended-btn-handler'));
            } catch {}
            try {
                const swal = document.querySelector('.swal2-container.swal2-shown');
                clickIf(swal?.querySelector('button.swal2-confirm, button.swal2-cancel, button'));
            } catch {}
            for (const b of Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))) {
                const t = b.innerText || b.textContent || b.getAttribute('aria-label') || '';
                if (wants(t)) {
                    clickIf(b);
                    break;
                }
            }
            const tryClickActions = (root) => {
                if (!root || !root.querySelectorAll) return 0;
                for (const el of Array.from(root.querySelectorAll('button, a, div[role="button"], span[role="button"], [aria-label]'))) {
                    const t = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
                    if (!wants(t)) continue;
                    try {
                        el.click();
                        return 1;
                    } catch {}
                }
                return 0;
            };
            const walk = (root) => {
                if (!root) return 0;
                let c = tryClickActions(root);
                if (c) return c;
                for (const el of Array.from(root.querySelectorAll('*'))) {
                    const sr = el.shadowRoot;
                    if (sr) {
                        c = walk(sr);
                        if (c) return c;
                    }
                }
                return 0;
            };
            const efs = Array.from(
                document.querySelectorAll('efilli-layout-dynamic, efilli-layout, efilli-consent, [id*="efilli" i], [class*="efilli" i]')
            );
            for (const ef of efs) {
                clicks += walk(ef.shadowRoot);
                try {
                    ef.style.setProperty('pointer-events', 'none', 'important');
                    ef.style.setProperty('visibility', 'hidden', 'important');
                } catch {}
            }
            return { clicks };
        });
        if (summary && summary.clicks > 0) {
            logger.info('launchAndLogin: çerez/overlay kapatıldı', { email, tag, clicks: summary.clicks });
        }
    } catch {}
    try {
        await page.keyboard.press('Escape');
    } catch {}
    await delay(400);
}

async function launchAndLogin(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const email = opts.email;
    const password = opts.password;
    const userDataDir = opts.userDataDir;
    const proxyHost = opts.proxyHost;
    const proxyPort = opts.proxyPort;
    const proxyUsername = opts.proxyUsername;
    const proxyPassword = opts.proxyPassword;
    const loginRunId = opts.runId;

    assertLaunchRunNotKilled(loginRunId, 'enter');

    const {args, proxyApplied, useMinimalArgs} = buildProxyArgs(proxyHost, proxyPort);
    const chromePath = resolveBrowserExecutablePath(getCfg().CHROME_PATH);

    if (userDataDir) {
        try {
            fs.mkdirSync(userDataDir, { recursive: true });
        } catch (e) {
            logger.warn('launchAndLogin: userDataDir oluşturulamadı', { userDataDir, error: e?.message });
        }
    }

    logger.debug('launchAndLogin: browser connect başlıyor', {
        email,
        userDataDir,
        proxyApplied,
        chromePath: chromePath || 'not-found'
    });
    assertLaunchRunNotKilled(loginRunId, 'before_connect');
    const ret = await connectStableBrowser({ chromePath, userDataDir, args, ignoreAllFlags: useMinimalArgs });
    const browser = ret.browser;
    let page;
    try {
        page = ret.page || await ensurePage(browser);
    } catch (ensureErr) {
        await disposeBrowserAfterFailedLogin(browser, email, ensureErr);
        throw ensureErr;
    }
    assertLaunchRunNotKilled(loginRunId, 'after_ensure_page');

    try {
        try {
            logger.debug('launchAndLogin: browser/page hazır', {
                email,
                hasInitialPage: !!ret.page,
                currentUrl: (() => {
                    try { return page.url(); } catch { return null; }
                })()
            });
        } catch {}
        registerPassobotBrowser(browser, String(opts.runId || '').trim() || 'login-pending');
    if (proxyApplied && proxyUsername && proxyPassword) {
        try {
            await page.authenticate({username: String(proxyUsername), password: String(proxyPassword)});
            logger.debug('launchAndLogin: proxy authentication uygulandı', { email });
        } catch {
            logger.warn('launchAndLogin: proxy authentication başarısız/atlanıyor', { email });
        }
    }

    logger.debug('launchAndLogin: login sayfasına gidiliyor', { email, url: getCfg().PASSO_LOGIN });
    assertLaunchRunNotKilled(loginRunId, 'before_login_goto');

    await installTurnstileSiteKeyNetworkWatcher(page);
    await installTurnstileCallbackInterceptor(page);

    // Capture main document response info for /giris
    let lastLoginDoc = null;
    const onResp = (resp) => {
        try {
            const req = resp.request();
            const rt = req?.resourceType?.();
            const url = resp.url?.() || '';
            if (rt === 'document' && /\/tr\/giris(\?|$)/i.test(url)) {
                lastLoginDoc = {
                    url,
                    status: resp.status?.(),
                    ok: resp.ok?.(),
                    fromCache: resp.fromCache?.(),
                    fromServiceWorker: resp.fromServiceWorker?.()
                };
            }
        } catch {}
    };
    try { page.on('response', onResp); } catch {}
    let gotoRes = await gotoWithRetry(page, getCfg().PASSO_LOGIN, {
        retries: 2,
        waitUntil: 'domcontentloaded',
        expectedUrlIncludes: '/giris',
        timeoutMs: 45000,
        backoffMs: 400
    });
    if (!gotoRes?.ok) {
        logger.warn('launchAndLogin: login goto başarısız, networkidle2 ile fallback deneniyor', {
            email,
            goto: gotoRes,
            currentUrl: (() => { try { return page.url(); } catch { return null; } })()
        });
        gotoRes = await gotoWithRetry(page, getCfg().PASSO_LOGIN, {
            retries: 1,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: '/giris',
            timeoutMs: 60000,
            backoffMs: 450
        });
    }
    logger.info('launchAndLogin: login goto sonucu', {
        email,
        goto: gotoRes,
        currentUrl: (() => { try { return page.url(); } catch { return null; } })()
    });

    const currentLoginUrl = (() => { try { return String(page.url() || ''); } catch { return ''; } })();
    const isChromeErrorPage = /^chrome-error:\/\//i.test(currentLoginUrl);
    if (!gotoRes?.ok || isChromeErrorPage) {
        logger.warn('launchAndLogin: login sayfasına erişilemedi, akış fail ediliyor', {
            email,
            goto: gotoRes,
            currentUrl: currentLoginUrl,
            isChromeErrorPage
        });
        throw new Error(`Login sayfasina erisilemedi (${isChromeErrorPage ? 'chrome_error' : 'goto_failed'})`);
    }

    try {
        logger.info('launchAndLogin: login document response', { email, doc: lastLoginDoc });
    } catch {}

    const loginSnapScript = `
            var bodyText = (document.body && document.body.innerText) ? String(document.body.innerText).toLowerCase() : '';
            var hasVerifyHuman = bodyText.indexOf('verify you are human') >= 0;
            var hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
            var hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            var title = document.title || '';
            var inputCount = document.querySelectorAll('input').length;
            var formCount = document.querySelectorAll('form').length;
            var scriptCount = document.querySelectorAll('script').length;
            var linkCount = document.querySelectorAll('link[rel="stylesheet"], link[as="style"], style').length;
            var bodyHtmlLen = (document.body && document.body.innerHTML) ? document.body.innerHTML.length : 0;
            var docHtmlLen = (document.documentElement && document.documentElement.outerHTML) ? document.documentElement.outerHTML.length : 0;
            return {
                title: title,
                hasVerifyHuman: hasVerifyHuman,
                hasTurnstileWidget: hasTurnstileWidget,
                hasTurnstileTokenField: hasTurnstileTokenField,
                inputCount: inputCount,
                formCount: formCount,
                scriptCount: scriptCount,
                linkCount: linkCount,
                bodyHtmlLen: bodyHtmlLen,
                docHtmlLen: docHtmlLen
            };`;

    try {
        let snap0 = await evalOnPage(page, loginSnapScript);
        logger.info('launchAndLogin: login sayfası yüklendi', { email, snap: snap0 });

        const passoHomeTrLogin = (() => {
            try {
                const u = String(getCfg().PASSO_LOGIN || '');
                const h = u.replace(/\/tr\/giris.*$/i, '/tr').replace(/\/+$/, '');
                return h && /^https?:\/\//i.test(h) ? h : 'https://www.passo.com.tr/tr';
            } catch {
                return 'https://www.passo.com.tr/tr';
            }
        })();

        if (snapshotLooksLikeCloudflareBlock(snap0, lastLoginDoc?.status)) {
            logger.warn('launchAndLogin: olası Cloudflare/403, ana sayfa → /giris kurtarma', {
                email,
                docStatus: lastLoginDoc?.status
            });
            for (let cfRound = 1; cfRound <= 3; cfRound++) {
                assertLaunchRunNotKilled(loginRunId, `cf_recover_${cfRound}`);
                try {
                    await delay(1600 + cfRound * 400);
                    await gotoWithRetry(page, passoHomeTrLogin, {
                        retries: 1,
                        waitUntil: 'domcontentloaded',
                        timeoutMs: 55000,
                        backoffMs: 500
                    });
                } catch {}
                await delay(700);
                const bustCf = `${getCfg().PASSO_LOGIN}${getCfg().PASSO_LOGIN.includes('?') ? '&' : '?'}pb_cfrecover=${Date.now()}_${cfRound}`;
                try {
                    await gotoWithRetry(page, bustCf, {
                        retries: 1,
                        waitUntil: cfRound % 2 === 0 ? 'networkidle2' : 'domcontentloaded',
                        expectedUrlIncludes: '/giris',
                        timeoutMs: 65000,
                        backoffMs: 500
                    });
                } catch {}
                await dismissPassoLoginShellOverlays(page, email, `cf_recover_${cfRound}`);
                await delay(1100 + cfRound * 200);
                snap0 = await evalOnPage(page, loginSnapScript);
                logger.info('launchAndLogin: CF kurtarma sonrası snapshot', { email, cfRound, snap: snap0 });
                if (!snapshotLooksLikeCloudflareBlock(snap0, lastLoginDoc?.status)) break;
            }
        }

        // Passo SPA: bazen /giris açılır ama sadece shell (logo) kalır; inputCount=0 iken body büyük olabilir.
        // Eski kod yalnızca bodyHtmlLen<500 iken reload ediyordu — bu yüzden form hiç gelmeyebiliyordu.
        const girisUrlNow = (() => { try { return String(page.url() || ''); } catch { return ''; } })();
        const noLoginFieldsYet = (s) => ((s?.inputCount || 0) === 0 && (s?.formCount || 0) === 0);
        if (/\/giris(\?|$)/i.test(girisUrlNow) && noLoginFieldsYet(snap0)) {
            const snapScript = loginSnapScript;
            const passoHomeTr = passoHomeTrLogin;
            let lastSnap = snap0;
            await dismissPassoLoginShellOverlays(page, email, 'shell_once_before_loop');
            lastSnap = await evalOnPage(page, snapScript);
            logger.info('launchAndLogin: çerez sonrası snapshot', { email, snap: lastSnap });
            for (let attempt = 1; attempt <= 15 && noLoginFieldsYet(lastSnap); attempt++) {
                assertLaunchRunNotKilled(loginRunId, `shell_${attempt}`);
                logger.warn('launchAndLogin: giriş formu henüz yok (SPA/shell), zorla yenileme', {
                    email,
                    attempt,
                    bodyHtmlLen: lastSnap.bodyHtmlLen,
                    docHtmlLen: lastSnap.docHtmlLen
                });
                if (attempt === 4 || attempt === 8 || attempt === 12) {
                    logger.warn('launchAndLogin: ana sayfa üzerinden router sıfırlanıyor', { email, attempt, passoHomeTr });
                    try {
                        await gotoWithRetry(page, passoHomeTr, {
                            retries: 1,
                            waitUntil: 'domcontentloaded',
                            timeoutMs: 55000,
                            backoffMs: 500
                        });
                    } catch {}
                    await dismissPassoLoginShellOverlays(page, email, `shell_home_${attempt}`);
                    await delay(700);
                }
                const baseLogin = getCfg().PASSO_LOGIN;
                const bustUrl = `${baseLogin}${baseLogin.includes('?') ? '&' : '?'}pb_hydrate=${Date.now()}`;
                try {
                    await gotoWithRetry(page, bustUrl, {
                        retries: 1,
                        waitUntil: attempt % 2 === 0 ? 'networkidle2' : 'domcontentloaded',
                        expectedUrlIncludes: '/giris',
                        timeoutMs: 65000,
                        backoffMs: 500
                    });
                } catch {
                    try {
                        await page.reload({
                            waitUntil: attempt % 2 === 0 ? 'networkidle2' : 'domcontentloaded',
                            timeout: 65000
                        });
                    } catch {}
                }
                await delay(900 + attempt * 220);
                if (snapshotLooksLikeCloudflareBlock(lastSnap, lastLoginDoc?.status)) {
                    try {
                        await delay(1200);
                        await gotoWithRetry(page, passoHomeTr, {
                            retries: 1,
                            waitUntil: 'domcontentloaded',
                            timeoutMs: 55000,
                            backoffMs: 500
                        });
                    } catch {}
                    await delay(600);
                }
                await dismissPassoLoginShellOverlays(page, email, `shell_${attempt}`);
                try {
                    await page.waitForSelector(
                        'input[type="password"], input[autocomplete="current-password"], input[autocomplete="username"], quick-form[name="loginform"]',
                        { timeout: 18000 }
                    ).catch(() => {});
                } catch {}
                lastSnap = await evalOnPage(page, snapScript);
                logger.info('launchAndLogin: shell yenileme sonrası snapshot', { email, attempt, snap: lastSnap });
            }
        }
    } catch {}

    try { page.removeListener('response', onResp); } catch {}

    const userSel = 'input[autocomplete="username"], input[type="email"], input[type="text"][placeholder*="E-Posta"], input[name*="email"], input[name*="user"], input[id*="user"], input[id*="email"]';
    const passSel = 'input[autocomplete="current-password"], input[type="password"], input[name*="pass"], input[id*="pass"]';

    const findLoginContext = async () => {
        const directUser = await page.$(userSel).catch(() => null);
        const directPass = await page.$(passSel).catch(() => null);
        if (directUser && directPass) return { frame: null, userEl: directUser, passEl: directPass };
        const frames = (() => { try { return page.frames(); } catch { return []; } })();
        for (const fr of frames) {
            if (!fr || fr === page.mainFrame()) continue;
            const u = await fr.$(userSel).catch(() => null);
            const p = await fr.$(passSel).catch(() => null);
            if (u && p) return { frame: fr, userEl: u, passEl: p };
        }
        return null;
    };

    const tryRevealLoginForm = async () => {
        if (await findLoginContext()) return true;
        try {
            await page.evaluate(() => {
                const norm = (s) => (s || '').toString().trim().toLowerCase();
                const btns = document.querySelectorAll('a, button, [role="button"], [role="link"], [onclick], [data-testid], [class*="login" i], [id*="login" i]');
                for (const x of btns) {
                    const t = norm(x.innerText || x.textContent || '');
                    const href = norm(x.getAttribute?.('href') || '');
                    if (
                        t.includes('giriş') ||
                        t.includes('giris') ||
                        t.includes('üye girişi') ||
                        t.includes('uye girisi') ||
                        t === 'giriş yap' ||
                        t === 'giris yap' ||
                        href.includes('/tr/giris') ||
                        href.includes('/giris') ||
                        href.includes('uye-girisi')
                    ) {
                        try { x.click(); return; } catch {}
                    }
                }
            });
            await delay(1800);
        } catch {}
        return !!await findLoginContext();
    };

    const tryEnsureLoginForm = async (timeoutMs = 15000) => {
        const start = Date.now();
        let lastDismiss = 0;
        while (Date.now() - start < timeoutMs) {
            assertLaunchRunNotKilled(loginRunId, 'login_form_poll');
            let ctx = await findLoginContext();
            if (ctx) return ctx;
            const now = Date.now();
            if (now - start > 1200 && now - lastDismiss > 4500) {
                await dismissPassoLoginShellOverlays(page, email, 'login_form_poll');
                lastDismiss = now;
            }
            if (Date.now() - start > 3000) await tryRevealLoginForm();
            await delay(500);
        }
        return null;
    };

    const ensureLoginFormWithReload = async () => {
        for (let attempt = 1; attempt <= 12; attempt++) {
            assertLaunchRunNotKilled(loginRunId, `ensure_reload_${attempt}`);
            const ctx = await tryEnsureLoginForm(24000);
            if (ctx) return ctx;
            logger.warn('launchAndLogin: form hâlâ yok, tekrar giriş URL + yenileme', { email, attempt });
            try {
                await gotoWithRetry(page, `${getCfg().PASSO_LOGIN}${getCfg().PASSO_LOGIN.includes('?') ? '&' : '?'}pb_retry=${Date.now()}`, {
                    retries: 1,
                    waitUntil: attempt % 2 === 0 ? 'networkidle2' : 'domcontentloaded',
                    expectedUrlIncludes: '/giris',
                    timeoutMs: 65000,
                    backoffMs: 400
                });
            } catch {
                try {
                    await page.reload({
                        waitUntil: attempt % 2 === 0 ? 'networkidle2' : 'domcontentloaded',
                        timeout: 65000
                    });
                } catch {}
            }
            await dismissPassoLoginShellOverlays(page, email, `ensure_reload_${attempt}`);
            try {
                await page.waitForSelector(
                    'input[type="password"], input[autocomplete="current-password"], input[autocomplete="username"], quick-form[name="loginform"]',
                    { timeout: 18000 }
                ).catch(() => {});
            } catch {}
            const backoff = 550 * attempt;
            try { await delay(backoff); } catch {}
            await tryRevealLoginForm().catch(() => false);
            const u = (() => { try { return page.url(); } catch { return ''; } })();
            if (!/\/tr\/giris(\?|$)/i.test(String(u || ''))) {
                try {
                    await gotoWithRetry(page, getCfg().PASSO_LOGIN, { retries: 1, waitUntil: 'domcontentloaded', expectedUrlIncludes: '/giris', backoffMs: 350 });
                } catch {}
            }
        }
        return null;
    };

    const fillLoginCredentials = async (_ctx) => {
        // Element handle'ları her zaman tazele — SPA hydration eski handle'ları stale yapabilir
        const freshCtx = await findLoginContext();
        const ctx = freshCtx || _ctx;
        if (!ctx?.userEl || !ctx?.passEl) throw new Error('Login inputları bulunamadı');

        // React controlled input için native setter + event dispatch gerekir
        const reactFill = async (el, value) => {
            try {
                // Önce click + select all ile odaklan
                await el.click({ clickCount: 3 }).catch(() => {});
                await delay(80);
                // Puppeteer type ile yaz (görünür yazma)
                await el.evaluate((node) => { node.value = ''; }).catch(() => {});
                await el.type(String(value), { delay: 35 });
                await delay(80);
                // React state'i için native value setter + input/change event
                await el.evaluate((node, val) => {
                    try {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        if (nativeSetter) nativeSetter.call(node, val);
                    } catch {}
                    node.dispatchEvent(new Event('input',  { bubbles: true }));
                    node.dispatchEvent(new Event('change', { bubbles: true }));
                    node.dispatchEvent(new Event('blur',   { bubbles: true }));
                }, String(value)).catch(() => {});
            } catch (e) {
                logger.warn('launchAndLogin: fillLoginCredentials reactFill hatası', { email, error: e?.message });
                throw e;
            }
        };

        await reactFill(ctx.userEl, email);
        await delay(220);
        await reactFill(ctx.passEl, password);
        await delay(400);

        // Son kontrol: alanlar dolu mu?
        try {
            const vals = await (ctx.frame || page).evaluate((uSel, pSel) => {
                const u = document.querySelector(uSel);
                const p = document.querySelector(pSel);
                return { emailVal: u?.value || '', passLen: (p?.value || '').length };
            }, 'input[autocomplete="username"], input[type="email"]', 'input[type="password"], input[autocomplete="current-password"]');
            logger.info('launchAndLogin: form doldurma kontrolü', { email, emailVal: vals.emailVal, passLen: vals.passLen });
            if (!vals.emailVal || !vals.passLen) {
                logger.warn('launchAndLogin: form boş kaldı, yeniden doldurma', { email });
                await reactFill(ctx.userEl, email);
                await delay(200);
                await reactFill(ctx.passEl, password);
                await delay(300);
            }
        } catch {}
    };

    let loginCtx = await ensureLoginFormWithReload();
    if (!loginCtx) {
        const u = (() => { try { return page.url(); } catch { return ''; } })();
        if (/^chrome-error:\/\//i.test(String(u || ''))) {
            throw new Error('Login sayfasina erisilemedi (chrome_error)');
        }
        if (!/\/giris(\?|$)/i.test(u)) {
            logger.warn('launchAndLogin: login formu bulunamadı, zaten girişli/redirect kabul ediliyor', { email, url: u });
            return { browser, page };
        }
        try {
            const diag = await evalOnPage(page, `
                var allInputs = document.querySelectorAll('input');
                var allForms = document.querySelectorAll('form');
                var inputs = []; var forms = [];
                for (var i = 0; i < Math.min(allInputs.length, 40); i++) {
                    var inp = allInputs[i];
                    inputs.push({ type: inp.getAttribute('type') || '', name: inp.getAttribute('name') || '', id: inp.getAttribute('id') || '' });
                }
                for (i = 0; i < Math.min(allForms.length, 10); i++) {
                    var f = allForms[i];
                    forms.push({ id: f.getAttribute('id') || '', name: f.getAttribute('name') || '', action: f.getAttribute('action') || '' });
                }
                return { inputCount: allInputs.length, inputs, formCount: allForms.length, forms };
            `);
            logger.warn('launchAndLogin: login formu bulunamadı (diagnostic)', { email, url: u, diag });
        } catch {}
        try {
            const finalSnap = await evalOnPage(page, loginSnapScript);
            if (snapshotLooksLikeCloudflareBlock(finalSnap, lastLoginDoc?.status)) {
                throw new Error('Login blocked: Cloudflare veya kenar ağı (403/shell); farklı proxy denenebilir');
            }
        } catch (e) {
            if (String(e?.message || '').includes('Login blocked:')) throw e;
        }
        throw new Error('Login formu bulunamadı');
    }

    await delay(500);
    const turnstileTarget = loginCtx.frame || page;
    await (turnstileTarget.waitForSelector ? turnstileTarget.waitForSelector('.cf-turnstile, input[name="cf-turnstile-response"]', { timeout: 15000 }) : page.waitForSelector('.cf-turnstile, input[name="cf-turnstile-response"]', { timeout: 15000 })).catch(() => {});

    let userEl = loginCtx.userEl;
    let passEl = loginCtx.passEl;
    if (!userEl || !passEl) throw new Error('Login inputları bulunamadı');
    await fillLoginCredentials(loginCtx);

    // Some Passo login pages require an additional "I am human" checkbox.
    // If it's present and unchecked, submit attempts can trigger a generic "Genel hata" modal.
    try {
        const humanRes = await evaluateSafe(loginCtx.frame || page, () => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const candidates = Array.from(document.querySelectorAll('input[type="checkbox"]'))
                .map((cb) => {
                    let txt = '';
                    try {
                        const id = cb.getAttribute('id') || '';
                        if (id) txt = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText || '';
                    } catch {}
                    if (!txt) {
                        try { txt = cb.closest('label')?.innerText || cb.parentElement?.innerText || ''; } catch {}
                    }
                    return { cb, txt: norm(txt) };
                })
                .filter(x => x.cb);

            const target = candidates.find(x => x.txt.includes('gerçek kişi') || x.txt.includes('gercek kisi') || x.txt.includes('doğrulay') || x.txt.includes('dogrula')) || null;
            if (!target || !target.cb) return { attempted: false, found: false };
            if (target.cb.checked) return { attempted: true, found: true, changed: false };
            try { target.cb.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            try { target.cb.click(); } catch {
                try { (target.cb.closest('label') || target.cb.parentElement || target.cb).click(); } catch {}
            }
            return { attempted: true, found: true, changed: true, checked: !!target.cb.checked };
        }).catch(() => null);
        if (humanRes?.attempted && humanRes?.found) {
            logger.info('launchAndLogin: human checkbox', { email, humanRes });
            await delay(350);
        }
    } catch {}

    if (loginCtx.frame) {
        logger.info('launchAndLogin: form iframe içinde, token aynı frame\'e enjekte edilecek', { email });
    }
    await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.warmup', { background: true, targetFrame: loginCtx.frame || undefined });
    let turnstileEnsure = await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.beforeSubmit', { targetFrame: loginCtx.frame || undefined });
    if (turnstileEnsure?.error) {
        logger.warn('launchAndLogin: turnstile blocking ensure failed, recovery başlayacak', { email, error: turnstileEnsure.error });
        try {
            loginCtx = await ensureLoginFormWithReload() || loginCtx;
            userEl = loginCtx?.userEl || userEl;
            passEl = loginCtx?.passEl || passEl;
            if (loginCtx?.userEl && loginCtx?.passEl) {
                await fillLoginCredentials(loginCtx);
            }
        } catch {}
        turnstileEnsure = await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.beforeSubmit.retry', { targetFrame: loginCtx?.frame || undefined });
    }
    // Token injected; avoid long fixed sleeps. We'll rely on the button-enabled wait below.
    await delay(450);

    let evalTarget = loginCtx.frame || page;

    // Wait until the login button becomes enabled after Turnstile is solved.
    // On Passo the "GİRİŞ" button can remain disabled until the widget signals success.
    try {
        await waitForFunctionSafe(evalTarget, () => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const btns = Array.from(document.querySelectorAll('quick-form[name="loginform"] button.black-btn, quick-form button.black-btn, button.black-btn'));
            const btn = btns.find(b => norm(b.innerText || b.textContent || '') === 'giriş' || norm(b.innerText || b.textContent || '').includes('giriş')) || null;
            if (!btn) return false;
            const st = window.getComputedStyle(btn);
            const visible = st && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' && btn.offsetParent !== null;
            if (!visible) return false;
            return !btn.disabled && btn.getAttribute('disabled') === null;
        }, { timeout: 12000, polling: 120 });
        logger.info('launchAndLogin: login button enabled after turnstile', { email });
    } catch {
        // If we can't detect enabled state, continue with existing click fallbacks.
    }

    const dismissObstructions = async (label) => {
        try {
            const res = await evaluateSafe(evalTarget, (lbl) => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const isVisible = (el) => {
                    try {
                        const st = window.getComputedStyle(el);
                        if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                        const r = el.getBoundingClientRect();
                        if (!r || r.width < 2 || r.height < 2) return false;
                        return true;
                    } catch { return false; }
                };

                const roots = Array.from(document.querySelectorAll(
                    '.swal2-container.swal2-shown, .modal.show, [role="dialog"][aria-modal="true"], .cdk-overlay-container, .cookie, .cookie-banner, .cookie-consent, .cookies'
                )).filter(isVisible);

                // Also treat any fixed overlay with a close button as a root.
                const extra = Array.from(document.querySelectorAll('[class*="overlay" i], [class*="popup" i], [class*="modal" i]')).filter(isVisible).slice(0, 4);
                for (const e of extra) if (!roots.includes(e)) roots.push(e);

                if (!roots.length) return { label: lbl, dismissed: false, reason: 'no_root' };

                const want = ['tamam', 'ok', 'kapat', 'iptal', 'vazgeç', 'vazgec', 'no', 'hayır', 'hayir', 'x', '×'];
                let clicked = false;
                let clickedText = null;
                let rootText = '';
                for (const root of roots) {
                    if (!rootText) rootText = norm(root.innerText || root.textContent || '').slice(0, 140);
                    const btns = Array.from(root.querySelectorAll('button, a, [role="button"], .swal2-confirm, .swal2-cancel'));
                    for (const b of btns) {
                        if (!isVisible(b)) continue;
                        const t = norm(b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '');
                        if (!t) continue;
                        if (want.includes(t) || want.some(w => t === w || t.startsWith(w))) {
                            try { b.click(); clicked = true; clickedText = t; break; } catch {}
                        }
                    }
                    if (clicked) break;

                    // Try common close icons
                    const closeEl = root.querySelector('[aria-label*="kapat" i], [aria-label*="close" i], .close, .btn-close, .swal2-close');
                    if (closeEl && isVisible(closeEl)) {
                        try { closeEl.click(); clicked = true; clickedText = 'close_icon'; } catch {}
                    }
                    if (clicked) break;
                }
                return { label: lbl, dismissed: clicked, clickedText, rootText };
            }, label).catch(() => null);

            if (res?.dismissed) {
                logger.info('launchAndLogin: obstruction dismissed', { email, res });
                await delay(500);
                return true;
            }
        } catch {}
        return false;
    };

    await dismissObstructions('before_wait_login_btn');

    const waitForGirisBtn = async (maxMs = 12000) => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            assertLaunchRunNotKilled(loginRunId, 'wait_giris_btn');
            await dismissObstructions('wait_login_btn_loop');
            const found = await evaluateSafe(evalTarget, () => {
                var qf = document.querySelector('quick-form');
                if (qf) {
                    var qbtns = qf.querySelectorAll('button');
                    if (qbtns.length > 0) return true;
                    if (qf.shadowRoot) {
                        var sbtns = qf.shadowRoot.querySelectorAll('button');
                        if (sbtns.length > 0) return true;
                    }
                }
                var btns = document.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                    var t = (btns[i].innerText || btns[i].textContent || '').trim().toUpperCase();
                    if ((t.indexOf('GİRİŞ') >= 0 || t.indexOf('GIRIS') >= 0) && t.indexOf('ÜYE') < 0) return true;
                }
                return false;
            }).catch(() => false);
            if (found) return;
            await delay(500);
        }
    };
    await waitForGirisBtn(7000);
    const tryFormSubmitEarly = async () => {
        await dismissObstructions('before_early_submit');
        const r = await evaluateSafe(evalTarget, () => {
            var passEl = document.querySelector('input[type="password"], input[name*="pass"]');
            if (!passEl) return null;
            var form = passEl.closest('form');
            var qf = passEl.closest('quick-form');
            if (form && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit(); return 'form'; } catch (e) {}
            }
            if (qf) {
                var btn = qf.querySelector('button[type="submit"], button.black-btn');
                if (btn && !btn.disabled) { btn.click(); return 'qf_btn'; }
            }
            return null;
        }).catch(() => null);
        return r;
    };
    const earlySubmit = await tryFormSubmitEarly();
    if (earlySubmit) logger.info('launchAndLogin: erken form submit', { method: earlySubmit });
    const tryClickGirisBtn = () => evaluateSafe(evalTarget, () => {
        var norm = function (s) { return String(s || '').trim().toUpperCase(); };
        var revealAndClick = function (btn) {
            if (!btn) return false;
            var p = btn;
            while (p && p !== document.body) {
                try { p.style.display = ''; p.style.visibility = ''; p.style.opacity = ''; } catch (e) {}
                p = p.parentElement;
            }
            btn.style.display = 'block';
            btn.style.visibility = 'visible';
            btn.style.opacity = '1';
            btn.removeAttribute('disabled');
            btn.disabled = false;
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
        };
        var allBtns = document.querySelectorAll('button, input[type="submit"]');
        for (var b = 0; b < allBtns.length; b++) {
            var btn = allBtns[b];
            var t = norm(btn.innerText || btn.textContent || btn.value || '');
            if ((t.indexOf('GİRİŞ') >= 0 || t.indexOf('GIRIS') >= 0) && t.indexOf('ÜYE') < 0 && t.indexOf('KAYIT') < 0) {
                if (revealAndClick(btn)) return 'giris_btn';
            }
        }
        var blackBtns = document.querySelectorAll('button.black-btn');
        for (b = 0; b < blackBtns.length; b++) {
            var girisBtn = blackBtns[b];
            t = norm(girisBtn.innerText || girisBtn.textContent || '');
            if ((t.indexOf('GİRİŞ') >= 0 || t.indexOf('GIRIS') >= 0) && t.indexOf('ÜYE') < 0 && t.indexOf('KAYIT') < 0) {
                if (revealAndClick(girisBtn)) return 'black_btn';
            }
        }
        var quickForm = document.querySelector('quick-form[name="loginform"], quick-form');
        if (quickForm) {
            var qbtns = quickForm.querySelectorAll('button.black-btn, button');
            for (var q = 0; q < qbtns.length; q++) {
                var qbtn = qbtns[q];
                var qt = norm(qbtn.innerText || qbtn.textContent || '');
                if ((qt.indexOf('GİRİŞ') >= 0 || qt.indexOf('GIRIS') >= 0) && qt.indexOf('ÜYE') < 0 && qt.indexOf('KAYIT') < 0) {
                    if (revealAndClick(qbtn)) return 'quick_form_btn';
                }
            }
            if (quickForm.shadowRoot) {
                var sBtns = quickForm.shadowRoot.querySelectorAll('button');
                for (var sq = 0; sq < sBtns.length; sq++) {
                    var sqbtn = sBtns[sq];
                    var sqt = norm(sqbtn.innerText || sqbtn.textContent || '');
                    if ((sqt.indexOf('GİRİŞ') >= 0 || sqt.indexOf('GIRIS') >= 0) && sqt.indexOf('ÜYE') < 0 && sqt.indexOf('KAYIT') < 0) {
                        sqbtn.style.display = 'block';
                        sqbtn.style.visibility = 'visible';
                        sqbtn.style.opacity = '1';
                        sqbtn.removeAttribute('disabled');
                        sqbtn.disabled = false;
                        sqbtn.click();
                        return 'quick_form_shadow';
                    }
                }
            }
        }
        return null;
    });

    let submitResult = null;
    const tokenLikelyReady = await evaluateSafe(evalTarget, () => {
        const i = document.querySelector('input[name="cf-turnstile-response"]');
        return !!(i && String(i.value || '').length > 40);
    }).catch(() => false);
    if (tokenLikelyReady) {
        await dismissObstructions('token_ready_fast_submit');
        submitResult = await tryFormSubmitEarly();
        if (!submitResult) submitResult = await tryClickGirisBtn();
        if (submitResult) logger.info('launchAndLogin: hizli submit (turnstile token hazir)', { email, method: submitResult });
    }

    const pollStart = Date.now();
    const pollMaxMs = submitResult ? 0 : 5000;
    const pollIntervalMs = 320;
    while (Date.now() - pollStart < pollMaxMs) {
        assertLaunchRunNotKilled(loginRunId, 'submit_poll');
        try {
            await dismissObstructions('before_click_giris');
            submitResult = await tryClickGirisBtn();
            if (submitResult) break;
        } catch (e) {
            logger.warn('launchAndLogin: submit hatası', { error: e?.message });
        }
        await delay(pollIntervalMs);
    }
    if (!submitResult && passEl) {
        try {
            const didSubmit = await passEl.evaluate((el) => {
                var form = el.form || (el.closest && el.closest('form'));
                var quickForm = el.closest && el.closest('quick-form');
                if (form) {
                    try { form.requestSubmit(); return 'form'; } catch (e) {}
                    try { form.submit(); return 'form_submit'; } catch (e) {}
                }
                if (quickForm) {
                    var btns = quickForm.querySelectorAll('button.black-btn, button');
                    for (var bi = 0; bi < btns.length; bi++) {
                        var btn = btns[bi];
                        var t = (btn.innerText || btn.textContent || '').trim().toUpperCase();
                        if ((t.indexOf('GİRİŞ') >= 0 || t.indexOf('GIRIS') >= 0) && t.indexOf('ÜYE') < 0 && t.indexOf('KAYIT') < 0) {
                            btn.removeAttribute('disabled'); btn.disabled = false; btn.click();
                            return 'quick_form';
                        }
                    }
                }
                return false;
            });
            if (didSubmit) submitResult = 'passEl_form';
        } catch {}
    }
    if (!submitResult) {
        try {
            logger.warn('launchAndLogin: submit bulunamadı, login form recovery deneniyor', { email });
            loginCtx = await ensureLoginFormWithReload() || loginCtx;
            userEl = loginCtx?.userEl || userEl;
            passEl = loginCtx?.passEl || passEl;
            evalTarget = loginCtx?.frame || page;
            if (loginCtx?.userEl && loginCtx?.passEl) {
                await fillLoginCredentials(loginCtx);
            }
            await dismissObstructions('before_recover_submit');
            await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.recoverSubmit', { targetFrame: loginCtx?.frame || undefined });
            await delay(800);
            await waitForGirisBtn(10000);
            submitResult = await tryClickGirisBtn();
            if (!submitResult) {
                const retrySubmit = await tryFormSubmitEarly();
                if (retrySubmit) submitResult = `recover_${retrySubmit}`;
            }
            if (!submitResult && passEl) {
                try {
                    await passEl.focus();
                    await page.keyboard.press('Enter');
                    submitResult = 'recover_enter';
                } catch {}
            }
        } catch (e) {
            logger.warn('launchAndLogin: submit recovery failed', { email, error: e?.message || String(e) });
        }
    }
    if (!submitResult) {
        try {
            const diag = await evaluateSafe(evalTarget, () => {
                var btns = document.querySelectorAll('button, input[type="submit"]');
                var texts = []; for (var di = 0; di < Math.min(btns.length, 15); di++) texts.push((btns[di].innerText || btns[di].value || '').trim().substring(0, 30));
                var qf = document.querySelector('quick-form');
                var qfBtns = qf ? qf.querySelectorAll('button') : [];
                var qfTexts = []; for (var qi = 0; qi < qfBtns.length; qi++) qfTexts.push((qfBtns[qi].innerText || '').trim().substring(0, 30));
                return { btnCount: btns.length, btnTexts: texts, quickFormBtns: qfBtns.length, qfBtnTexts: qfTexts };
            });
            logger.warn('launchAndLogin: GİRİŞ butonu bulunamadı (diagnostic)', { email, diag });
        } catch {}
        try {
            await passEl.focus();
            await page.keyboard.press('Enter');
            logger.info('launchAndLogin: Enter tuşu gönderildi (fallback)');
        } catch {}
        if (!submitResult) {
            const cloudflareToken = await evaluateSafe(evalTarget, () => {
                var i = document.querySelector('input[name="cf-turnstile-response"]');
                return (i && i.value) ? i.value : null;
            }).catch(() => null);
            if (cloudflareToken) {
                logger.info('launchAndLogin: tryLoginViaApi fallback deneniyor', { email, tokenLen: cloudflareToken.length });
                const apiOk = await tryLoginViaApi(page, email, password, cloudflareToken, null, evalTarget);
                if (apiOk) submitResult = 'api_fallback';
            } else {
                logger.warn('launchAndLogin: cloudflareToken bulunamadı, API fallback atlanıyor');
            }
        }
    }
    logger.info('launchAndLogin: GİRİŞ submit', { method: submitResult });

    await delay(350);
    const dismissLoginErrorModal = async () => {
        const evalTarget = loginCtx?.frame || page;
        for (let i = 0; i < 5; i++) {
            assertLaunchRunNotKilled(loginRunId, 'dismiss_login_err');
            await delay(350);
            const dismissed = await evaluateSafe(evalTarget, () => {
                var root = document.querySelector('.swal2-container.swal2-shown, .modal.show, [role="dialog"][aria-modal="true"]');
                if (!root) return false;
                var text = (root.innerText || root.textContent || '').toLowerCase();
                if (text.indexOf('genel hata') < 0 && text.indexOf('hata') < 0 && text.indexOf('error') < 0) return false;
                var btns = root.querySelectorAll('button, a, [role="button"], .swal2-confirm');
                for (var j = 0; j < btns.length; j++) {
                    var t = (btns[j].innerText || btns[j].textContent || '').trim().toLowerCase();
                    if (t === 'tamam' || t === 'ok' || t === 'kapat') {
                        try { btns[j].click(); return true; } catch (e) {}
                    }
                }
                return false;
            }).catch(() => false);
            if (dismissed) {
                logger.info('launchAndLogin: Genel hata modalı kapatıldı', { email });
                return true;
            }
        }
        return false;
    };
    // domcontentloaded: 'load' çok geç tetikleniyor; URL değişimi genelde daha hızlı yakalanır
    const postSubmitRaceMs = 16000;
    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: postSubmitRaceMs }).catch(() => {}),
        page.waitForFunction(() => !/\/giris(\?|$)/i.test(location.href || ''), { timeout: postSubmitRaceMs, polling: 80 }).catch(() => {}),
        delay(postSubmitRaceMs)
    ]);
    await Promise.race([
        dismissLoginErrorModal().catch(() => {}),
        delay(1000)
    ]);
    await delay(Math.min(450, Number(getCfg().DELAYS.AFTER_LOGIN) || 450));

    try {
        const postLogin = await evalOnPage(page, `
            var bodyText = (document.body && document.body.innerText) ? String(document.body.innerText).toLowerCase() : '';
            var hasVerifyHuman = bodyText.indexOf('verify you are human') >= 0;
            var hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
            var hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
            var title = document.title || '';
            var url = location.href || '';
            var nodes = document.querySelectorAll('.error, .alert, .toast, .swal2-html-container, .validation, .invalid-feedback');
            var possibleErrors = [];
            var i;
            for (i = 0; i < nodes.length && i < 5; i += 1) {
                var txt = String(nodes[i].innerText || nodes[i].textContent || '').trim();
                if (txt) possibleErrors.push(txt);
            }
            return {
                title: title,
                url: url,
                hasVerifyHuman: hasVerifyHuman,
                hasTurnstileWidget: hasTurnstileWidget,
                hasTurnstileTokenField: hasTurnstileTokenField,
                possibleErrors: possibleErrors
            };
        `);
        logger.info('launchAndLogin: login sonrası snapshot', { email, snap: postLogin });
    } catch {}

    let finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
    const hasPassoSessionHints = async () => evaluateSafe(page, () => {
        const b = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
        if (b.includes('çıkış') || b.includes('cikis') || b.includes('hesabım') || b.includes('hesabim')) return true;
        return !!document.querySelector('a[href*="cikis" i], a[href*="logout" i], a[href*="/hesabim" i]');
    }).catch(() => false);

    if (/\/giris(\?|$)/i.test(finalUrl) && (await hasPassoSessionHints())) {
        logger.info('launchAndLogin: giris URL ama oturum icerigi var, basarili', { email, finalUrl });
        await delay(Math.min(500, Number(getCfg().DELAYS.AFTER_LOGIN) || 500));
        return { browser, page };
    }

    if (/\/giris(\?|$)/i.test(finalUrl) && submitResult) {
        await delay(900);
        const modalDismissed = await evaluateSafe(evalTarget, () => {
            var root = document.querySelector('.swal2-container.swal2-shown, .modal.show');
            if (!root) return false;
            var btns = root.querySelectorAll('button');
            for (var j = 0; j < btns.length; j++) {
                var t = (btns[j].innerText || btns[j].textContent || '').trim().toLowerCase();
                if (t === 'tamam' || t === 'ok') { try { btns[j].click(); return true; } catch (e) {} }
            }
            return false;
        }).catch(() => false);
        if (modalDismissed) {
            await delay(2000);
            logger.info('launchAndLogin: Genel hata sonrası yeniden deneme', { email });
            await evaluateSafe(evalTarget, () => {
                var i = document.querySelector('input[name="cf-turnstile-response"]');
                if (i) i.value = '';
            }).catch(() => {});
            await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.retry', { targetFrame: loginCtx?.frame || undefined });
            await delay(1500);
            const retrySubmit = await tryFormSubmitEarly();
            if (retrySubmit) {
                await Promise.race([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 14000 }).catch(() => {}),
                    page.waitForFunction(() => !/\/giris(\?|$)/i.test(location.href || ''), { timeout: 14000, polling: 80 }).catch(() => {}),
                    delay(14000)
                ]);
                await delay(Math.min(600, Number(getCfg().DELAYS.AFTER_LOGIN) || 600));
            }
            finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
        }
    }
    if (/\/giris(\?|$)/i.test(finalUrl) && submitResult) {
        if (await hasPassoSessionHints()) {
            logger.info('launchAndLogin: final recovery atlandi (oturum isareti mevcut)', { email, finalUrl });
            return { browser, page };
        }
        logger.warn('launchAndLogin: hala login sayfasında, final recovery deneniyor', { email, submitResult, finalUrl });
        try {
            loginCtx = await ensureLoginFormWithReload() || loginCtx;
            userEl = loginCtx?.userEl || userEl;
            passEl = loginCtx?.passEl || passEl;
            evalTarget = loginCtx?.frame || page;
            if (loginCtx?.userEl && loginCtx?.passEl) {
                await fillLoginCredentials(loginCtx);
            }
            await ensureTurnstileTokenOnPage(page, email, 'launchAndLogin.finalRecovery', { targetFrame: loginCtx?.frame || undefined });
            await delay(1000);
            const finalRecoverySubmit = await tryClickGirisBtn();
            if (!finalRecoverySubmit) {
                const retrySubmit = await tryFormSubmitEarly();
                if (retrySubmit) {
                    logger.info('launchAndLogin: final recovery submit', { email, method: retrySubmit });
                }
            }
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 14000 }).catch(() => {}),
                page.waitForFunction(() => !/\/giris(\?|$)/i.test(location.href || ''), { timeout: 14000, polling: 80 }).catch(() => {}),
                delay(14000)
            ]);
            await delay(Math.min(600, Number(getCfg().DELAYS.AFTER_LOGIN) || 600));
            finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
        } catch (e) {
            logger.warn('launchAndLogin: final recovery failed', { email, error: e?.message || String(e) });
        }
    }
    if (/\/giris(\?|$)/i.test(finalUrl)) {
        throw new Error('Giriş başarısız: sayfa değişmedi, hâlâ giriş sayfasında.');
    }

    return {browser, page};
    } catch (loginFlowErr) {
        const rid = runStore.safeRunId(loginRunId);
        if (rid) {
            const st = runStore.get(rid);
            if (st && st.status === 'killed') {
                const k = new Error('RUN_KILLED:post_kill_abort');
                k.code = 'RUN_KILLED';
                k.cause = loginFlowErr;
                await disposeBrowserAfterFailedLogin(browser, email, k);
                throw k;
            }
        }
        await disposeBrowserAfterFailedLogin(browser, email, loginFlowErr);
        throw loginFlowErr;
    }
}

async function reloginIfRedirected(page, email, password) {
    if (!page) return false;

    const currentUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    if (!/\/giris(\?|$)/i.test(currentUrl)) return false;

    let returnUrl = null;
    try {
        const u = new URL(currentUrl);
        returnUrl = u.searchParams.get('returnUrl');
        if (returnUrl) {
            try { returnUrl = decodeURIComponent(returnUrl); } catch {}
            if (!/^https?:\/\//i.test(returnUrl)) {
                returnUrl = `https://www.passo.com.tr${returnUrl.startsWith('/') ? '' : '/'}${returnUrl}`;
            }
        }
    } catch {
    }

    logger.warn('reloginIfRedirected: login redirect tespit edildi, yeniden login denenecek', {
        email,
        currentUrl,
        returnUrl
    });

    const userSel = 'input[autocomplete="username"], input[type="email"], input[name*="email"], input[name*="user"], input[id*="email"]';
    const passSel = 'input[autocomplete="current-password"], input[type="password"], input[name*="pass"]';
    let userEl = await page.$(userSel).catch(() => null);
    let passEl = await page.$(passSel).catch(() => null);
    if (!userEl || !passEl) {
        const frames = page.frames();
        for (const fr of frames) {
            if (fr === page.mainFrame()) continue;
            userEl = await fr.$(userSel).catch(() => null);
            passEl = await fr.$(passSel).catch(() => null);
            if (userEl && passEl) break;
        }
    }
    if (userEl && passEl) {
        try {
            await userEl.click({ clickCount: 3 });
            await userEl.type(String(email || ''), { delay: 20 });
            await passEl.click({ clickCount: 3 });
            await passEl.type(String(password || ''), { delay: 20 });
        } catch (e) {
            logger.warn('reloginIfRedirected: element type failed, fallback to page.type', { error: e?.message });
            await page.type(userSel, String(email || ''), { delay: 20 }).catch(() => {});
            await page.type(passSel, String(password || ''), { delay: 20 }).catch(() => {});
        }
    } else {
        await page.type(userSel, String(email || ''), { delay: 20 }).catch(() => {});
        await page.type(passSel, String(password || ''), { delay: 20 }).catch(() => {});
    }

    await delay(500);
    await ensureTurnstileTokenOnPage(page, email, 'reloginIfRedirected.warmup', { background: true });
    await ensureTurnstileTokenOnPage(page, email, 'reloginIfRedirected.beforeSubmit');
    await delay(300);

    try {
        const submitted = await evaluateSafe(page, () => {
            const forms = document.querySelectorAll('form');
            for (const form of forms) {
                const hasTurnstile = form.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]');
                const hasEmail = form.querySelector('input[type="email"], input[name*="email"], input[autocomplete="username"]');
                if (hasTurnstile || hasEmail) {
                    const btn = [...form.querySelectorAll('button, input[type="submit"]')].find(x => (x.innerText || x.value || '').trim().toUpperCase().includes('GİRİŞ'));
                    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return 'form_btn'; }
                    try { form.requestSubmit(); return 'requestSubmit'; } catch {}
                    try { form.submit(); return 'submit'; } catch {}
                }
            }
            const any = [...document.querySelectorAll('button.black-btn, button, input[type="submit"]')].find(x => (x.innerText || x.value || '').trim().toLowerCase().includes('giriş'));
            if (any) { any.scrollIntoView({ block: 'center' }); any.click(); return 'fallback'; }
            return null;
        });
        logger.debug('reloginIfRedirected: form submit', { method: submitted });
    } catch (e) {
        logger.warn('reloginIfRedirected: submit hatası', { error: e?.message });
    }

    try { await delay(350); } catch {}

    const preUrl = currentUrl;
    const navRes = await Promise.race([
        page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).then(() => ({ type: 'nav_ok' })).catch((e) => ({ type: 'nav_error', message: e?.message || String(e) })),
        page.waitForFunction(() => !/\/giris(\?|$)/i.test(location.href || ''), { timeout: 45000 }).then(() => ({ type: 'url_changed' })).catch(() => null),
        delay(45000).then(() => ({ type: 'timeout' }))
    ]).then((r) => r || { type: 'timeout' });

    // Re-check URL after navigation settles (even if timeout)
    await delay(500);
    const afterUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    logger.info('reloginIfRedirected: login submit sonrası', {
        email,
        navRes,
        afterUrl
    });

    // Check for login error messages on the page
    const loginError = await evaluateSafe(page, () => {
        const errorSelectors = [
            '.alert-danger', '.error-message', '.field-validation-error',
            '[class*="error"]', '[class*="hata"]',
            '.swal2-title', '.swal2-html-container',
            '.toast-message', '.notification-error'
        ];
        for (const sel of errorSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent) {
                return { selector: sel, text: el.textContent.trim() };
            }
        }
        // Check for specific error texts (şifre tek başına form etiketi olabilir, sadece hata bağlamında kontrol et)
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const errorPhrases = ['hatalı', 'yanlış', 'geçersiz', 'bulunamadı', 'kilit', 'bloke', 'ban', 'şifre hatalı', 'yanlış şifre', 'geçersiz şifre', 'e-posta hatalı', 'hesap bulunamadı'];
        for (const phrase of errorPhrases) {
            if (bodyText.includes(phrase)) {
                return { keyword: phrase, text: (document.body?.innerText || '').substring(0, 200) };
            }
        }
        return null;
    }).catch(() => null);

    if (loginError) {
        logger.error('reloginIfRedirected: login hatası tespit edildi', { email, loginError });
    }

    // Check if we ended up on home page (login failed)
    const isHomePage = afterUrl === 'https://www.passo.com.tr/' || afterUrl === 'https://www.passo.com.tr' || afterUrl?.endsWith('passo.com.tr/');
    if (isHomePage) {
        logger.error('reloginIfRedirected: login başarısız, ana sayfaya yönlendirildi', { email, afterUrl, loginError, navRes });
        // Don't proceed with returnUrl navigation if login failed
        return false;
    }

    // Force navigation to returnUrl (if any) to re-enter the flow.
    if (returnUrl) {
        logger.info('reloginIfRedirected: returnUrl sayfasına dönülüyor', { email, returnUrl });
        const tryReturnUrl = async (waitUntil) => {
            await gotoWithRetry(page, returnUrl, {
                retries: 2,
                waitUntil,
                expectedUrlIncludes: '/koltuk-secim',
                rejectIfHome: false,
                backoffMs: 500
            }).catch(() => {});
            await delay(600);
            return (() => {
                try {
                    return page.url();
                } catch {
                    return '';
                }
            })();
        };

        let finalUrl = await tryReturnUrl('domcontentloaded');
        const isBad =
            finalUrl === 'https://www.passo.com.tr/' ||
            finalUrl === 'https://www.passo.com.tr' ||
            (finalUrl?.endsWith('passo.com.tr/') && !finalUrl.includes('/koltuk-secim')) ||
            !String(finalUrl || '').includes('/koltuk-secim');
        if (isBad) {
            logger.warn('reloginIfRedirected: returnUrl ilk deneme yetersiz, networkidle2 ile tekrar', { email, finalUrl });
            finalUrl = await tryReturnUrl('networkidle2');
        }

        const isStillHomePage =
            finalUrl === 'https://www.passo.com.tr/' ||
            finalUrl === 'https://www.passo.com.tr' ||
            (finalUrl?.endsWith('passo.com.tr/') && !String(finalUrl || '').includes('/koltuk-secim'));
        if (isStillHomePage || !String(finalUrl || '').includes('/koltuk-secim')) {
            logger.error('reloginIfRedirected: returnUrl sonrası koltuk sayfasına ulaşılamadı', {
                email,
                finalUrl,
                originalAfterUrl: afterUrl
            });
            return false;
        }
    }

    const afterReturnUrl = (() => {
        try { return page.url(); } catch { return ''; }
    })();

    if (/\/giris(\?|$)/i.test(afterReturnUrl)) {
        logger.warn('reloginIfRedirected: yeniden login sonrası hala giris sayfasında', {
            email,
            afterUrl: afterReturnUrl
        });
        return true;
    }

    return true;
}

async function clickBuy(page, eventAddress = null) {
    const retries = Number.isFinite(getCfg().TIMEOUTS.CLICK_BUY_RETRIES) ? getCfg().TIMEOUTS.CLICK_BUY_RETRIES : 12;
    const readyWaitMs = Number.isFinite(getCfg().TIMEOUTS.CLICK_BUY_READY_WAIT_MS) ? getCfg().TIMEOUTS.CLICK_BUY_READY_WAIT_MS : 12000;

    const buyReady = await page.waitForFunction(() => {
        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
        const strip = (s) => {
            try {
                return String(s || '').normalize('NFD').replace(/\p{Diacritic}+/gu, '');
            } catch {
                return String(s || '');
            }
        };
        const norm2 = (s) => norm(strip(s));
        const isVisible = (el) => {
            try {
                if (!el) return false;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                const r = el.getBoundingClientRect();
                return !!(r && r.width > 1 && r.height > 1);
            } catch {
                return false;
            }
        };
        const looksLikeBuyText = (txt) => {
            const t = norm2(txt);
            if (!t) return false;
            if ((t.includes('satin') && t.includes('al')) || t === 'satin al') return true;
            if (t.includes('bilet') && (t.includes('al') || t.includes('sat'))) return true;
            if (t.includes('hemen') && t.includes('al')) return true;
            return false;
        };

        if (!['interactive', 'complete'].includes(String(document.readyState || '').toLowerCase())) return false;

        const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
        return candidates.some((el) => {
            if (!isVisible(el) || el.disabled) return false;
            const txt = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '';
            return looksLikeBuyText(txt);
        });
    }, { timeout: readyWaitMs }).then(() => true).catch(() => false);

    if (!buyReady) {
        let diag = null;
        try {
            diag = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
                return {
                    readyState: document.readyState,
                    title: document.title || '',
                    buttonCount: buttons.length,
                    bodyHtmlLen: document.body?.innerHTML?.length || 0,
                    url: location.href
                };
            });
        } catch {}
        logger.warn('clickBuy: sayfa hazır olmadan tiklama engellendi, hazirlik timeout', {
            readyWaitMs,
            currentUrl: (() => { try { return page.url(); } catch { return null; } })(),
            diag
        });
    }

    for (let i = 0; i < retries; i++) {
        const found = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const strip = (s) => {
                try {
                    return String(s || '').normalize('NFD').replace(/\p{Diacritic}+/gu, '');
                } catch {
                    return String(s || '');
                }
            };
            const norm2 = (s) => norm(strip(s));

            const isVisible = (el) => {
                try {
                    const st = window.getComputedStyle(el);
                    if (!el) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    if (!r || r.width <= 1 || r.height <= 1) return false;
                    return true;
                } catch {
                    return false;
                }
            };

            try {
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (swal) {
                    const btn = swal.querySelector('button.swal2-confirm, button.swal2-cancel, button');
                    try { btn?.click(); } catch {}
                }
                const cookieBtn = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .find(b => {
                        const t = norm2(b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '');
                        return t.includes('kabul') || t.includes('accept') || t.includes('onay') || t.includes('tamam') || t.includes('anlad');
                    });
                try { cookieBtn?.click(); } catch {}
            } catch {}

            const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'))
                .filter(el => isVisible(el) && !el.disabled);

            const looksLikeBuyText = (txt) => {
                const t = norm2(txt);
                if (!t) return false;
                if ((t.includes('satin') && t.includes('al')) || t === 'satin al') return true;
                if (t.includes('bilet') && (t.includes('al') || t.includes('sat'))) return true;
                if (t.includes('hemen') && t.includes('al')) return true;
                return false;
            };

            const pick = candidates.find(el => {
                const txt = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '';
                if (!looksLikeBuyText(txt)) return false;
                const cls = norm2(el.className || '');
                const looksLikeBuy = cls.includes('red-btn') || cls.includes('buy') || cls.includes('satin') || cls.includes('ticket');
                return looksLikeBuy || norm2(txt).length <= 30;
            }) || null;

            if (!pick) return { ok: false };
            try { pick.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            let rect = null;
            try { rect = pick.getBoundingClientRect(); } catch {}
            try { pick.click(); } catch {}
            if (!rect) return { ok: true };
            return {
                ok: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };
        }).catch(() => ({ ok: false }));

        if (found && found.ok && Number.isFinite(found.x) && Number.isFinite(found.y)) {
            try {
                await page.mouse.move(found.x, found.y);
                await page.mouse.down();
                await page.mouse.up();
                return true;
            } catch {}
        }

        if (found && found.ok) return true;
        await delay(getCfg().TIMEOUTS.CLICK_BUY_DELAY);
    }
    
    // FALLBACK: If button not found/clickable, navigate directly to /koltuk-secim
    if (eventAddress && String(eventAddress).includes('/etkinlik/')) {
        try {
            // Check if URL already ends with /koltuk-secim
            let seatSelectionUrl = String(eventAddress).replace(/\/+$/, '');
            if (!seatSelectionUrl.endsWith('/koltuk-secim')) {
                seatSelectionUrl = seatSelectionUrl + '/koltuk-secim';
            }
            logger.info('clickBuy_fallback_navigating', { 
                reason: 'button_not_found', 
                fallbackUrl: seatSelectionUrl 
            });
            await gotoWithRetry(page, seatSelectionUrl, {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/koltuk-secim',
                rejectIfHome: false,
                backoffMs: 450
            });
            // Verify we actually reached seat selection
            let currentUrl = '';
            try { currentUrl = page.url(); } catch {}
            if (String(currentUrl).includes('/koltuk-secim')) {
                logger.info('clickBuy_fallback_success', { url: currentUrl });
                return true;
            }
        } catch (e) {
            logger.warn('clickBuy_fallback_failed', { error: e?.message || String(e) });
        }
    }
    
    return false;
}

/** Passo öncelik modalındaki tek divan satırı (panel seçimi ile aynı metin). */
const DIVAN_PRIORITY_SALE_TITLE = 'Yüksek Divan Kurulu, Kongre ve Temsilci Üyeler';

function normKeyPrioritySaleTitle(s) {
    const norm2 = (x) => (x || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
    return norm2(s)
        .replace(/[ıİ]/g, 'i')
        .replace(/[şŞ]/g, 's')
        .replace(/[ğĞ]/g, 'g')
        .replace(/[üÜ]/g, 'u')
        .replace(/[öÖ]/g, 'o')
        .replace(/[çÇ]/g, 'c')
        .replace(/[^a-z0-9]+/g, '');
}

function isDivanPrioritySaleCategory(desired) {
    const a = normKeyPrioritySaleTitle(DIVAN_PRIORITY_SALE_TITLE);
    const b = normKeyPrioritySaleTitle(desired);
    if (!b) return false;
    return a === b || a.includes(b) || b.includes(a);
}

const GS_PLUS_PREMIUM_PRIORITY_TITLE = 'GS PLUS Premium';
const KARA_KARTAL_PLUS_PRIORITY_TITLE = 'Kara Kartal+ Öncelikli Bilet Alım';
const GSPARA_PRIORITY_TITLE = 'GSPara Öncelik';

function isGsPlusPremiumPriorityCategory(desired) {
    const b = normKeyPrioritySaleTitle(desired);
    if (!b) return false;
    const a1 = normKeyPrioritySaleTitle(GS_PLUS_PREMIUM_PRIORITY_TITLE);
    const a2 = normKeyPrioritySaleTitle(KARA_KARTAL_PLUS_PRIORITY_TITLE);
    return (
        a1 === b || a1.includes(b) || b.includes(a1) ||
        a2 === b || a2.includes(b) || b.includes(a2)
    );
}

function isGsParaPriorityCategory(desired) {
    const a = normKeyPrioritySaleTitle(GSPARA_PRIORITY_TITLE);
    const b = normKeyPrioritySaleTitle(desired);
    if (!b) return false;
    return a === b || a.includes(b) || b.includes(a);
}

/**
 * Divan öncelik modalı: label "Sicil No:" / "Öncelikli Bilet Kodu:" (docs/fenerbahçe divan.md).
 * Yalnızca isDivanPrioritySaleCategory true iken çağrılmalı.
 */
async function fillDivanPrioritySaleModalFields(page, sicilVal, priorityCodeVal) {
    const sicil = String(sicilVal || '').trim();
    const prio = String(priorityCodeVal || '').trim();
    if (!sicil || !prio) return false;
    try {
        return await page.evaluate((sicilStr, prioStr) => {
            const isVisible = (el) => {
                if (!el) return false;
                const st = window.getComputedStyle(el);
                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                const r = el.getBoundingClientRect?.();
                if (!r) return true;
                return r.width > 4 && r.height > 4;
            };

            const pickRoot = () => {
                const byClass = document.querySelector('.modal.priority-sale-modal.show')
                    || document.querySelector('.modal.show.priority-sale-modal');
                if (byClass && isVisible(byClass)) return byClass;
                const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                return shown.find((m) => m.classList.contains('priority-sale-modal') || !!m.querySelector('.priority-sale-select-item')) || shown[0] || null;
            };

            const root = pickRoot();
            if (!root) return false;

            const setNativeValue = (input, v) => {
                try {
                    const proto = window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) desc.set.call(input, String(v || ''));
                    else input.value = String(v || '');
                } catch {
                    try { input.value = String(v || ''); } catch {}
                }
                try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                try { input.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
            };

            const labels = Array.from(root.querySelectorAll('label'));
            const inputByLabel = (needles) => {
                const n = needles.map((x) => String(x).toLowerCase());
                for (const lbl of labels) {
                    const t = String(lbl.innerText || lbl.textContent || '').toLowerCase().replace(/\s+/g, ' ');
                    if (!n.every((needle) => t.includes(needle))) continue;
                    const fg = lbl.closest('.form-group') || lbl.parentElement;
                    const inp = fg?.querySelector('input:not([type="hidden"])');
                    if (inp && isVisible(inp)) return inp;
                }
                return null;
            };

            let sicilInp = inputByLabel(['sicil']);
            let prioInp = inputByLabel(['öncelik', 'bilet']) || inputByLabel(['oncelik', 'bilet']) || inputByLabel(['bilet', 'kod']);

            if (!sicilInp || !prioInp) {
                const inputs = Array.from(root.querySelectorAll('input.form-control, input[type="text"]')).filter(isVisible);
                for (const inp of inputs) {
                    const ph = String(inp.getAttribute('placeholder') || '').toLowerCase();
                    if (!sicilInp && ph.includes('sicil')) sicilInp = inp;
                    if (!prioInp && (ph.includes('öncelik') || ph.includes('oncelik') || ph.includes('oncelikli'))) prioInp = inp;
                }
            }

            if (!sicilInp || !prioInp || sicilInp === prioInp) return false;

            setNativeValue(sicilInp, sicilStr);
            setNativeValue(prioInp, prioStr);
            return true;
        }, sicil, prio);
    } catch {
        return false;
    }
}

/**
 * GS PLUS Premium öncelik modalı: telefon alanı (label / placeholder / type=tel).
 * Yalnızca isGsPlusPremiumPriorityCategory true iken çağrılmalı.
 */
async function fillGsPlusPremiumModalFields(page, phoneVal) {
    const raw = String(phoneVal || '').trim();
    if (!raw) return false;
    try {
        return await page.evaluate((phoneStr) => {
            const isVisible = (el) => {
                if (!el) return false;
                const st = window.getComputedStyle(el);
                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                const r = el.getBoundingClientRect?.();
                if (!r) return true;
                return r.width > 4 && r.height > 4;
            };

            const pickRoot = () => {
                const byClass = document.querySelector('.modal.priority-sale-modal.show')
                    || document.querySelector('.modal.show.priority-sale-modal');
                if (byClass && isVisible(byClass)) return byClass;
                const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                return shown.find((m) => m.classList.contains('priority-sale-modal') || !!m.querySelector('.priority-sale-select-item')) || shown[0] || null;
            };

            const root = pickRoot();
            if (!root) return false;

            const setNativeValue = (input, v) => {
                try {
                    const proto = window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) desc.set.call(input, String(v || ''));
                    else input.value = String(v || '');
                } catch {
                    try { input.value = String(v || ''); } catch {}
                }
                try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                try { input.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
            };

            const labels = Array.from(root.querySelectorAll('label'));
            const inputByLabel = (needles) => {
                const n = needles.map((x) => String(x).toLowerCase());
                for (const lbl of labels) {
                    const t = String(lbl.innerText || lbl.textContent || '').toLowerCase().replace(/\s+/g, ' ');
                    if (!n.every((needle) => t.includes(needle))) continue;
                    const fg = lbl.closest('.form-group') || lbl.parentElement;
                    const inp = fg?.querySelector('input:not([type="hidden"])');
                    if (inp && isVisible(inp)) return inp;
                }
                return null;
            };

            let phoneInp = inputByLabel(['telefon'])
                || inputByLabel(['gsm'])
                || inputByLabel(['cep'])
                || inputByLabel(['phone'])
                || inputByLabel(['mobile'])
                || inputByLabel(['iletisim']);

            if (!phoneInp) {
                const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"])')).filter(isVisible);
                phoneInp = inputs.find((i) => String(i.getAttribute('type') || '').toLowerCase() === 'tel')
                    || inputs.find((i) => {
                        const ph = String(i.getAttribute('placeholder') || '').toLowerCase();
                        const al = String(i.getAttribute('aria-label') || '').toLowerCase();
                        const blob = `${ph} ${al}`;
                        return blob.includes('telefon') || blob.includes('gsm') || blob.includes('cep') || blob.includes('phone');
                    })
                    || null;
            }

            if (!phoneInp) return false;

            setNativeValue(phoneInp, phoneStr);
            return true;
        }, raw);
    } catch {
        return false;
    }
}

async function handlePrioritySaleModal(page, opts = null) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const prioritySale = o.prioritySale;
    const fanCardCode = o.fanCardCode;
    let identity = o.identity;
    const sicilNo = o.sicilNo;
    const priorityTicketCode = o.priorityTicketCode;
    const priorityPhone = o.priorityPhone;
    const priorityTckn = o.priorityTckn;

    const desired = (typeof prioritySale === 'string' ? String(prioritySale).trim() : '');
    const shouldTry = prioritySale === true || desired.length > 0;
    if (!shouldTry) return false;

    if (isGsParaPriorityCategory(desired)) {
        const merged = String(identity || '').trim() || String(priorityTckn || '').trim();
        identity = merged || null;
    }

    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();

    const isOpen = async () => {
        try {
            return await page.evaluate(() => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (!st) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };

                const desired = (() => {
                    try { return String(window.__passobotPrioritySaleDesired || '').toLowerCase(); } catch { return ''; }
                })();

                const candidates = [];
                const bs = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                for (const m of bs) candidates.push(m);
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (isVisible(swal)) candidates.push(swal);
                const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                for (const d of roleDlg) candidates.push(d);

                for (const root of candidates) {
                    const txt = (root.innerText || '').toLowerCase();
                    const hasPriorityItems = !!root.querySelector('.priority-sale-select-item');
                    const hasPriorityHints = txt.includes('üyelik') || txt.includes('uyelik') || txt.includes('kampanya') || txt.includes('öncelik') || txt.includes('oncelik');
                    const matchesDesired = desired ? txt.includes(desired) : false;
                    // Treat as open only if it's actually the priority-sale selection dialog.
                    if (hasPriorityItems) return true;
                    if ((hasPriorityHints || matchesDesired) && /\b(devam|g[oö]nder|onayla)\b/i.test(txt)) return true;
                }

                return false;
            });
        } catch {
            return false;
        }
    };

    const waitForModal = async (maxMs = 8000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < maxMs) {
            if (await isOpen()) return true;
            try { await delay(250); } catch {}
        }
        return false;
    };

    const trySelect = async () => {
        try {
            return await page.evaluate((want) => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const normKey = (s) => {
                    const t = norm2(s)
                        .replace(/[ıİ]/g, 'i')
                        .replace(/[şŞ]/g, 's')
                        .replace(/[ğĞ]/g, 'g')
                        .replace(/[üÜ]/g, 'u')
                        .replace(/[öÖ]/g, 'o')
                        .replace(/[çÇ]/g, 'c');
                    return t.replace(/[^a-z0-9]+/g, '');
                };
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (!st) return false;
                    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };

                const pickDialogRoot = () => {
                    // Prefer the modal that actually contains priority sale items
                    const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                    const withItems = shown.find(m => !!m.querySelector('.priority-sale-select-item'));
                    if (withItems) return withItems;
                    const swal = document.querySelector('.swal2-container.swal2-shown');
                    if (isVisible(swal) && swal.querySelector('.priority-sale-select-item')) return swal;
                    const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                    const roleWithItems = roleDlg.find(d => !!d.querySelector('.priority-sale-select-item'));
                    if (roleWithItems) return roleWithItems;
                    // Fallback to any visible dialog (last resort)
                    return shown[0] || (isVisible(swal) ? swal : null) || roleDlg[0] || null;
                };

                const root = pickDialogRoot();
                if (!root) return { ok: false };

                const items = Array.from(root.querySelectorAll('.priority-sale-select-item'));
                if (!items.length) return { ok: false, reason: 'no_items' };

                const options = items.map(it => {
                    const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                    return String(txt || '').trim();
                }).filter(Boolean);

                let target = null;
                const wantText = (want && norm2(want)) ? String(want) : '';
                const wantNorm = wantText ? norm2(wantText) : '';
                const wantK = wantText ? normKey(wantText) : '';
                if (wantText && wantK) {
                    // Strict match: prefer normalized equality, then key-includes.
                    target = items.find(it => {
                        const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                        return normKey(txt) === wantK;
                    }) || items.find(it => {
                        const txt = it.querySelector('.priority-sale-select-item-title')?.innerText || it.innerText || '';
                        const k = normKey(txt);
                        return k.includes(wantK) || wantK.includes(k) || norm2(txt).includes(wantNorm);
                    }) || null;
                    if (!target) {
                        return { ok: false, reason: 'desired_not_found', want: wantText, options };
                    }
                } else {
                    // boolean/on: select first available
                    target = items[0];
                }
                try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                try { target.click(); } catch {}

                const pickInput = () => {
                    const all = Array.from(root.querySelectorAll('input, textarea')).filter(Boolean);
                    const vis = all.filter(i => {
                        try {
                            const st = window.getComputedStyle(i);
                            if (!st) return true;
                            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0) return false;
                            const r = i.getBoundingClientRect?.();
                            if (!r) return true;
                            return (r.width > 4 && r.height > 4);
                        } catch {
                            return true;
                        }
                    });
                    const preferred = vis.find(i => {
                        const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''}`.toLowerCase();
                        return key.includes('tc') || key.includes('kimlik') || key.includes('identity') || key.includes('tckn');
                    });
                    return preferred || vis[0] || null;
                };

                const input = pickInput();
                const placeholder = input?.getAttribute('placeholder') || '';
                const name = input?.getAttribute('name') || '';
                const id = input?.getAttribute('id') || '';
                const labelText = (() => {
                    try {
                        if (!input) return '';
                        const lbl = (id && root.querySelector(`label[for="${CSS.escape(id)}"]`)) || input.closest('label');
                        return (lbl?.innerText || '').trim();
                    } catch {
                        return '';
                    }
                })();

                return {
                    ok: true,
                    hasInput: !!input,
                    placeholder,
                    name,
                    id,
                    labelText,
                    selectedTitle: target.querySelector('.priority-sale-select-item-title')?.innerText || '',
                    options
                };
            }, desired);
        } catch {
            return { ok: false };
        }
    };

    const fillInputIfNeeded = async (selInfo) => {
        const placeholder = String(selInfo?.placeholder || '');
        const labelText = String(selInfo?.labelText || '');
        const name = String(selInfo?.name || '');
        const id = String(selInfo?.id || '');

        const hint = norm(`${placeholder} ${labelText} ${name} ${id}`);
        let value = '';
        if (hint.includes('telefon') || hint.includes('gsm') || hint.includes('cep') || hint.includes('phone') || hint.includes('mobile') || (hint.includes('tel') && !hint.includes('kart'))) {
            value = String(priorityPhone || '').trim();
        } else if (hint.includes('t.c') || hint.includes('tc') || hint.includes('tckn') || hint.includes('kimlik')) value = String(identity || '').trim();
        else if (hint.includes('sicil') || hint.includes('kayıt') || hint.includes('kayit')) value = String(sicilNo || '').trim();
        else if ((hint.includes('öncelik') || hint.includes('oncelik')) && (hint.includes('bilet') || hint.includes('kod'))) value = String(priorityTicketCode || '').trim();
        else if (hint.includes('fan') && hint.includes('card')) value = String(fanCardCode || '').trim();
        else value = String(fanCardCode || priorityTicketCode || sicilNo || identity || '').trim();
        if (!value) return false;

        const modalSel = '.modal.show, .modal.fade.show, .swal2-container.swal2-shown, [role="dialog"][aria-modal="true"], [aria-modal="true"]';
        try {
            // Clear the *correct* input inside the same visible modal root
            await page.evaluate((info) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return r.width > 4 && r.height > 4;
                };
                const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                  || document.querySelector('.swal2-container.swal2-shown') || document;

                const pick = () => {
                    const id = String(info?.id || '').trim();
                    const name = String(info?.name || '').trim();
                    const ph = String(info?.placeholder || '').toLowerCase();

                    if (id) {
                        try {
                            const el = root.querySelector(`#${CSS.escape(id)}`);
                            if (el && isVisible(el)) return el;
                        } catch {}
                    }
                    if (name) {
                        try {
                            const el = root.querySelector(`[name="${CSS.escape(name)}"]`);
                            if (el && isVisible(el)) return el;
                        } catch {}
                    }

                    const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                    const tcLike = inputs.find(i => {
                        const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                        const ml = String(i.getAttribute('maxlength') || '');
                        const is11 = ml === '11' || ml === 11;
                        return (key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || ph.includes('tc') || ph.includes('kimlik')) && (is11 || key.includes('11'));
                    });
                    return tcLike || inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                };

                const input = pick();
                if (!input) return;

                // Clear all tc-like candidates (sometimes the bound field is not the one we picked)
                const allInputs = Array.from(root.querySelectorAll('input, textarea')).filter(Boolean);
                const candidates = allInputs.filter((i) => {
                    const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                    const ml = String(i.getAttribute('maxlength') || '');
                    const tcLike = key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || key.includes('param1');
                    const is11 = ml === '11' || ml === 11;
                    return tcLike || is11;
                });
                for (const el of (candidates.length ? candidates : [input])) {
                    try { el.focus?.(); } catch {}
                    try { el.select?.(); } catch {}
                    try { el.value = ''; } catch {}
                    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                }
            }, { id, name, placeholder });
        } catch {}

        try {
            // Wait briefly for input to appear after selecting the option
            try {
                await page.waitForSelector('.modal.show input, .modal.fade.show input, .swal2-container.swal2-shown input, [role="dialog"] input, [aria-modal="true"] input, .modal.show textarea, .modal.fade.show textarea, .swal2-container.swal2-shown textarea', { timeout: 2500 });
            } catch {}

            // Use a targeted selector first (id/name), then fallback to visible modal inputs.
            const selector = id ? `#${CSS.escape(id)}` : (name ? `[name="${name.replace(/"/g, '\\"')}"]` : `${modalSel} input, ${modalSel} textarea`);
            let inputHandle = await page.$(selector);
            if (!inputHandle) {
                inputHandle = await page.$(`${modalSel} input, ${modalSel} textarea`);
            }
            if (inputHandle) {
                for (let k = 1; k <= 2; k++) {
                    try { await inputHandle.click({ clickCount: 3 }); } catch {}
                    try { await inputHandle.type(value, { delay: 10 }); } catch {}
                    try {
                        await page.evaluate((v, info) => {
                            const isVisible = (el) => {
                                if (!el) return false;
                                const st = window.getComputedStyle(el);
                                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                                const r = el.getBoundingClientRect?.();
                                if (!r) return true;
                                return r.width > 4 && r.height > 4;
                            };
                            const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                            const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                              || document.querySelector('.swal2-container.swal2-shown') || document;

                            const id = String(info?.id || '').trim();
                            const name = String(info?.name || '').trim();
                            let input = null;
                            if (id) {
                                try { input = root.querySelector(`#${CSS.escape(id)}`); } catch {}
                            }
                            if (!input && name) {
                                try { input = root.querySelector(`[name="${CSS.escape(name)}"]`); } catch {}
                            }
                            if (!input) {
                                const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                                input = inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                            }
                            if (!input) return;

                            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                            const setVal = (el) => {
                                try {
                                    if (setter) setter.call(el, String(v || ''));
                                    else el.value = String(v || '');
                                } catch {
                                    try { el.value = String(v || ''); } catch {}
                                }
                                try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                                try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                                try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
                            };

                            // Set value on the picked input and also any other tc-like candidates (bound field may differ)
                            const allInputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                            const candidates = allInputs.filter((i) => {
                                const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                                const ml = String(i.getAttribute('maxlength') || '');
                                const is11 = ml === '11' || ml === 11;
                                return is11 || key.includes('tc') || key.includes('kimlik') || key.includes('tckn') || key.includes('identity') || key.includes('param1');
                            });
                            setVal(input);
                            for (const el of candidates) setVal(el);
                        }, value, { id, name });
                    } catch {}

                    const filledOk = await page.evaluate(() => {
                        const isVisible = (el) => {
                            if (!el) return false;
                            const st = window.getComputedStyle(el);
                            if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                            const r = el.getBoundingClientRect?.();
                            if (!r) return true;
                            return r.width > 4 && r.height > 4;
                        };
                        const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                        const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                          || document.querySelector('.swal2-container.swal2-shown') || document;
                        const inputs = Array.from(root.querySelectorAll('input, textarea')).filter(isVisible);
                        const input = inputs.find(i => String(i.getAttribute('maxlength') || '') === '11') || inputs[0] || null;
                        const val = input ? String(input.value || '').trim() : '';
                        return { ok: !!val, len: val.length };
                    }).catch(() => ({ ok: false, len: 0 }));
                    try { logger.info('prioritySale.input.fill', { ok: !!filledOk?.ok, len: filledOk?.len || 0, attempt: k }); } catch {}

                    // Debug: report what the modal actually contains (helps when UI doesn't show the value)
                    try {
                        const dbg = await page.evaluate(() => {
                            const isVisible = (el) => {
                                if (!el) return false;
                                const st = window.getComputedStyle(el);
                                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                                const r = el.getBoundingClientRect?.();
                                if (!r) return true;
                                return r.width > 4 && r.height > 4;
                            };
                            const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                            const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0]
                              || document.querySelector('.swal2-container.swal2-shown') || document;
                            const inputs = Array.from(root.querySelectorAll('input, textarea'));
                            return inputs.map((i) => {
                                const key = `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
                                return {
                                    name: i.getAttribute('name') || null,
                                    id: i.getAttribute('id') || null,
                                    ph: i.getAttribute('placeholder') || null,
                                    ml: i.getAttribute('maxlength') || null,
                                    type: i.getAttribute('type') || null,
                                    visible: isVisible(i),
                                    key,
                                    len: String(i.value || '').trim().length
                                };
                            });
                        });
                        logger.info('prioritySale.input.debug', { fields: dbg });
                    } catch {}

                    if (filledOk?.ok) break;
                    try { await delay(150); } catch {}
                }
            }
        } catch {}
        return true;
    };

    const waitForPriorityValidation = async (maxMs = 4500) => {
        try {
            const res = await page.waitForResponse((r) => {
                try {
                    const u = String(r?.url?.() || '');
                    if (!/\/api\/passoweb\/priorityvalidationrule(\b|\?|#|\/)/i.test(u)) return false;
                    const req = r.request?.();
                    const m = String(req?.method?.() || '').toUpperCase();
                    if (m && m !== 'POST') return false;
                    return true;
                } catch {
                    return false;
                }
            }, { timeout: maxMs });

            let reqPayload = null;
            try {
                const req = res.request?.();
                const postData = req?.postData?.();
                if (postData) reqPayload = postData;
            } catch {}

            try {
                if (reqPayload) {
                    const parsed = JSON.parse(reqPayload);
                    const p1 = parsed?.param1 != null ? String(parsed.param1) : '';
                    if (!p1 || !p1.trim()) {
                        logger.warn('prioritySale.validation.empty_param1', { request: parsed });
                    }
                }
            } catch {}

            let json = null;
            try { json = await res.json(); } catch {}
            try {
                logger.info('prioritySale.validation.response', {
                    status: (() => { try { return res.status(); } catch { return null; } })(),
                    request: reqPayload,
                    json
                });
            } catch {}
            return { ok: true, status: (() => { try { return res.status(); } catch { return null; } })(), request: reqPayload, json };
        } catch {
            return { ok: false };
        }
    };

    const clickDevam = async () => {
        // Clicking inside page.evaluate() can fail when overlays/interceptors are present.
        // Mark the real button in DOM and click via Puppeteer for reliability.
        let marked = false;
        try {
            marked = await page.evaluate(() => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const isVisible = (el) => {
                    if (!el) return false;
                    const st = window.getComputedStyle(el);
                    if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r) return true;
                    return (r.width > 4 && r.height > 4);
                };
                const roots = [];
                const shown = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show')).filter(isVisible);
                for (const m of shown) roots.push(m);
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (isVisible(swal)) roots.push(swal);
                const roleDlg = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [aria-modal="true"]')).filter(isVisible);
                for (const d of roleDlg) roots.push(d);

                const root = roots.find(r => !!r.querySelector('.priority-sale-select-item')) || roots[0] || document;
                const btns = Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]') || []);
                const pick = (re) => btns.find(x => re.test(norm2(x.innerText || x.textContent || x.value || x.getAttribute('aria-label') || '')));
                const b = pick(/^devam$/i) || pick(/devam/i) || pick(/g[oö]nder/i) || pick(/onayla/i) || null;
                if (!b) return false;
                const disabled = (b.getAttribute('disabled') != null) || (b.getAttribute('aria-disabled') === 'true') || (b.classList?.contains('disabled'));
                if (disabled) return false;
                try { b.setAttribute('data-passobot-priority-continue', '1'); } catch {}
                try { b.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch {}
                return true;
            }).catch(() => false);
        } catch {}

        if (!marked) {
            try { await page.evaluate(() => { try { document.querySelector('[data-passobot-priority-continue]')?.removeAttribute('data-passobot-priority-continue'); } catch {} }); } catch {}
            return;
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const btn = await page.$('[data-passobot-priority-continue="1"]');
                if (btn) {
                    try { await btn.click({ delay: 30 }); } catch {}
                }
            } catch {}

            // Fallback: submit enclosing form if click didn't close modal
            try {
                await page.evaluate(() => {
                    const b = document.querySelector('[data-passobot-priority-continue="1"]');
                    const f = b?.closest('form');
                    if (!f) return;
                    try { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } catch {}
                    try { (typeof f.requestSubmit === 'function') && f.requestSubmit(b); } catch {}
                });
            } catch {}

            try { await delay(250); } catch {}
            const stillOpen = await isOpen().catch(() => false);
            if (!stillOpen) break;
        }

        try { await page.evaluate(() => { try { document.querySelector('[data-passobot-priority-continue]')?.removeAttribute('data-passobot-priority-continue'); } catch {} }); } catch {}
    };

    const clickTamamIfPresent = async () => {
        try {
            await page.evaluate(() => {
                const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                const b = btns.find(x => {
                    const t = norm2(x.innerText || x.textContent || x.value || x.getAttribute('aria-label') || '');
                    return t === 'tamam' || t.includes('tamam');
                }) || null;
                try { b?.click(); } catch {}
            });
        } catch {}
    };

    try {
        try {
            await page.evaluate((d) => { try { window.__passobotPrioritySaleDesired = String(d || ''); } catch {} }, desired);
        } catch {}

        const seen = await waitForModal(8000);
        if (!seen) {
            try {
                const diag = await page.evaluate(() => {
                    const norm2 = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                    const nodes = Array.from(document.querySelectorAll('.modal, .modal-dialog, .swal2-container, [role="dialog"], [aria-modal="true"]')).slice(0, 8);
                    return {
                        url: location.href,
                        dialogCount: nodes.length,
                        dialogSamples: nodes.map(n => ({
                            cls: norm2(n.getAttribute('class') || '').slice(0, 160),
                            text: norm2(n.innerText || '').slice(0, 220)
                        }))
                    };
                }).catch(() => null);
                logger.info('prioritySale.modal.not_seen', { desired: desired || null, url: (() => { try { return page.url(); } catch { return null; } })(), diag });
            } catch {}
            return false;
        }

        try {
            logger.info('prioritySale.modal.detected', { desired: desired || null });
        } catch {}

        for (let attempt = 1; attempt <= 8; attempt++) {
            const opened = await isOpen();
            if (!opened) return true;

            const selInfo = await trySelect();
            if (!selInfo?.ok) {
                if (desired && String(desired).trim()) {
                    try { logger.warn('prioritySale.desired_not_found', { desired, reason: selInfo?.reason || null, options: selInfo?.options || null }); } catch {}
                    return false;
                }
            }
            if (selInfo?.ok) {
                try { logger.info('prioritySale.option.selected', { desired: desired || null, selectedTitle: selInfo?.selectedTitle || null, hasInput: !!selInfo?.hasInput }); } catch {}
            }
            if (selInfo?.ok) {
                const divan = isDivanPrioritySaleCategory(desired);
                const gsPlus = isGsPlusPremiumPriorityCategory(desired);
                if (divan) {
                    const s = String(sicilNo || '').trim();
                    const p = String(priorityTicketCode || '').trim();
                    if (!s || !p) {
                        try {
                            logger.warn('prioritySale.divan.missing_credential_fields', {
                                desired,
                                hasSicilNo: !!s,
                                hasPriorityTicketCode: !!p,
                            });
                        } catch {}
                        return false;
                    }
                    const filled = await fillDivanPrioritySaleModalFields(page, s, p);
                    if (!filled) {
                        try { logger.warn('prioritySale.divan.fill_failed', { desired }); } catch {}
                        return false;
                    }
                    try { logger.info('prioritySale.divan.filled', { desired }); } catch {}
                    try { await delay(250); } catch {}
                } else if (gsPlus) {
                    const ph = String(priorityPhone || '').trim();
                    if (!ph) {
                        try { logger.warn('prioritySale.gsplus.missing_phone', { desired }); } catch {}
                        return false;
                    }
                    const filled = await fillGsPlusPremiumModalFields(page, ph);
                    if (!filled) {
                        try { logger.warn('prioritySale.gsplus.fill_failed', { desired }); } catch {}
                        return false;
                    }
                    try { logger.info('prioritySale.gsplus.filled', { desired }); } catch {}
                    try { await delay(250); } catch {}
                } else if (selInfo?.hasInput) {
                    await fillInputIfNeeded(selInfo);
                }
            }
            const validationWait = waitForPriorityValidation(4500);
            await clickDevam();
            try {
                const v = await validationWait;
                if (v && v.ok) {
                    const isError = (() => {
                        try { return !!v?.json?.isError; } catch { return null; }
                    })();
                    const resultCode = (() => {
                        try { return v?.json?.resultCode; } catch { return null; }
                    })();
                    try { logger.info('prioritySale.validation.result', { isError, resultCode }); } catch {}

                    // Avoid spamming retries when backend says request is bad or asks for cooldown
                    try {
                        const msg = String(v?.json?.message || '');
                        if (isError && (resultCode === 2 || /bad request/i.test(msg))) {
                            logger.warn('prioritySale.validation.bad_request', { resultCode, message: msg });
                            return false;
                        }
                        if (isError && resultCode === 20363) {
                            const m = msg.match(/(\d+)\s*saniye/i);
                            const sec = m ? Number(m[1]) : 0;
                            logger.warn('prioritySale.validation.cooldown', { seconds: sec || null, message: msg });
                            if (sec && Number.isFinite(sec) && sec > 0 && sec < 120) {
                                await delay((sec + 1) * 1000);
                            }
                        }
                    } catch {}
                }
            } catch {}
            await delay(700);
            await clickTamamIfPresent();
            // Give the modal a chance to close; otherwise next loop will re-select repeatedly.
            try {
                await page.waitForFunction(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const st = window.getComputedStyle(el);
                        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                        const r = el.getBoundingClientRect?.();
                        if (!r) return true;
                        return (r.width > 4 && r.height > 4);
                    };
                    const roots = Array.from(document.querySelectorAll('.modal.show, .modal.fade.show, .swal2-container.swal2-shown, [role="dialog"][aria-modal="true"], [aria-modal="true"]'));
                    const open = roots.filter(isVisible).some(r => !!r.querySelector('.priority-sale-select-item'));
                    return !open;
                }, { timeout: 2500 });
            } catch {}
            await delay(300);
            if (!(await isOpen())) return true;
        }
    } catch {}

    return false;
}

async function chooseCategoryAndRandomBlock(page, categoryType, alternativeCategory, selectionMode = 'legacy', preferredSvgBlockId = '') {
    try {
        const u = (() => { try { return page.url(); } catch { return ''; } })();
        const url = String(u || '');
        if (/\/giris(\?|$)/i.test(url)) {
            throw new Error('Kategori/blok seçimi login sayfasında başlatılamaz');
        }
        if (!/\/koltuk-secim/i.test(url)) {
            throw new Error('Kategori/blok seçimi koltuk-secim sayfasında yapılmalı (şu an: ' + (url || 'bilinmiyor') + ')');
        }
    } catch (e) {
        if (e?.message?.includes('Kategori/blok seçimi')) throw e;
    }

    const cat = String(categoryType || '').trim();
    const alt = String(alternativeCategory || '').trim();
    const reCat = new RegExp(cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const reAlt = alt ? new RegExp(alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const UNAVAILABLE_TEXT = 'şu anda uygun bilet bulunmamaktadır';

    let mode = String(selectionMode || 'legacy').toLowerCase();
    if (mode === 'scan_map') mode = 'svg';
    const isPageContextGone = (err) => /detached|target closed|protocol error|session closed|execution context was destroyed|cannot find context/i.test(String(err?.message || err || ''));

    // Scan mode: try SVG first if present, else use dropdown
    let useSvgFlow = (mode === 'svg');
    let proceedToDropdown = false;
    if (mode === 'scan') {
        const hasSvg = await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 5000 }).then(() => true).catch(() => false);
        useSvgFlow = hasSvg;
        if (hasSvg) {
            logger.info('categoryBlock:scan_svg_detected', {});
        } else {
            logger.info('categoryBlock:scan_dropdown_detected', {});
        }
    }

    // New UI: SVG stadium layout block selection
    if (useSvgFlow) {
        const prefBid = String(preferredSvgBlockId || '').trim();
        if (prefBid) {
            const okPref = await selectSvgBlockById(page, prefBid, {
                categoryType: cat,
                categoryLabel: cat,
                categoryId: null
            });
            if (okPref) {
                logger.info('categoryBlock:svg_preferred_block_id_ok', { blockId: prefBid, categoryType: cat || null });
                return { svgBlockId: prefBid };
            }
            logger.warn('categoryBlock:svg_preferred_block_id_miss', { blockId: prefBid, categoryType: cat || null });
        }
        const readSeatmapStateAcrossFrames = async () => {
            try {
                const frames = page.frames();
                const results = await Promise.all(frames.map(async (f) => {
                    try {
                        return await f.evaluate((seatSel) => {
                            const seatmapCount = document.querySelectorAll('svg.seatmap-svg').length;
                            const seatRectCount = document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length;
                            const seatNodes = Math.max(
                                document.querySelectorAll(String(seatSel || '')).length,
                                seatRectCount
                            );
                            const bodyText = (document.body?.innerText || '').toLowerCase();
                            const noTicket = bodyText.includes('uygun bilet bulunamamaktadır') || bodyText.includes('uygun koltuk bulunamamaktadır') || bodyText.includes('koltuk bulunamadı');
                            const hasSeatmapSvg = seatmapCount > 0;
                            const hasSeatmapContainer = !!document.querySelector('.seatmap-container, .seat-map, [class*="seatmap"], [id*="seatmap"], #toolTipList');
                            return { ok: true, seatNodes, noTicket, hasSeatmapSvg, hasSeatmapContainer, seatmapCount, seatRectCount, url: location.href };
                        }, SEAT_NODE_SELECTOR);
                    } catch {
                        return { ok: false, seatNodes: 0, noTicket: false, hasSeatmapSvg: false, url: (() => { try { return f.url(); } catch { return null; } })() };
                    }
                }));

                const seatmapFrameHint = await page.evaluate(() => {
                    const frames = Array.from(document.querySelectorAll('iframe'));
                    const visible = (el) => {
                        try {
                            const r = el.getBoundingClientRect();
                            if (!r || !r.width || !r.height) return false;
                            const style = window.getComputedStyle(el);
                            if (!style) return true;
                            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                        } catch {
                            return false;
                        }
                    };
                    const looksSeat = (src) => {
                        const s = String(src || '').toLowerCase();
                        return s.includes('koltuk') || s.includes('seat') || s.includes('seatmap') || s.includes('venue');
                    };
                    const hits = frames
                        .map(f => ({ src: f.getAttribute('src') || '', id: f.getAttribute('id') || '', name: f.getAttribute('name') || '' }))
                        .filter(x => looksSeat(x.src) || looksSeat(x.id) || looksSeat(x.name));
                    const anyVisible = frames.some(f => visible(f) && (looksSeat(f.getAttribute('src')) || looksSeat(f.getAttribute('id')) || looksSeat(f.getAttribute('name'))));
                    return { anyVisible, count: hits.length, examples: hits.slice(0, 3) };
                }).catch(() => ({ anyVisible: false, count: 0, examples: [] }));

                const agg = {
                    seatNodes: 0,
                    noTicket: false,
                    hasSeatmapSvg: false,
                    hasSeatmapContainer: false,
                    hasSeatmapFrameHint: !!seatmapFrameHint?.anyVisible,
                    seatmapFrameHint,
                    url: (() => { try { return page.url(); } catch { return null; } })(),
                    frameCount: frames.length
                };
                for (const r of results) {
                    if (!r) continue;
                    agg.seatNodes = Math.max(agg.seatNodes, Number(r.seatNodes || 0));
                    agg.noTicket = agg.noTicket || !!r.noTicket;
                    agg.hasSeatmapSvg = agg.hasSeatmapSvg || !!r.hasSeatmapSvg;
                    agg.hasSeatmapContainer = agg.hasSeatmapContainer || !!r.hasSeatmapContainer;
                }
                return agg;
            } catch {
                return { seatNodes: 0, noTicket: false, hasSeatmapSvg: false, hasSeatmapFrameHint: false, seatmapFrameHint: null, url: null, frameCount: 0 };
            }
        };

        const clickDevamAny = async () => {
            try {
                await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '').startsWith('devam'));
                    try { b?.click(); } catch {}
                });
            } catch {}
        };

        const dismissMustSelectProductModal = async () => {
            try {
                return await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const txt = norm(document.body?.innerText || '');
                    if (!txt.includes('lütfen en az bir adet ürün seçiniz')) return { found: false };

                    // Try common modal close buttons.
                    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .swal2-confirm, .swal2-cancel, .modal-footer button, .modal-header button'));
                    const closeBtn = candidates.find(b => {
                        const t = norm(b.innerText || b.textContent || b.value || '');
                        return t === 'tamam' || t === 'kapat' || t === 'ok' || t.includes('tamam') || t.includes('kapat');
                    }) || candidates.find(b => {
                        const t = norm(b.innerText || b.textContent || b.value || '');
                        return t.includes('tamam') || t.includes('kapat') || t.includes('ok');
                    });
                    try { closeBtn?.click(); } catch {}
                    return { found: true, clicked: !!closeBtn };
                });
            } catch {
                return { found: false };
            }
        };

        const clickSelfSelectAny = async () => {
            const found = await page.evaluate(() => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                const byId = document.getElementById('custom_seat_button');
                const el = byId || els.find(x => {
                    const t = norm(x.innerText || x.textContent || x.value || '');
                    return t.includes('kendim seçmek istiyorum') || t.includes('secimi degistir') || t.includes('seçimi değiştir');
                });
                if (!el) return { ok: false, reason: 'not_found' };
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
                const r = el.getBoundingClientRect();
                if (!r || !r.width || !r.height) return { ok: false, reason: 'no_rect' };
                const x = r.left + (r.width / 2);
                const y = r.top + (r.height / 2);
                return { ok: true, x, y };
            }).catch(() => ({ ok: false, reason: 'eval_failed' }));

            if (found && found.ok && Number.isFinite(found.x) && Number.isFinite(found.y)) {
                try {
                    await page.mouse.move(found.x, found.y);
                    await page.mouse.down();
                    await page.mouse.up();
                    return true;
                } catch {}
            }

            try {
                await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const byId = document.getElementById('custom_seat_button');
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = byId || btns.find(x => {
                        const t = norm(x.innerText || x.textContent || x.value || '');
                        return t.includes('kendim seçmek istiyorum') || t.includes('secimi degistir') || t.includes('seçimi değiştir');
                    });
                    try { b?.click(); } catch {}
                });
            } catch {}
            return false;
        };

        // If seatmap is already present on the page, do not reset UI by clicking intermediate buttons.
        // This happens in some flows where both layout + seatmap are visible at the same time.
        try {
            const initial = await readSeatmapStateAcrossFrames();
            // IMPORTANT: some pages render seatmap *containers* before the actual SVG is loaded.
            // Only treat seatmap as ready when we see real seat nodes (rects/nodes) or seatmap SVG.
            const seatmapAlready = (initial?.hasSeatmapSvg && initial?.seatNodes > 0) || (Number(initial?.seatNodes || 0) > 0);
            const ui = await page.evaluate(() => {
                const blocksCount = document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length;
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                const hasSelfSelectBtn = els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                return { blocksCount, hasSelfSelectBtn };
            }).catch(() => ({ blocksCount: 0, hasSelfSelectBtn: false }));

            // Only skip when we're clearly in seatmap view.
            // If layout blocks AND the "Kendim seçmek istiyorum" button are still visible, we may need to select a block to change the seatmap.
            const clearlySeatmapView = !ui?.blocksCount || !ui?.hasSelfSelectBtn;
            if (seatmapAlready && clearlySeatmapView && !initial?.noTicket) {
                logger.info('categoryBlock:svg_seatmap_already_present_skip', { initial, ui });
                return;
            }
        } catch {}

        // SVG layout can be AB-tested / gated; if not present, fallback to legacy dropdown flow.
        const svgRootOk = await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 15000 }).then(() => true).catch(() => false);
        if (!svgRootOk) {
            if (mode === 'scan') {
                logger.info('categoryBlock:scan_svg_fallback_dropdown', { reason: 'SVG_LAYOUT_MISSING' });
                proceedToDropdown = true;
            } else {
                logger.warn('categoryBlock:svg_layout_missing_fallback_legacy', {
                    url: (() => { try { return page.url(); } catch { return null; } })(),
                    title: await page.title().catch(() => null)
                });
                throw new Error('SVG_LAYOUT_MISSING');
            }
        }
        if (!proceedToDropdown) {
            const svgProbeCache = new Map();
            const readSvgLegendEntries = async () => {
                return await page.evaluate(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect?.();
                        if (!r || r.width < 2 || r.height < 2) return false;
                        const st = window.getComputedStyle(el);
                        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                        return true;
                    };
                    const colorToText = (el) => {
                        if (!el) return '';
                        try {
                            const st = window.getComputedStyle(el);
                            return String(st?.backgroundColor || el.style?.background || el.style?.backgroundColor || '').trim();
                        } catch {
                            return '';
                        }
                    };
                    const pickRows = () => {
                        const selectors = [
                            '.blogContainer > div', '.blogContainer > *',
                            '#blogContainer > div', '#blogContainer > *',
                            '.legend > div', '.legend > *',
                            '[class*="legend" i] > div', '[class*="legend" i] > *',
                            '[class*="kategori" i] > div', '[class*="kategori" i] > *'
                        ];
                        for (const sel of selectors) {
                            const els = Array.from(document.querySelectorAll(sel));
                            if (els.length) return els;
                        }
                        // As a last resort, treat each title as a row.
                        return Array.from(document.querySelectorAll('.title-category, [class*="title-category" i]'));
                    };
                    const rows = pickRows();
                    const out = [];
                    for (const row of rows) {
                        const titleEl =
                            row?.querySelector?.('.title-category, [class*="title-category" i]') ||
                            (row?.classList && (row.classList.contains('title-category') || String(row.className || '').toLowerCase().includes('title-category')) ? row : null);
                        const colorEl =
                            row?.querySelector?.('.color-category, [class*="color-category" i], [style*="background" i]') ||
                            (titleEl ? (titleEl.parentElement?.querySelector?.('.color-category, [class*="color-category" i], [style*="background" i]') || null) : null);
                        const title = String(titleEl?.innerText || titleEl?.textContent || '').trim();
                        if (!title || !isVisible(titleEl)) continue;
                        out.push({
                            title,
                            color: colorToText(colorEl)
                        });
                    }
                    // Deduplicate by title.
                    const seen = new Set();
                    return out.filter((e) => {
                        const k = String(e?.title || '').trim();
                        if (!k) return false;
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    });
                }).catch(() => []);
            };
            const waitForSvgLegendEntries = async () => {
                for (let attempt = 1; attempt <= 6; attempt++) {
                    const entries = await readSvgLegendEntries();
                    if (Array.isArray(entries) && entries.length) {
                        try { svgLegendEntriesCache.set(page, entries); } catch {}
                        return { entries, source: 'live' };
                    }
                    await delay(250);
                }
                const cached = (() => {
                    try { return svgLegendEntriesCache.get(page) || []; } catch { return []; }
                })();
                if (Array.isArray(cached) && cached.length) {
                    return { entries: cached, source: 'cache' };
                }
                return { entries: [], source: 'empty' };
            };
            const readVisibleSvgTooltipText = async () => {
                return await page.evaluate(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect?.();
                        if (!r || r.width < 2 || r.height < 2) return false;
                        const st = window.getComputedStyle(el);
                        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                        return true;
                    };
                    const selectors = [
                        '#toolTipList',
                        '[role="tooltip"]',
                        '[id*="tooltip" i]',
                        '[class*="tooltip" i]',
                        '[class*="popover" i]',
                        '.tippy-box',
                        '.tooltip-inner'
                    ];
                    const picks = [];
                    for (const sel of selectors) {
                        for (const el of Array.from(document.querySelectorAll(sel))) {
                            if (!isVisible(el)) continue;
                            const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                            if (!text) continue;
                            picks.push(text);
                        }
                    }
                    picks.sort((a, b) => {
                        const aHas = /\bblok\b/i.test(a) ? 1 : 0;
                        const bHas = /\bblok\b/i.test(b) ? 1 : 0;
                        if (aHas !== bHas) return bHas - aHas;
                        return b.length - a.length;
                    });
                    return picks[0] || '';
                }).catch(() => '');
            };
            const readClickPoint = async (targetId) => {
                return await page.evaluate((blockId) => {
                    const el = document.getElementById(blockId);
                    if (!el) return { ok: false, id: blockId, reason: 'not_found' };

                    const asEl = /** @type {Element} */ (el);
                    try { asEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}

                    let rect = null;
                    try {
                        if (typeof asEl.getBoundingClientRect === 'function') rect = asEl.getBoundingClientRect();
                    } catch {}

                    if (!rect || !rect.width || !rect.height) {
                        try {
                            const svgEl = /** @type {any} */ (asEl);
                            if (typeof svgEl.getBBox === 'function') {
                                const b = svgEl.getBBox();
                                const ctm = svgEl.getScreenCTM && svgEl.getScreenCTM();
                                if (ctm) {
                                    const x = (b.x + (b.width / 2)) * ctm.a + ctm.e;
                                    const y = (b.y + (b.height / 2)) * ctm.d + ctm.f;
                                    return { ok: true, id: blockId, tag: asEl.tagName, x, y, width: b.width || 0, height: b.height || 0, method: 'getBBox' };
                                }
                            }
                        } catch {}
                    }

                    if (!rect) return { ok: false, id: blockId, reason: 'no_rect', tag: asEl.tagName };
                    const x = rect.left + (rect.width / 2);
                    const y = rect.top + (rect.height / 2);
                    const top = (() => {
                        try {
                            const t = document.elementFromPoint(x, y);
                            if (!t) return null;
                            return {
                                tag: t.tagName,
                                id: t.getAttribute('id') || t.id || null,
                                className: (t.getAttribute('class') || '').toString().slice(0, 120)
                            };
                        } catch {
                            return null;
                        }
                    })();
                    return { ok: true, id: blockId, tag: asEl.tagName, x, y, width: rect.width || 0, height: rect.height || 0, method: 'getBoundingClientRect', top };
                }, targetId).catch(() => ({ ok: false, id: targetId, reason: 'eval_failed' }));
            };
            const enrichSvgCandidatesWithLegendColors = async (candidates, legendEntries, legendCategoryTexts = []) => {
                const base = Array.isArray(candidates) ? candidates : [];
                const catTexts = Array.isArray(legendCategoryTexts) ? legendCategoryTexts : [];
                const legend = (Array.isArray(legendEntries) ? legendEntries : [])
                    .map((entry) => {
                        const rgb = parseRgbColorString(entry?.color || '');
                        const legendMatchScore = Number.isFinite(Number(entry?.score))
                            ? Number(entry.score)
                            : getSvgCategoryMatchScore(entry?.title || '', catTexts);
                        return { ...entry, rgb, legendMatchScore };
                    })
                    .filter((entry) => !!entry.rgb);
                if (!base.length) return [];

                const clickPoints = [];
                for (const candidate of base) {
                    const clickPoint = await readClickPoint(candidate.id);
                    clickPoints.push({ ...candidate, clickPoint });
                }
                if (!legend.length) {
                    return clickPoints.map((item) => ({
                        ...item,
                        sampledColor: null,
                        colorDistance: Number.POSITIVE_INFINITY,
                        colorScore: 0,
                        legendCombinedScore: 0,
                        legendNameScore: 0,
                        legendTitle: null,
                        legendColor: null
                    }));
                }

                const dpr = await page.evaluate(() => Number(window.devicePixelRatio || 1) || 1).catch(() => 1);
                let png = null;
                try {
                    const shot = await page.screenshot({ type: 'png' });
                    png = PNG.sync.read(shot);
                } catch {}
                if (!png) {
                    return clickPoints.map((item) => ({
                        ...item,
                        sampledColor: null,
                        colorDistance: Number.POSITIVE_INFINITY,
                        colorScore: 0,
                        legendCombinedScore: 0,
                        legendNameScore: 0,
                        legendTitle: null,
                        legendColor: null
                    }));
                }

                return clickPoints.map((item) => {
                    const cp = item.clickPoint || null;
                    if (!cp?.ok || !Number.isFinite(cp.x) || !Number.isFinite(cp.y)) {
                        return {
                            ...item,
                            sampledColor: null,
                            colorDistance: Number.POSITIVE_INFINITY,
                            colorScore: 0,
                            legendCombinedScore: 0,
                            legendNameScore: 0,
                            legendTitle: null,
                            legendColor: null
                        };
                    }
                    const width = Math.max(6, Number(cp.width || 0));
                    const height = Math.max(6, Number(cp.height || 0));
                    const samplePoints = [
                        { x: cp.x, y: cp.y },
                        { x: cp.x - (width * 0.18), y: cp.y },
                        { x: cp.x + (width * 0.18), y: cp.y },
                        { x: cp.x, y: cp.y - (height * 0.18) },
                        { x: cp.x, y: cp.y + (height * 0.18) }
                    ].map((pt) => ({ x: pt.x * dpr, y: pt.y * dpr }));
                    let bestColor = null;
                    let bestLegend = null;
                    let bestDistance = Number.POSITIVE_INFINITY;
                    let bestCombined = 0;
                    for (const pt of samplePoints) {
                        const sampled = samplePngPatchColor(png, pt.x, pt.y, 3);
                        if (!sampled) continue;
                        for (const entry of legend) {
                            const dist = colorDistance(sampled, entry.rgb);
                            const nameSc = Number(entry.legendMatchScore || 0);
                            const combined = svgCategoryColorCombinedScore(nameSc, dist);
                            const better = combined > bestCombined
                                || (combined === bestCombined && combined > 0 && dist < bestDistance)
                                || (bestCombined === 0 && combined === 0 && dist < bestDistance);
                            if (better) {
                                bestCombined = combined;
                                bestDistance = dist;
                                bestColor = sampled;
                                bestLegend = entry;
                            }
                        }
                    }
                    const colorScore = Number.isFinite(bestDistance)
                        ? Math.max(0, 240 - Math.min(240, bestDistance * 2.1))
                        : 0;
                    const legendNameScore = Number(bestLegend?.legendMatchScore || 0);
                    return {
                        ...item,
                        sampledColor: bestColor,
                        colorDistance: bestDistance,
                        colorScore,
                        legendCombinedScore: bestCombined,
                        legendNameScore,
                        legendTitle: bestLegend?.title || null,
                        legendColor: bestLegend?.color || null
                    };
                });
            };
            const probeSvgCandidate = async (candidate, categoryTexts, preferLegendCategoryColor = false) => {
                if (!candidate?.id) return { ...(candidate || {}), ok: false, tooltipText: '', matchScore: 0 };
                const probeCacheKey = `${candidate.id}|${preferLegendCategoryColor ? 'cc' : 'leg'}`;
                if (svgProbeCache.has(probeCacheKey)) return svgProbeCache.get(probeCacheKey);
                const clickPoint = await readClickPoint(candidate.id);
                let tooltipText = '';
                if (clickPoint?.ok && Number.isFinite(clickPoint.x) && Number.isFinite(clickPoint.y)) {
                    try {
                        await page.mouse.move(clickPoint.x, clickPoint.y, { steps: 10 });
                        await delay(140);
                    } catch {}
                    try {
                        await page.evaluate((x, y) => {
                            const hit = document.elementFromPoint(x, y);
                            const target = hit?.closest('g.block, .svgBlock') || hit;
                            if (!target) return;
                            const fire = (el, type) => {
                                try {
                                    const base = {
                                        bubbles: true,
                                        cancelable: true,
                                        view: window,
                                        clientX: x,
                                        clientY: y,
                                        button: 0,
                                        buttons: 0
                                    };
                                    const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                                    const ev = usePointer
                                        ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                                        : new MouseEvent(type, base);
                                    el.dispatchEvent(ev);
                                } catch {}
                            };
                            fire(target, 'pointerover');
                            fire(target, 'mouseover');
                            fire(target, 'pointermove');
                            fire(target, 'mousemove');
                        }, clickPoint.x, clickPoint.y);
                    } catch {}
                    await delay(160);
                    tooltipText = await readVisibleSvgTooltipText();
                }
                const tooltipScore = getSvgCategoryMatchScore(tooltipText, categoryTexts);
                const colorScore = Number(candidate?.colorScore || 0);
                const legendCombined = Number(candidate?.legendCombinedScore || 0);
                let matchScore;
                if (preferLegendCategoryColor && legendCombined > 0) {
                    matchScore = legendCombined + Math.min(22, Math.round(tooltipScore * 0.18));
                } else {
                    matchScore = Math.max(colorScore, tooltipScore);
                }
                const result = { ...candidate, clickPoint, tooltipText, tooltipScore, matchScore };
                svgProbeCache.set(probeCacheKey, result);
                return result;
            };
            const requestedSvgTexts = [cat, alt].filter(Boolean);
            const tried = new Set();
            const maxTries = 40;
            for (let attempt = 1; attempt <= maxTries; attempt++) {
                // This intermediate screen sometimes ignores programmatic clicks. Force a real mouse click and retry.
                let layoutOk = false;
                for (let s = 0; s < 3; s++) {
                    const uiState = await page.evaluate(() => {
                        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                        const blocksExist = document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length > 0;
                        const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                        const hasSelfSelect = !!document.getElementById('custom_seat_button') || els.some((x) => {
                            const t = norm(x.innerText || x.textContent || x.value || '');
                            return t.includes('kendim seçmek istiyorum') || t.includes('secimi degistir') || t.includes('seçimi değiştir');
                        });
                        return { blocksExist, hasSelfSelect };
                    }).catch(() => ({ blocksExist: false, hasSelfSelect: false }));
                    if (!uiState.blocksExist || uiState.hasSelfSelect) {
                        const clickedSelfSelect = await clickSelfSelectAny();
                        logger.info('categoryBlock:svg_self_select_guard', {
                            attempt,
                            subAttempt: s + 1,
                            blocksExist: !!uiState.blocksExist,
                            hasSelfSelect: !!uiState.hasSelfSelect,
                            clickedSelfSelect
                        });
                    }
                    layoutOk = await page.waitForSelector('svg.svgLayout, svg .svgLayout, svg[class*="svgLayout"], .svgLayout', { timeout: 6000 })
                        .then(() => true)
                        .catch(() => false);
                    if (layoutOk) break;
                    await delay(650);
                }

                if (!layoutOk) {
                    logger.warn('categoryBlock:svg_layout_not_ready_retry', { attempt });
                    await delay(900);
                    continue;
                }

                const blocksOk = await page.waitForSelector(
                    [
                        'svg.svgLayout g.block',
                        'svg.svgLayout .svgBlock',
                        '.svgLayout g.block',
                        '.svgLayout .svgBlock',
                        // Some events don't use class="block"; they only have id="block12345" etc.
                        'svg.svgLayout [id^="block"]',
                        '.svgLayout [id^="block"]'
                    ].join(', '),
                    { timeout: 15000 }
                )
                    .then(() => true)
                    .catch(() => false);

                if (!blocksOk) {
                    logger.warn('categoryBlock:svg_blocks_missing_retry', { attempt });
                    await delay(900);
                    continue;
                }

                const legendState = await waitForSvgLegendEntries();
                const svgLegendEntries = Array.isArray(legendState?.entries) ? legendState.entries : [];
                const matchedLegendEntries = svgLegendEntries
                    .filter((entry) => getSvgCategoryMatchScore(entry?.title || '', requestedSvgTexts) > 0)
                    .map((entry) => ({
                        ...entry,
                        score: getSvgCategoryMatchScore(entry?.title || '', requestedSvgTexts)
                    }))
                    .sort((a, b) => (b.score || 0) - (a.score || 0));
                const svgDesiredTexts = Array.from(new Set([
                    ...requestedSvgTexts,
                    ...matchedLegendEntries.map((entry) => entry.title)
                ].filter(Boolean)));
                logger.info('categoryBlock:svg_targets', {
                    attempt,
                    categoryType: cat || null,
                    alternativeCategory: alt || null,
                    desiredTexts: svgDesiredTexts,
                    legendSource: legendState?.source || 'empty',
                    legendCount: svgLegendEntries.length,
                    legendMatches: matchedLegendEntries.map((entry) => ({
                        title: entry.title,
                        color: entry.color,
                        score: entry.score
                    }))
                });

                const candidates = await page.evaluate(() => {
                    const picks = [
                        ...Array.from(document.querySelectorAll('svg.svgLayout g.block, .svgLayout g.block')),
                        ...Array.from(document.querySelectorAll('svg.svgLayout .svgBlock, .svgLayout .svgBlock')),
                        ...Array.from(document.querySelectorAll('svg.svgLayout [id^="block"], .svgLayout [id^="block"]'))
                    ];
                    const items = picks
                        .map(el => ({
                            id: el.getAttribute('id') || el.id || null,
                            tag: el.tagName
                        }))
                        .filter(x => !!x.id);
                    // Dedup by id
                    const seen = new Set();
                    return items.filter((x) => {
                        const k = String(x.id || '');
                        if (!k) return false;
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                    });
                });

                let remaining = (candidates || []).filter(c => c?.id && !tried.has(c.id));
                if (!remaining.length) break;
                let pick = null;
                let matchedCandidates = [];
                if (svgDesiredTexts.length) {
                    const relevantLegendEntries = matchedLegendEntries.length
                        ? matchedLegendEntries
                        : svgLegendEntries.filter((entry) => svgDesiredTexts.includes(entry.title));
                    const coloredCandidates = await enrichSvgCandidatesWithLegendColors(remaining, relevantLegendEntries, requestedSvgTexts);
                    const hasLegendRgb = (Array.isArray(relevantLegendEntries) ? relevantLegendEntries : []).some((e) => !!parseRgbColorString(e?.color || ''));
                    const preferLegendCategoryColor = matchedLegendEntries.length > 0 && hasLegendRgb;
                    const runProbes = async (preferCc) => {
                        const out = [];
                        for (const candidate of coloredCandidates) {
                            const probed = await probeSvgCandidate(candidate, svgDesiredTexts, preferCc);
                            if (probed.matchScore > 0) out.push(probed);
                        }
                        return out;
                    };
                    matchedCandidates = await runProbes(preferLegendCategoryColor);
                    if (!matchedCandidates.length && preferLegendCategoryColor) {
                        matchedCandidates = await runProbes(false);
                    }
                    matchedCandidates.sort((a, b) => {
                        if ((b.matchScore || 0) !== (a.matchScore || 0)) return (b.matchScore || 0) - (a.matchScore || 0);
                        if ((b.legendCombinedScore || 0) !== (a.legendCombinedScore || 0)) {
                            return (b.legendCombinedScore || 0) - (a.legendCombinedScore || 0);
                        }
                        if ((b.colorScore || 0) !== (a.colorScore || 0)) return (b.colorScore || 0) - (a.colorScore || 0);
                        return String(a.id || '').localeCompare(String(b.id || ''));
                    });
                }
                if (matchedCandidates.length) {
                    pick = matchedCandidates[0];
                    logger.info('categoryBlock:svg_block_from_tooltip', {
                        categoryType: cat || null,
                        alternativeCategory: alt || null,
                        blockId: pick.id,
                        legendTitle: pick.legendTitle || null,
                        legendColor: pick.legendColor || null,
                        legendNameScore: pick.legendNameScore || 0,
                        legendCombinedScore: pick.legendCombinedScore || 0,
                        sampledColor: pick.sampledColor || null,
                        colorDistance: Number.isFinite(pick.colorDistance) ? pick.colorDistance : null,
                        colorScore: pick.colorScore || 0,
                        tooltipText: pick.tooltipText || '',
                        tooltipScore: pick.tooltipScore || 0,
                        matchScore: pick.matchScore || 0
                    });
                } else if (svgDesiredTexts.length && mode === 'svg') {
                    logger.warn('categoryBlock:svg_category_match_failed', {
                        categoryType: cat || null,
                        alternativeCategory: alt || null,
                        mode,
                        preferredSvgBlockId: String(preferredSvgBlockId || '').trim() || null,
                        desiredTexts: svgDesiredTexts
                    });
                    // Some events don't expose category names in legend/tooltips consistently.
                    // In that case, continue with a random block instead of aborting the whole run.
                    pick = remaining[Math.floor(Math.random() * remaining.length)];
                } else if (svgDesiredTexts.length && mode === 'scan') {
                    // In scan mode prefer dropdown when available, but some pages are SVG-only.
                    const hasDropdownUi = await page.evaluate(() => {
                        return !!document.querySelector('.custom-select-box, .dropdown-option, [role="option"], select#blocks, select[name*="block" i], select[id*="block" i]');
                    }).catch(() => false);
                    logger.info('categoryBlock:scan_svg_fallback_dropdown', {
                        reason: 'SVG_CATEGORY_MATCH_NOT_FOUND',
                        categoryType: cat || null,
                        alternativeCategory: alt || null,
                        hasDropdownUi
                    });
                    if (hasDropdownUi) {
                        proceedToDropdown = true;
                        break;
                    }
                    // SVG-only: just pick a random block and proceed with clicking.
                    pick = remaining[Math.floor(Math.random() * remaining.length)];
                } else {
                    pick = remaining[Math.floor(Math.random() * remaining.length)];
                }

                let clicked = { ok: false, id: pick.id, reason: 'no_point' };
                let lastPoint = null;
                for (let c = 0; c < 3; c++) {
                    const clickPoint = pick?.clickPoint && c === 0
                        ? pick.clickPoint
                        : await readClickPoint(pick.id);
                    lastPoint = clickPoint;
                    if (!clickPoint || !clickPoint.ok || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) {
                        clicked = { ok: false, id: pick.id, reason: 'no_point_eval' };
                        continue;
                    }

                    const jitter = c === 0 ? { dx: 0, dy: 0 } : (c === 1 ? { dx: 3, dy: -3 } : { dx: -3, dy: 3 });
                    const x = clickPoint.x + jitter.dx;
                    const y = clickPoint.y + jitter.dy;

                    try {
                        // Disable obvious overlays if they are on top of our click point.
                        try {
                            const top = clickPoint?.top || null;
                            const topTag = String(top?.tag || '').toUpperCase();
                            const topClass = String(top?.className || '');
                            const looksLikeBlocker = (
                                topTag.startsWith('EFILLI') ||
                                topClass.toLowerCase().includes('efilli') ||
                                topClass.toLowerCase().includes('cookie') ||
                                topClass.toLowerCase().includes('consent')
                            );
                            if (looksLikeBlocker) {
                                await page.evaluate((x, y) => {
                                    try {
                                        const t = document.elementFromPoint(x, y);
                                        const disable = (el) => {
                                            if (!el || !el.style) return;
                                            try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                                            try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                                            try { el.style.setProperty('display', 'none', 'important'); } catch {}
                                        };
                                        disable(t);
                                        try { disable(t?.closest('efilli-layout-dynamic, efilli-layout, efilli-consent, [class*="cookie" i], [class*="consent" i]')); } catch {}
                                    } catch {}
                                }, x, y);
                            }
                        } catch {}

                        await page.mouse.move(x, y, { steps: 12 });
                        await delay(60);
                        // Arm hover listeners before the click
                        try {
                            await page.evaluate((x, y) => {
                                const hit = document.elementFromPoint(x, y);
                                const target = hit?.closest('g.block, .svgBlock') || hit;
                                if (!target) return;
                                const fire = (el, type) => {
                                    try {
                                        const base = {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window,
                                            clientX: x,
                                            clientY: y,
                                            button: 0,
                                            buttons: 0
                                        };
                                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                                        const ev = usePointer
                                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                                            : new MouseEvent(type, base);
                                        el.dispatchEvent(ev);
                                    } catch {}
                                };
                                fire(target, 'pointerover');
                                fire(target, 'mouseover');
                                fire(target, 'pointermove');
                                fire(target, 'mousemove');
                            }, x, y);
                        } catch {}

                        await page.mouse.down();
                        await delay(90);
                        await page.mouse.up();
                        await delay(40);
                        await page.mouse.click(x, y, { delay: 55 });

                        // Also dispatch pointer/mouse sequence on the hit-tested element.
                        try {
                            await page.evaluate((x, y) => {
                                const fire = (el, type, extra = {}) => {
                                    try {
                                        const base = {
                                            bubbles: true,
                                            cancelable: true,
                                            view: window,
                                            clientX: x,
                                            clientY: y,
                                            button: 0,
                                            buttons: 1,
                                            ...extra
                                        };
                                        const usePointer = String(type || '').toLowerCase().startsWith('pointer') && (typeof PointerEvent !== 'undefined');
                                        const ev = usePointer
                                            ? new PointerEvent(type, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...base })
                                            : new MouseEvent(type, base);
                                        el.dispatchEvent(ev);
                                    } catch {}
                                };
                                try {
                                    const hit = document.elementFromPoint(x, y);
                                    const target = hit?.closest('g.block, .svgBlock') || hit;
                                    if (!target) return;
                                    try { target.style?.setProperty('pointer-events', 'auto', 'important'); } catch {}
                                    fire(target, 'pointerdown');
                                    fire(target, 'mousedown');
                                    fire(target, 'pointerup');
                                    fire(target, 'mouseup');
                                    fire(target, 'click');
                                } catch {}
                            }, x, y);
                        } catch {}

                        clicked = { ok: true, id: pick.id, tag: clickPoint.tag, method: clickPoint.method, try: c + 1, jitter };
                        break;
                    } catch (e) {
                        clicked = { ok: false, id: pick.id, reason: 'mouse_click_failed', error: e?.message || String(e), try: c + 1, jitter };
                    }
                }

                logger.info('categoryBlock:svg_clicked', { attempt, clicked, clickPoint: lastPoint });

                // Stabilization: after clicking a block Passo often shows a loader overlay.
                // Do not attempt to leave / change blocks while loader is visible, otherwise we thrash the UI.
                try {
                    await page.waitForFunction(() => {
                        const isVisible = (el) => {
                            if (!el) return false;
                            const st = window.getComputedStyle(el);
                            if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                            const r = el.getBoundingClientRect?.();
                            if (!r) return true;
                            return r.width > 4 && r.height > 4;
                        };
                        const loader = document.querySelector('.loader, .loading, .spinner, [class*="loader" i], [class*="spinner" i]');
                        if (isVisible(loader)) return false;
                        // Also avoid continuing while the click point is still covered by a loader.
                        const anyLoaderOnTop = (() => {
                            try {
                                const els = Array.from(document.querySelectorAll('.loader, .loading, .spinner, [class*="loader" i], [class*="spinner" i]'));
                                const vis = els.filter(isVisible);
                                if (!vis.length) return false;
                                // If any loader is visible, treat as blocking.
                                return true;
                            } catch {
                                return false;
                            }
                        })();
                        return !anyLoaderOnTop;
                    }, { timeout: 15000 });
                } catch {}

                let seatCheck = { seatNodes: 0, noTicket: false, hasSeatmapSvg: false, url: null, frameCount: 0 };
                let uiReady = false;
                for (let t = 0; t < 4; t++) {
                    // Do not click 'Devam' while still on category/layout view. It triggers "ürün seçiniz" modal.
                    const ui = await page.evaluate(() => {
                        const blocksCount = document.querySelectorAll('svg.svgLayout g.block, svg.svgLayout .svgBlock, .svgLayout g.block, .svgLayout .svgBlock').length;
                        const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                        const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                        const hasSelfSelectBtn = els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                        return { blocksCount, hasSelfSelectBtn };
                    }).catch(() => ({ blocksCount: 0, hasSelfSelectBtn: false }));

                    const isStillOnLayout = (ui?.blocksCount > 0) && !!ui?.hasSelfSelectBtn;
                    if (!isStillOnLayout) {
                        await clickDevamAny();
                    }
                    const modalDismiss = await dismissMustSelectProductModal();
                    if (modalDismiss?.found) {
                        logger.warn('categoryBlock:devam_modal_dismissed', { t, modalDismiss, ui });
                    }
                    await delay(900 + (t * 450));
                    seatCheck = await readSeatmapStateAcrossFrames();
                    uiReady = (seatCheck.hasSeatmapSvg || seatCheck.seatNodes > 0 || seatCheck.noTicket || seatCheck.hasSeatmapFrameHint);
                    if (uiReady) break;
                }

                const hasSeats = (seatCheck.seatNodes > 0) || seatCheck.hasSeatmapSvg;
                if (uiReady && (hasSeats || seatCheck.hasSeatmapFrameHint) && !seatCheck.noTicket) {
                    logger.info('categoryBlock:svg_block_ok', { attempt, blockId: pick.id, seatCheck });
                    try {
                        await page.evaluate((bid) => {
                            try { window.__passobotLastSvgBlockId = String(bid || ''); } catch {}
                        }, pick.id);
                    } catch {}
                    return { svgBlockId: pick.id };
                }

                tried.add(pick.id);
                logger.info('categoryBlock:svg_block_no_seat', { attempt, blockId: pick.id, seatCheck, triedCount: tried.size });

                // Passo flow: when there are no seats (or seatmap didn't load), "Seçimi değiştir" sends user back to the beginning
                // where "Kendim seçmek istiyorum" is shown again.
                const changed = await page.evaluate(() => {
                    const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    const b = btns.find(x => norm(x.innerText || x.textContent || x.value || '') === 'seçimi değiştir');
                    if (!b) return false;
                    try { b.click(); } catch { return false; }
                    return true;
                }).catch(() => false);

                if (changed) {
                    await page.waitForSelector('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]', { timeout: 15000 })
                        .then(async () => {
                            await page.waitForFunction(() => {
                                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
                                const els = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"], input[type="button"], input[type="submit"]'));
                                return els.some(x => norm(x.innerText || x.textContent || x.value || '').includes('kendim seçmek istiyorum'));
                            }, { timeout: 15000 }).catch(() => {});
                        })
                        .catch(() => {});
                } else {
                    await delay(800);
                }
            }

            if (mode === 'scan') {
                logger.info('categoryBlock:scan_svg_fallback_dropdown', { reason: 'no_seats_in_blocks' });
                proceedToDropdown = true;
            } else {
                throw new Error('SVG bloklarında uygun koltuk bulunamadı');
            }
        }
        }

    // Dropdown path: legacy mode, or scan when SVG not found / failed
    if (!useSvgFlow || proceedToDropdown) {
        await (async () => {
    for (let i = 0; i < getCfg().TIMEOUTS.CATEGORY_SELECTION_RETRIES; i++) {
        const cur = (() => { try { return page.url(); } catch { return ''; } })();
        if (/\/giris(\?|$)/i.test(cur)) throw new Error('Kategori seçimi login sayfasında yapılamaz');
        if (isHomeUrl(cur)) {
            throw new Error('Koltuk seçim sayfasına ulaşılamadı (ana sayfaya yönlendirildi - giriş yapılmamış veya oturum sonlandı)');
        }
        const ok = await page.evaluate(() => {
            const selectBox = document.querySelector('.custom-select-box');
            return selectBox && selectBox.offsetParent !== null;
        });
        if (ok) break;
        await delay(getCfg().DELAYS.CATEGORY_SELECTION);
    }

    const beforeWait = (() => { try { return page.url(); } catch { return ''; } })();
    if (!/\/koltuk-secim/i.test(beforeWait)) {
        if (/\/giris(\?|$)/i.test(beforeWait)) throw new Error('Kategori seçimi login sayfasında yapılamaz');
        throw new Error('Koltuk seçim sayfasına ulaşılamadı (giriş yapılmamış veya oturum sonlandı). Şu an: ' + (beforeWait || 'bilinmiyor'));
    }

    // Step 0: Remove .form-control-disabled overlays that block clicks on Angular form groups
    try {
        await page.evaluate(() => {
            const overlays = document.querySelectorAll('.form-control-disabled');
            for (const el of overlays) {
                try { el.style.setProperty('display', 'none', 'important'); } catch {}
                try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
            }
        });
    } catch {}

    // Step 1: Select "Üyelik / Kampanya Tipi" (membership/campaign type) — required before category options load
    try {
        const membershipResult = await page.evaluate(() => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const selects = Array.from(document.querySelectorAll('select.form-control'));
            // Find the membership/campaign type select (has "Üyelik" or "Kampanya" in placeholder)
            const memberSelect = selects.find(s => {
                const opts = Array.from(s.options || []);
                return opts.some(o => norm(o.textContent).includes('üyelik') || norm(o.textContent).includes('kampanya'));
            });
            if (!memberSelect) return { ok: false, reason: 'no_membership_select' };

            const opts = Array.from(memberSelect.options || []);
            const currentVal = memberSelect.value;
            // If already selected (not placeholder), skip
            if (currentVal && !/^0:\s*null$/i.test(currentVal)) {
                return { ok: true, already: true, value: currentVal, text: norm(memberSelect.options[memberSelect.selectedIndex]?.textContent || '') };
            }

            // Select first non-placeholder option (e.g. "Genel Satış")
            const validOpt = opts.find(o => o.value && !/^0:\s*null$/i.test(o.value) && !o.disabled);
            if (!validOpt) return { ok: false, reason: 'no_valid_option', optionCount: opts.length };

            memberSelect.value = validOpt.value;
            memberSelect.dispatchEvent(new Event('input', { bubbles: true }));
            memberSelect.dispatchEvent(new Event('change', { bubbles: true }));
            // Angular change detection
            try { memberSelect.dispatchEvent(new Event('ngModelChange', { bubbles: true })); } catch {}
            return { ok: true, selected: true, value: validOpt.value, text: norm(validOpt.textContent) };
        });
        logger.info('categoryBlock:membership_type_select', membershipResult);

        if (membershipResult?.selected) {
            // Wait for Angular to react and populate category options
            await delay(1500);
            // Re-disable overlays that may re-appear after Angular renders
            try {
                await page.evaluate(() => {
                    const overlays = document.querySelectorAll('.form-control-disabled');
                    for (const el of overlays) {
                        try { el.style.setProperty('display', 'none', 'important'); } catch {}
                        try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                    }
                });
            } catch {}
        }
    } catch (e) {
        logger.warn('categoryBlock:membership_type_select_failed', { error: e?.message || String(e) });
    }

    try {
        await page.waitForSelector('.custom-select-box', { visible: true, timeout: 15000 });
    } catch (e) {
        // Some events render category as a native <select> (no .custom-select-box). We'll handle that below.
        const after = (() => { try { return page.url(); } catch { return ''; } })();
        if (/\/giris(\?|$)/i.test(after)) throw new Error('Kategori seçimi login sayfasında yapılamaz');
        if (isHomeUrl(after)) throw new Error('Koltuk seçim sayfasına ulaşılamadı (ana sayfaya yönlendirildi - giriş yapılmamış veya oturum sonlandı)');
    }

    // Prefer native <select> category when present (matches the UI in the screenshot).
    try {
        const didNative = await page.evaluate((catText, altText) => {
            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase();
            const wantCat = norm(catText);
            const wantAlt = norm(altText);

            const isVisible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect?.();
                if (!r || r.width < 2 || r.height < 2) return false;
                const st = window.getComputedStyle(el);
                if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || '1') === 0)) return false;
                return true;
            };

            const selectsAll = Array.from(document.querySelectorAll('select'));
            const selects = selectsAll.filter(isVisible);
            if (!selects.length) return { ok: false, reason: 'no_select' };

            const hasTicketish = (s) => {
                try {
                    const opts = Array.from(s.options || []).map(o => norm(o.textContent || o.innerText || ''));
                    return opts.some(t => t.includes('kategori')) && opts.some(t => /₺|try|tl/i.test(t));
                } catch { return false; }
            };

            // First: try select whose options contain the requested category text.
            const findByDesiredText = (arr) => {
                for (const s of arr) {
                    try {
                        const opts = Array.from(s.options || []);
                        const texts = opts.map(o => norm(o.textContent || o.innerText || ''));
                        const hit = texts.some(t => (wantCat && t.includes(wantCat)) || (wantAlt && t.includes(wantAlt)));
                        if (hit) return s;
                    } catch {}
                }
                return null;
            };

            const pickSelect = findByDesiredText(selects) || selects.find(hasTicketish) || selects.find(s => {
                const id = norm(s.id);
                const name = norm(s.getAttribute('name') || '');
                return id.includes('kategori') || name.includes('kategori') || id.includes('category') || name.includes('category');
            }) || null;
            if (!pickSelect) return { ok: false, reason: 'no_match_select' };

            const opts = Array.from(pickSelect.options || []);
            const texts = opts.map(o => norm(o.textContent || o.innerText || ''));

            let idx = -1;
            idx = texts.findIndex(t => (wantCat && t.includes(wantCat)) || (wantAlt && t.includes(wantAlt)));
            if (idx < 0) return { ok: false, reason: 'no_option' };

            try {
                pickSelect.value = opts[idx].value;
                pickSelect.dispatchEvent(new Event('input', { bubbles: true }));
                pickSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } catch {}
            return { ok: true, idx, selectedText: (opts[idx].textContent || '').trim() };
        }, cat, alt);

        if (didNative?.ok) {
            logger.info('categoryBlock:native_select_used', { selectedText: didNative.selectedText });
            const uiReadyNative = await page.waitForFunction(() => {
                const blocks = document.querySelector('select#blocks');
                const blocksOk = !!(blocks && blocks.options && blocks.options.length > 1);
                const seatBtn = !!document.getElementById('custom_seat_button');
                const seatNodes = document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length;
                return blocksOk || seatBtn || seatNodes > 0;
            }, { timeout: 15000 }).then(() => true).catch(() => false);
            if (uiReadyNative) return;
        }
    } catch {}

    // open dropdown + choose category
    const optSel = '.dropdown-option:not(.disabled), .dropdown-option, [role="option"], .dropdown-menu [role="menuitem"], .dropdown-menu .dropdown-item';
    for (let attempt = 0; attempt < 3; attempt++) {
        // Kategori dropdown'ının açılmasını engelleyebilecek overlay/modal'ları kapatmayı dene
        try {
            await page.evaluate(() => {
                // swal2 modal
                const swal = document.querySelector('.swal2-container.swal2-shown');
                if (swal) {
                    const btn = swal.querySelector('button.swal2-confirm, button.swal2-cancel, button');
                    try { btn?.click(); } catch {}
                }
                // cookie/consent
                const cookieBtn = Array.from(document.querySelectorAll('button, a'))
                    .find(b => {
                        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                        return t.includes('kabul') || t.includes('accept') || t.includes('anladım') || t.includes('tamam');
                    });
                try { cookieBtn?.click(); } catch {}

                // EFILLI cookie overlay (custom element + shadow DOM) can block clicks.
                const norm = (s) => (s || '').toString().trim().toLowerCase();
                const isActionText = (t) => {
                    const x = norm(t);
                    return (
                        x.includes('kabul') ||
                        x.includes('accept') ||
                        x.includes('onay') ||
                        x.includes('tamam') ||
                        x.includes('agree') ||
                        x.includes('allow') ||
                        x.includes('kapat') ||
                        x.includes('close')
                    );
                };
                const walkShadow = (root, visit) => {
                    if (!root) return;
                    visit(root);
                    const all = Array.from(root.querySelectorAll('*'));
                    for (const el of all) {
                        const sr = el && el.shadowRoot;
                        if (sr) walkShadow(sr, visit);
                    }
                };

                const tryClickActions = (root) => {
                    if (!root) return false;
                    const btns = Array.from(root.querySelectorAll('button, a, div[role="button"], span[role="button"], [aria-label]'));
                    for (const el of btns) {
                        const t = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
                        if (!isActionText(t)) continue;
                        try { el.click(); } catch {}
                        return true;
                    }
                    return false;
                };

                const disableOverlayEl = (el) => {
                    if (!el || !el.style) return;
                    try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                    try { el.style.setProperty('visibility', 'hidden', 'important'); } catch {}
                    try { el.style.setProperty('display', 'none', 'important'); } catch {}
                };

                const efs = Array.from(document.querySelectorAll('efilli-layout-dynamic, efilli-layout, efilli-consent, [id*="efilli" i], [class*="efilli" i]'));
                let clicked = false;
                for (const ef of efs) {
                    if (!clicked) {
                        clicked = tryClickActions(ef.shadowRoot) || false;
                        if (!clicked) {
                            try {
                                walkShadow(ef.shadowRoot, (sr) => {
                                    if (!clicked) clicked = tryClickActions(sr) || clicked;
                                });
                            } catch {}
                        }
                    }
                    // Always disable; overlay sometimes re-mounts or ignores click
                    disableOverlayEl(ef);
                }

                if (!clicked) {
                    // If still blocking the center point, disable that element too.
                    const box = document.querySelector('.custom-select-box');
                    const r = box ? box.getBoundingClientRect() : null;
                    const cx = r ? (r.left + r.width / 2) : null;
                    const cy = r ? (r.top + r.height / 2) : null;
                    const topEl = (cx != null && cy != null) ? document.elementFromPoint(cx, cy) : null;
                    if (topEl && /^EFILLI/i.test(topEl.tagName || '')) {
                        disableOverlayEl(topEl);
                        try { disableOverlayEl(topEl.closest('efilli-layout-dynamic, efilli-layout, efilli-consent')); } catch {}
                    }
                }
            });
        } catch {}

        // ESC fallback: bazı overlay/modallar click yemeden kapanıyor
        try { await page.keyboard.press('Escape'); } catch {}

        // Remove .form-control-disabled overlay before each click attempt
        try {
            await page.evaluate(() => {
                document.querySelectorAll('.form-control-disabled').forEach(el => {
                    try { el.style.setProperty('display', 'none', 'important'); } catch {}
                    try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                });
            });
        } catch {}

        // Click .custom-select-box to open the category dropdown
        let optTexts = [];
        let options = [];
        try {
            // Primary: Angular-compatible evaluate click
            await page.evaluate(() => {
                const box = document.querySelector('.custom-select-box');
                if (!box) return;
                try { box.scrollIntoView({ block: 'center' }); } catch {}
                box.click();
            });
            await delay(300);

            // Check if options appeared
            let hasOpts = await page.evaluate((sel) => document.querySelectorAll(sel).length > 0, optSel).catch(() => false);

            // Fallback: real mouse click if evaluate click didn't work
            if (!hasOpts) {
                const box = await page.$('.custom-select-box');
                const bb = box ? await box.boundingBox() : null;
                if (bb) {
                    await page.mouse.click(bb.x + (bb.width / 2), bb.y + (bb.height / 2), { delay: 50 });
                    await delay(300);
                }
            }
        } catch {}
        try {
            await page.waitForSelector(optSel, { visible: true, timeout: 5000 });
            optTexts = await page.$$eval(optSel, els => els.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean));
            options = await page.$$(optSel);
        } catch (e) {
            if (isPageContextGone(e)) throw e;
            // Diagnostic: what's actually inside .custom-select-box after click?
            const clickDiag = await page.evaluate(() => {
                const box = document.querySelector('.custom-select-box');
                if (!box) return { boxExists: false };
                const children = Array.from(box.querySelectorAll('*')).map(el => ({
                    tag: el.tagName,
                    cls: (el.className || '').toString().slice(0, 60),
                    text: (el.textContent || '').trim().slice(0, 80),
                    visible: el.offsetParent !== null
                })).slice(0, 20);
                const overlay = document.querySelector('.form-control-disabled');
                const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
                return {
                    boxExists: true,
                    boxText: (box.textContent || '').trim().slice(0, 200),
                    childCount: box.querySelectorAll('*').length,
                    children,
                    overlayDisplay: overlayStyle?.display || 'N/A',
                    overlayPointerEvents: overlayStyle?.pointerEvents || 'N/A'
                };
            }).catch(() => ({}));
            logger.warn('categoryBlock:dropdown_options_missing', { attempt: attempt + 1, error: e?.message || String(e), clickDiag });
        }

        if (!options || !options.length || !optTexts || !optTexts.length) {
            await delay(600);
            continue;
        }

        // Read previously tried categories from page state
        const triedSet = await page.evaluate(() => {
            try { return Array.from(window.__passobotTriedCategories || []); } catch { return []; }
        }).catch(() => []);

        // Build priority-sorted list: preferred → alternative → available rest → unavailable rest
        const validOpts = optTexts
            .map((text, i) => {
                const t = String(text || '').trim().toLowerCase();
                const firstLine = String(text || '').split('\n')[0].trim();
                const isUnavailable = t.includes(UNAVAILABLE_TEXT);
                return { text, firstLine, i, isUnavailable };
            })
            .filter(o => {
                const t = String(o.text || '').trim().toLowerCase();
                if (!t || t === 'kategori') return false;
                return true;
            });

        // Sort: preferred first, alternative second, available before unavailable, then original order
        const sorted = validOpts.sort((a, b) => {
            const aText = String(a.text || '');
            const bText = String(b.text || '');
            const aIsPref = reCat.test(aText) ? 0 : (reAlt && reAlt.test(aText) ? 1 : 2);
            const bIsPref = reCat.test(bText) ? 0 : (reAlt && reAlt.test(bText) ? 1 : 2);
            if (aIsPref !== bIsPref) return aIsPref - bIsPref;
            // Available before unavailable
            if (a.isUnavailable !== b.isUnavailable) return a.isUnavailable ? 1 : -1;
            return a.i - b.i;
        });

        // Filter out already tried categories (but keep them if all have been tried → reset)
        let candidates = sorted.filter(o => !triedSet.includes(String(o.firstLine || o.text || '').trim()));
        if (!candidates.length) {
            // All categories tried → reset and try again
            await page.evaluate(() => { try { window.__passobotTriedCategories = new Set(); } catch {} }).catch(() => {});
            candidates = sorted;
        }

        if (!candidates.length) {
            await delay(600);
            continue;
        }

        const availableCount = candidates.filter(c => !c.isUnavailable).length;
        const unavailableCount = candidates.filter(c => c.isUnavailable).length;
        logger.info('categoryBlock:candidates', {
            total: validOpts.length,
            available: availableCount,
            unavailable: unavailableCount,
            tried: triedSet.length,
            trying: candidates.map(c => c.firstLine).slice(0, 6),
            mode
        });

        // Try each candidate category until one has blocks/seats
        let categoryFound = false;
        for (let ci = 0; ci < candidates.length; ci++) {
            const candidate = candidates[ci];
            const { text: selectedText, firstLine, i: idx, isUnavailable } = candidate;
            const btn = options[idx] || null;
            if (!btn) continue;

            // UI status: show which category is being checked
            logger.info(`📋 Kategori kontrol ediliyor [${ci + 1}/${candidates.length}]: ${firstLine}${isUnavailable ? ' (bilet yok işaretli)' : ''}`, {
                category: firstLine,
                index: ci + 1,
                total: candidates.length,
                unavailable: isUnavailable,
                mode
            });

            // Click the category option
            try { await btn.click(); } catch {}
            try {
                const bb = await btn.boundingBox();
                if (bb) {
                    await page.mouse.move(bb.x + (bb.width / 2), bb.y + (bb.height / 2));
                    await page.mouse.down();
                    await page.mouse.up();
                }
            } catch {}

            // Mark as tried (use firstLine for consistent tracking)
            await page.evaluate((txt) => {
                try {
                    if (!window.__passobotTriedCategories) window.__passobotTriedCategories = new Set();
                    window.__passobotTriedCategories.add(String(txt || '').trim());
                } catch {}
            }, firstLine).catch(() => {});

            // Verify selection reflected in UI (compare firstLine only, not full multiline text)
            // Unavailable categories may be rejected by Angular → shorter timeout
            const verifyTimeout = isUnavailable ? 2000 : 5000;
            let selectionOk = false;
            try {
                await page.waitForFunction((txt) => {
                    const sel = document.querySelector('.custom-select-box .selected-option');
                    const v = (sel?.innerText || sel?.textContent || '').trim().toLowerCase();
                    if (!v || v === 'kategori') return false;
                    return v.includes(String(txt || '').trim().toLowerCase());
                }, { timeout: verifyTimeout }, firstLine);
                selectionOk = true;
            } catch {}

            if (!selectionOk) {
                logger.info(`⏭️ Kategori atlandı: ${firstLine}${isUnavailable ? ' — uygun bilet yok' : ' — seçim yapılamadı'}`, {
                    category: firstLine, unavailable: isUnavailable
                });
                continue;
            }

            // Wait for blocks/seats to load for this category
            const uiReady = await page.waitForFunction(() => {
                const blocks = document.querySelector('select#blocks');
                const blocksOk = !!(blocks && blocks.options && blocks.options.length > 1);
                const seatBtn = !!document.getElementById('custom_seat_button');
                const seatNodes = document.querySelectorAll('svg.seatmap-svg g[id^="seat"] rect').length;
                return blocksOk || seatBtn || seatNodes > 0;
            }, { timeout: 8000 }).then(() => true).catch(() => false);

            if (uiReady) {
                logger.info(`✅ Kategori seçildi: ${firstLine} — bloklar yüklendi`, { category: firstLine, idx });
                categoryFound = true;
                break;
            }

            // This category has no blocks/seats → try next
            logger.info(`❌ Kategori boş: ${firstLine} — blok/koltuk bulunamadı, sonraki deneniyor`, {
                category: firstLine, unavailable: isUnavailable
            });

            // Re-open dropdown for next candidate
            if (ci < candidates.length - 1) {
                try {
                    await page.evaluate(() => {
                        document.querySelectorAll('.form-control-disabled').forEach(el => {
                            try { el.style.setProperty('display', 'none', 'important'); } catch {}
                            try { el.style.setProperty('pointer-events', 'none', 'important'); } catch {}
                        });
                        const box = document.querySelector('.custom-select-box');
                        if (box) { box.scrollIntoView({ block: 'center' }); box.click(); }
                    });
                    await delay(400);
                    // Re-read options (they may have changed)
                    try {
                        const newOpts = await page.$$eval(optSel, els => els.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean));
                        if (newOpts.length) {
                            optTexts.splice(0, optTexts.length, ...newOpts);
                            const newHandles = await page.$$(optSel);
                            options.splice(0, options.length, ...newHandles);
                        }
                    } catch {}
                } catch {}
            }
        }

        if (categoryFound) break;

        // All categories checked, none had seats
        if (!categoryFound && candidates.length > 0) {
            logger.info(`⚠️ Tüm kategoriler kontrol edildi (${candidates.length} adet) — hiçbirinde uygun koltuk bulunamadı, tekrar denenecek`, {
                checkedCount: candidates.length,
                categories: candidates.map(c => c.firstLine)
            });
        }
        await delay(600);
    }

    const blocksTimeout = Math.max(getCfg().TIMEOUTS.BLOCKS_WAIT_TIMEOUT || 0, 10000);
    logger.info('categoryBlock:waiting_for_blocks', { blocksTimeout });
    let blocksReady = false;
    let lastBlocksDiag = null;
    for (let a = 0; a < 2; a++) {
        try {
            await page.waitForFunction(() => {
                const s = document.querySelector('select#blocks');
                return s && s.options && s.options.length > 1;
            }, { timeout: blocksTimeout });
            blocksReady = true;
            break;
        } catch (e) {
            if (isPageContextGone(e)) throw e;
            lastBlocksDiag = await page.evaluate(() => {
                const s = document.querySelector('select#blocks');
                return {
                    hasBlocksSelect: !!s,
                    optionLen: s?.options?.length || 0,
                    firstValues: s ? Array.from(s.options).slice(0, 5).map(o => String(o.value || '')) : [],
                    url: location.href,
                    title: document.title,
                    hasTurnstileWidget: !!document.querySelector('.cf-turnstile'),
                    hasTurnstileTokenField: !!document.querySelector('input[name="cf-turnstile-response"]')
                };
            });
            logger.warn('categoryBlock:blocks_wait_timeout', { attempt: a + 1, blocksTimeout, diag: lastBlocksDiag, error: e?.message || String(e) });
            await delay(600);
        }
    }

    if (!blocksReady) {
        logger.warn('categoryBlock:blocks_not_ready_continue', { diag: lastBlocksDiag });
        return;
    }

    await page.evaluate(() => {
        const s = document.querySelector('select#blocks');
        if (!s) return;
        const valid = [...s.options].filter(o => o.value && !/0:\s*null/i.test(o.value));
        if (valid.length) {
            const r = valid[Math.floor(Math.random() * valid.length)];
            s.value = r.value;
            s.dispatchEvent(new Event('change', {bubbles: true}));
        }
    });
        })();
    }
}

async function startBot(req, res) {
    // Input validation
    let validatedData;
    try {
        validatedData = botRequestSchema.parse(req.body);
    } catch (error) {
        // Zod validation hatası
        if (error.issues && Array.isArray(error.issues)) {
            logger.warnSafe('Validation hatası', { 
                errors: error.issues,
                body: req.body 
            });
            return res.status(400).json({
                error: formatError('VALIDATION_ERROR'),
                details: error.issues.map(e => ({
                    path: e.path.join('.'),
                    message: e.message,
                    code: e.code
                }))
            });
        }
        logger.errorSafe('Validation hatası (beklenmeyen format)', error, { body: req.body });
        return res.status(400).json({error: formatError('INVALID_REQUEST_DATA')});
    }

    const runCfg = configRoot.createRunConfigFromOverrides(validatedData.panelSettings);
    return withRunCfg(runCfg, async () => {
        return startBotAfterValidation(req, res, validatedData);
    });
}

async function startBotAfterValidation(req, res, validatedData) {
    logger.info('Bot start request payload', sanitizeStartRequestForLog(req?.body || validatedData || {}));

    const {
        team: requestedTeam, teamId, ticketType, eventAddress, categoryType, alternativeCategory,
        categorySelectionMode,
        seatSelectionMode,
        transferTargetEmail,
        ticketCount = 1,
        extendWhenRemainingSecondsBelow,
        useProxyPool = true,
        prioritySale, fanCardCode, identity, sicilNo, priorityTicketCode, priorityPhone, priorityTckn,
        email, password,
        cardHolder = null, cardNumber = null, expiryMonth = null, expiryYear = null, cvv = null,
        proxyHost, proxyPort, proxyUsername, proxyPassword,
        email2, password2,
        aAccounts, bAccounts,
        aCredentialIds, bCredentialIds,
        selectedCategoryIds, selectedCategories: requestedSelectedCategories,
        selectedBlockIds
    } = validatedData;

    const selectedCategoriesFromBody = Array.isArray(requestedSelectedCategories)
        ? requestedSelectedCategories.map((item) => normalizeSelectedCategory(item, categorySelectionMode)).filter(Boolean)
        : [];
    const selectedCategoryIdsSafe = Array.isArray(selectedCategoryIds) ? selectedCategoryIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const selectedBlockIdsSafe = Array.isArray(selectedBlockIds) ? selectedBlockIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const aCredentialIdsSafe = Array.isArray(aCredentialIds) ? aCredentialIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const bCredentialIdsSafe = Array.isArray(bCredentialIds) ? bCredentialIds.map((id) => String(id).trim()).filter(Boolean) : [];

    const teamDoc = teamId ? await teamRepo.getTeamById(teamId).catch(() => null) : null;
    if (teamId && !teamDoc) {
        return res.status(400).json({ error: 'Seçilen takım bulunamadı' });
    }
    const team = String(teamDoc?.name || requestedTeam || '').trim();

    let selectedCategories = selectedCategoriesFromBody;
    if (!selectedCategories.length && teamId && selectedCategoryIdsSafe.length) {
        const repoCategories = await categoryRepo.getCategoriesByIds(teamId, selectedCategoryIdsSafe);
        if (repoCategories.length !== selectedCategoryIdsSafe.length) {
            return res.status(400).json({ error: 'Seçilen kategorilerden biri bulunamadı veya aktif değil' });
        }
        selectedCategories = repoCategories
            .map((item) => normalizeSelectedCategory({
                id: item.id,
                label: item.label,
                categoryType: item.categoryTypeValue,
                alternativeCategory: item.alternativeCategoryValue,
                selectionModeHint: item.selectionModeHint,
                sortOrder: item.sortOrder,
                ticketCount: item.ticketCount,
                adjacentSeats: item.adjacentSeats,
                svgBlockId: item.svgBlockId
            }, categorySelectionMode))
            .filter(Boolean);
    }
    if (!selectedCategories.length && String(categoryType || '').trim()) {
        const fallbackCategory = normalizeSelectedCategory({
            label: String(categoryType || '').trim(),
            categoryType,
            alternativeCategory,
            selectionModeHint: categorySelectionMode
        }, categorySelectionMode);
        if (fallbackCategory) selectedCategories = [fallbackCategory];
    }

    const resolvedCategoryType = selectedCategories[0]?.categoryType || String(categoryType || '').trim();
    const resolvedAlternativeCategory = selectedCategories[0]?.alternativeCategory || String(alternativeCategory || '').trim();

    // ── Blok çözümleme ──────────────────────────────────────────────────────
    let selectedBlocks = [];
    if (teamId && selectedBlockIdsSafe.length) {
        const repoBlocks = await blockRepo.getBlocksByIds(teamId, selectedBlockIdsSafe);
        selectedBlocks = repoBlocks.map(normalizeSelectedBlock).filter(Boolean);
    }

    let aList;
    let bList;
    let hasRealB;
    const warmLists = accountListsWarmCache.get(validatedData);
    if (warmLists) {
        try { accountListsWarmCache.delete(validatedData); } catch {}
        aList = warmLists.aList;
        bList = warmLists.bList;
        hasRealB = warmLists.hasRealB;
    } else {
        const built = await buildCredentialBackedAccountLists(validatedData);
        if (!built.ok) {
            return res.status(400).json({ error: built.error });
        }
        aList = built.aList;
        bList = built.bList;
        hasRealB = built.hasRealB;
        const divanMess = validateDivanPriorityAccounts(aList, bList, hasRealB, validatedData.prioritySale, validatedData.sicilNo, validatedData.priorityTicketCode);
        if (divanMess) {
            return res.status(400).json({ error: divanMess });
        }
        const gsPlusMess = validateGsPlusPremiumAccounts(aList, bList, hasRealB, validatedData.prioritySale, validatedData.priorityPhone);
        if (gsPlusMess) {
            return res.status(400).json({ error: gsPlusMess });
        }
        const gsParaMess = validateGsParaPriorityAccounts(aList, bList, hasRealB, validatedData.prioritySale, validatedData.identity, validatedData.priorityTckn);
        if (gsParaMess) {
            return res.status(400).json({ error: gsParaMess });
        }
    }

    // emailA/passwordA her zaman aList'ten al — DB credentialIds de dahil
    // let: multi-mode C finalize pair seciminde yeniden ataniyorlar
    const a0 = aList[0] || null;
    const b0 = bList[0] || null;
    let emailA = (a0?.email || '').toString();
    let passwordA = (a0?.password || '').toString();
    let emailB = (b0?.email || '').toString();
    let passwordB = (b0?.password || '').toString();

    const isMulti = (aList.length > 1) || (bList.length > 1);
    const hasCardInfo = !!(cardHolder && cardNumber && expiryMonth && expiryYear && cvv);
    const categoryRoamTexts = buildCategoryRoamTexts(selectedCategories, resolvedCategoryType, resolvedAlternativeCategory);

    const runId = (() => {
        try {
            const header = (typeof req?.get === 'function') ? req.get('x-run-id') : null;
            const safe = runStore.safeRunId(header);
            if (safe) return safe;
        } catch {}
        try { return randomUUID(); } catch { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
    })();
    const runProfileStamp = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const runProfileKey = String(runId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const buildRunUserDataDir = (baseDir, label) => {
        const base = String(baseDir || '').trim();
        if (!base) return base;
        const suffix = `run-${runProfileKey}-${runProfileStamp}-${String(label || 'X')}`;
        const hasTrailingSep = /[\\\/]$/.test(base);
        return `${base}${hasTrailingSep ? '' : '/'}${suffix}`;
    };
    const userDataDirA = buildRunUserDataDir(getCfg().USER_DATA_DIR_A, 'A');
    const userDataDirB = buildRunUserDataDir(getCfg().USER_DATA_DIR_B, 'B');
    const userDataDirC = buildRunUserDataDir(getCfg().USER_DATA_DIR_B, 'C');
    const audit = (event, meta = {}, level = 'info') => {
        const payload = {
            runId,
            event,
            ts: new Date().toISOString(),
            ...meta
        };
        try {
            if (level === 'warn') return logger.warnSafe('audit', payload);
            if (level === 'error') return logger.errorSafe('audit', meta?.error || payload?.error || 'error', payload);
            return logger.infoSafe('audit', payload);
        } catch {
            try { logger.info('audit', payload); } catch {}
        }
    };

    try {
        const prevRun = runStore.get(runId) || {};
        runStore.upsert(runId, {
            ...prevRun,
            status: prevRun.status === 'completed' || prevRun.status === 'error' ? prevRun.status : 'running',
            teamId: teamId || prevRun.teamId || null,
            eventAddress: String(eventAddress || '').slice(0, 800) || prevRun.eventAddress || null,
            runMode: isMulti ? 'multi' : 'single',
            pendingHotAccounts: {
                aCredentialIds: Array.isArray(prevRun.pendingHotAccounts?.aCredentialIds)
                    ? prevRun.pendingHotAccounts.aCredentialIds
                    : [],
                payerACredentialIds: Array.isArray(prevRun.pendingHotAccounts?.payerACredentialIds)
                    ? prevRun.pendingHotAccounts.payerACredentialIds
                    : [],
                transferACredentialIds: Array.isArray(prevRun.pendingHotAccounts?.transferACredentialIds)
                    ? prevRun.pendingHotAccounts.transferACredentialIds
                    : []
            }
        });
    } catch {}

    const attachProtocolToHost = (host, fallbackProtocol = 'socks5') => {
        const h = String(host || '').trim();
        if (!h) return '';
        if (/^(http|https|socks4|socks5):\/\//i.test(h)) return h;
        return `${String(fallbackProtocol || 'socks5').toLowerCase()}://${h}`;
    };

    const manualProxyConfigured = !!(String(proxyHost || '').trim() && String(proxyPort || '').trim());
    const manualProxyLaunchConfig = manualProxyConfigured
        ? {
            proxyHost: attachProtocolToHost(proxyHost, 'socks5'),
            proxyPort,
            proxyUsername,
            proxyPassword
        }
        : null;
    const shouldUseProxyPool = useProxyPool !== false;

    /** Tek listede tek hesap ve tekli (çift) mod; birden fazla A/B veya çoklu mod değil — finalize C vb. sonradan ek tarayıcı sayılmaz. */
    const onlyOneListedAccountSlot = !isMulti && (aList.length + bList.length) <= 1;

    let managedProxyLaunchSerial = 0;

    /** Bu koşuda havuzdan kaç tarayıcı açılacağına dair tahmin (A+B listeleri; finalize C ayrıca +1 olabilir). */
    const estimatedBrowsersUsingPool = Math.max(1, (aList?.length || 0) + (bList?.length || 0));

    let proxyPoolLayoutAudited = false;
    let poolAssignableCountSnapshot = null;

    const auditProxyPoolLayoutOnce = async () => {
        if (proxyPoolLayoutAudited) return;
        proxyPoolLayoutAudited = true;
        try {
            const assignableProxyCount = await proxyRepo.countAssignableProxies();
            poolAssignableCountSnapshot = assignableProxyCount;
            const estimatedLaunches = estimatedBrowsersUsingPool;
            const singleProxyAllBrowsersShare = assignableProxyCount === 1 && estimatedLaunches > 1;
            const underprovisioned = assignableProxyCount > 0 && assignableProxyCount < estimatedLaunches;
            audit('proxy_pool_scan', {
                runId,
                assignableProxyCount,
                estimatedBrowserLaunches: estimatedLaunches,
                singleProxyAllBrowsersShare,
                underprovisioned,
                distributionMode: 'least_recently_used',
                note: 'Paralel açılışlarda aynı anda farklı proxy; tek proxy varsa tüm tarayıcılar mecburen paylaşır.'
            });
        } catch (e) {
            audit('proxy_pool_scan_failed', { runId, error: e?.message || String(e) }, 'warn');
        }
    };

    const launchAndLoginWithManagedProxy = async (baseOpts, meta = {}) => {
        const opts = baseOpts && typeof baseOpts === 'object' ? { ...baseOpts } : {};
        opts.runId = runId;
        managedProxyLaunchSerial += 1;
        const role = String(meta.role || '').trim();
        const idx = Number.isFinite(Number(meta.idx)) ? Number(meta.idx) : null;
        const emailForLog = String(opts.email || meta.email || '').trim();
        let activeProxy = null;
        let fromPool = false;

        // Paneldeki tek manuel proxy yalnızca tek tarayıcılı koşuda (tek A/B kaydı); aksi halde her launch havuzdan ayrı proxy.
        const useManualSingleBrowserOnly = !!(
            manualProxyLaunchConfig &&
            managedProxyLaunchSerial === 1 &&
            onlyOneListedAccountSlot
        );

        if (useManualSingleBrowserOnly) {
            Object.assign(opts, manualProxyLaunchConfig);
            audit('proxy_selected', {
                runId,
                role,
                idx,
                email: emailForLog,
                source: 'manual',
                proxyId: null,
                proxy: `${manualProxyLaunchConfig.proxyHost}:${manualProxyLaunchConfig.proxyPort}`,
                protocol: 'manual'
            });
            try {
                return await launchAndLogin(opts);
            } catch (error) {
                throw error;
            }
        }

        if (manualProxyLaunchConfig && !useManualSingleBrowserOnly) {
            audit('proxy_manual_skipped_multi_browser', {
                runId,
                role,
                idx,
                email: emailForLog,
                launchSerial: managedProxyLaunchSerial,
                reason: 'her_tarayici_ayri_proxy_havuz'
            });
        }

        if (shouldUseProxyPool) {
            const maxPoolAttempts = Math.max(
                1,
                Math.min(8, Number(getCfg()?.TIMEOUTS?.PROXY_POOL_LOGIN_MAX_ATTEMPTS) || 3)
            );
            let lastErr = null;
            for (let poolAttempt = 1; poolAttempt <= maxPoolAttempts; poolAttempt++) {
                assertLaunchRunNotKilled(runId, `proxy_pool_${poolAttempt}`);
                activeProxy = null;
                fromPool = false;
                try {
                    await auditProxyPoolLayoutOnce();
                } catch {}
                try {
                    activeProxy = await proxyRepo.acquireNextActiveProxy();
                } catch (e) {
                    throw new Error(`Proxy havuzu okunamadi: ${e?.message || String(e)}`);
                }
                if (!activeProxy) {
                    throw new Error('Aktif proxy bulunamadi (proxy havuzu bos ya da blacklistte).');
                }
                fromPool = true;
                Object.assign(opts, {
                    proxyHost: attachProtocolToHost(activeProxy.host, activeProxy.protocol || 'socks5'),
                    proxyPort: activeProxy.port,
                    proxyUsername: activeProxy.username || '',
                    proxyPassword: activeProxy.password || ''
                });
                const singleShared =
                    poolAssignableCountSnapshot === 1 && estimatedBrowsersUsingPool > 1;
                audit('proxy_selected', {
                    runId,
                    role,
                    idx,
                    email: emailForLog,
                    source: 'pool',
                    proxyId: activeProxy.id,
                    proxy: `${activeProxy.host}:${activeProxy.port}`,
                    protocol: activeProxy.protocol,
                    poolAssignableCount: poolAssignableCountSnapshot,
                    singleProxyPoolShared: singleShared,
                    poolAttempt
                });
                try {
                    const result = await launchAndLogin(opts);
                    if (activeProxy?.id) {
                        try { await proxyRepo.markLoginSuccess(activeProxy.id); } catch {}
                    }
                    return result;
                } catch (error) {
                    if (error && error.code === 'RUN_KILLED') throw error;
                    lastErr = error;
                    const soft = isSoftProxyLoginFailure(error?.message);
                    const retryAnotherProxy =
                        shouldRetryLoginWithAnotherPoolProxy(error?.message) && poolAttempt < maxPoolAttempts;
                    if (activeProxy?.id) {
                        try {
                            const updated = await proxyRepo.markLoginFailure(activeProxy.id, {
                                threshold: 3,
                                reason: error?.message || 'login_failed',
                                soft
                            });
                            audit('proxy_login_failed', {
                                runId,
                                role,
                                idx,
                                email: emailForLog,
                                proxyId: activeProxy.id,
                                proxy: `${activeProxy.host}:${activeProxy.port}`,
                                blacklistedUntil: updated?.blacklistUntil || null,
                                reason: error?.message || String(error),
                                softFailure: soft,
                                poolAttempt,
                                willRetryAnotherProxy: retryAnotherProxy
                            }, 'warn');
                        } catch {}
                    }
                    if (retryAnotherProxy) {
                        audit('proxy_pool_launch_retry', {
                            runId,
                            role,
                            idx,
                            email: emailForLog,
                            poolAttempt,
                            nextAttempt: poolAttempt + 1,
                            retryKind: soft ? 'soft' : 'transport',
                            note: 'launchAndLogin basarisiz: tarayici kapatildi, havuzdan yeni proxy ile tekrar'
                        });
                        await delay(400 + Math.floor(Math.random() * 500));
                        continue;
                    }
                    throw error;
                }
            }
            throw lastErr || new Error('Proxy havuz girisi basarisiz');
        }

        if (manualProxyLaunchConfig && !useManualSingleBrowserOnly) {
            throw new Error(
                'Birden fazla tarayıcı açılıyor; her hesap için farklı proxy kullanılmalıdır. Proxy havuzunu açın ve tarayıcı sayısından az olmayacak kadar aktif proxy ekleyin. (Tek hesap + panelde tek proxy yalnızca tek tarayıcı koşusunda geçerli.)'
            );
        }

        audit('proxy_skipped', {
            runId,
            role,
            idx,
            email: emailForLog,
            reason: 'useProxyPool=false'
        });
        return launchAndLogin(opts);
    };

    let currentHolder = null; // 'A' | 'B'
    let currentSeatInfo = null;
    let currentCatBlock = null;

    /** Arayüz: eşleşme tablosu (GET /run/:id/status → pairDashboard). */
    let dashboardPairs = [];
    const dashboardMeta = { cTargetPairIndex: 1, activePairIndex: null };
    const pairRuntimeByIndex = new Map();
    const pairRecordKeyByIndex = new Map();
    let paymentQueueState = [];
    let paymentQueueActivePairIndex = null;

    const fmtSeatLabel = (si) => {
        if (!si) return '—';
        try {
            const seats = normalizeHeldSeats(si);
            if (seats.length > 1) {
                return seats
                    .map((s) => {
                        if (s.combined) return String(s.combined).trim();
                        const parts = [s.row, s.seat].filter(Boolean).map(String);
                        if (parts.length) return parts.join(' / ');
                        return s.seatId ? String(s.seatId) : '';
                    })
                    .filter(Boolean)
                    .join(' · ');
            }
            const one = seats[0] || si;
            if (one.combined) return String(one.combined).trim();
            const parts = [one.row, one.seat].filter(Boolean).map(String);
            if (parts.length) return parts.join(' / ');
            if (one.seatId) return String(one.seatId);
        } catch {}
        return '—';
    };

    const buildBasketTimingPatch = ({ basketArrivedAtMs = null, remainingSeconds = null, observedAtMs = null } = {}) => {
        const holdingTimeSeconds = Number(getCfg()?.BASKET?.HOLDING_TIME_SECONDS || 600);
        const observed = Number.isFinite(Number(observedAtMs)) ? Math.floor(Number(observedAtMs)) : Date.now();
        const arrived = Number.isFinite(Number(basketArrivedAtMs)) ? Math.floor(Number(basketArrivedAtMs)) : null;
        const remaining = Number.isFinite(Number(remainingSeconds)) ? Math.max(0, Math.floor(Number(remainingSeconds))) : null;
        return {
            basketHoldingTimeSeconds: holdingTimeSeconds,
            basketArrivedAtMs: arrived,
            basketRemainingSeconds: remaining,
            basketObservedAt: remaining != null ? new Date(observed).toISOString() : null
        };
    };

    const resolveRuntimeBasketTiming = (runtime = {}, preferredHolder = '') => {
        const holder = String(preferredHolder || runtime?.currentHolder || '').toUpperCase();
        const source = holder === 'B'
            ? (runtime?.bCtx || {})
            : (runtime?.aCtx || {});
        const arrivedAtMs = source?.basketArrivedAtMs ?? runtime?.basketArrivedAtMs ?? null;
        const remainingSeconds = source?.basketRemainingSeconds ?? runtime?.basketRemainingSeconds ?? null;
        const observedAt = source?.basketObservedAt ?? runtime?.basketObservedAt ?? null;
        return buildBasketTimingPatch({
            basketArrivedAtMs: arrivedAtMs,
            remainingSeconds,
            observedAtMs: observedAt ? Date.parse(String(observedAt)) : null
        });
    };

    const resolveDashboardActivePair = () => {
        const idx = parseInt(String(dashboardMeta.activePairIndex ?? '').trim(), 10);
        if (!Number.isFinite(idx) || idx < 1) return null;
        return dashboardPairs.some((p) => Number(p?.pairIndex) === idx) ? idx : null;
    };

    const upsertPaymentQueueEntry = (entry) => {
        if (!entry || !Number.isFinite(Number(entry.pairIndex))) return null;
        const pairIndex = Math.max(1, Math.floor(Number(entry.pairIndex)));
        const prev = paymentQueueState.find((item) => Number(item.pairIndex) === pairIndex) || {};
        const next = { ...prev, ...entry, pairIndex };
        const without = paymentQueueState.filter((item) => Number(item.pairIndex) !== pairIndex);
        without.push(next);
        without.sort((a, b) => Number(a.pairIndex) - Number(b.pairIndex));
        paymentQueueState = without;
        return next;
    };

    const upsertDashboardPairRow = (pairIndex, patch = {}) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const prev = dashboardPairs.find((row) => Number(row?.pairIndex) === idx) || { pairIndex: idx };
        const next = { ...prev, pairIndex: idx, ...patch };
        const rest = dashboardPairs.filter((row) => Number(row?.pairIndex) !== idx);
        rest.push(next);
        rest.sort((a, b) => Number(a?.pairIndex || 0) - Number(b?.pairIndex || 0));
        dashboardPairs = rest;
        try { syncDashboardToRunStore(); } catch {}
        return next;
    };

    const markPairPaymentState = (pairIndex, patch = {}) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        upsertPaymentQueueEntry({ pairIndex: idx, ...patch });
        upsertDashboardPairRow(idx, patch);
    };

    /** Tek çift + panelde yanlış C eşleşme # ile canlı tutucu/koltuk hiç satıra yazılmamasını önler. */
    const resolveDashboardCTarget = () => {
        let cTarget = Math.max(1, Number(dashboardMeta.cTargetPairIndex) || 1);
        try {
            const st = runStore.get(runId);
            if (st && st.cTransferPairIndex != null) {
                const w = parseInt(String(st.cTransferPairIndex).trim(), 10);
                if (Number.isFinite(w) && w >= 1) cTarget = w;
            }
        } catch {}
        const pairIndices = dashboardPairs
            .map((p) => Number(p.pairIndex))
            .filter((n) => Number.isFinite(n) && n >= 1);
        const transferEligiblePairIndices = dashboardPairs
            .filter((p) => String(p?.aIntent || '').trim().toLowerCase() === 'transfer')
            .map((p) => Number(p.pairIndex))
            .filter((n) => Number.isFinite(n) && n >= 1);
        const maxPair = pairIndices.length ? Math.max(...pairIndices) : 1;
        if (transferEligiblePairIndices.length) {
            if (!transferEligiblePairIndices.includes(cTarget)) {
                cTarget = transferEligiblePairIndices[0];
            }
        } else if (dashboardPairs.length === 1) {
            cTarget = Number(dashboardPairs[0].pairIndex) || 1;
        } else if (cTarget > maxPair) {
            cTarget = maxPair;
        }
        dashboardMeta.cTargetPairIndex = cTarget;
        return cTarget;
    };

    const syncDashboardToRunStore = () => {
        try {
            if (!dashboardPairs.length) return;
            const cTarget = resolveDashboardCTarget();
            const activePair = resolveDashboardActivePair();
            const merged = dashboardPairs.map((p) => {
                const idx = Number(p.pairIndex);
                const isTarget = Number.isFinite(idx) && idx === cTarget;
                const isActivePair = Number.isFinite(idx) && activePair != null && idx === activePair;
                const runtime = pairRuntimeByIndex.get(idx) || null;
                const runtimeTiming = resolveRuntimeBasketTiming(runtime, p?.holder || runtime?.currentHolder || '');
                const row = { ...runtimeTiming, ...p, isCTarget: isTarget, isActivePair };
                try {
                    const aIntentSource = runtime?.aCtx || runtime?.idProfileA || {};
                    row.aIntent = row.aIntent || resolveAIntent(aIntentSource);
                } catch {}
                if (isActivePair || (!activePair && isTarget)) {
                    row.holder = currentHolder;
                    row.seatLabel = fmtSeatLabel(currentSeatInfo) || row.seatLabel || '—';
                    const heldIds = normalizeHeldSeats(currentSeatInfo)
                        .map((s) => s.seatId)
                        .filter(Boolean);
                    row.seatId = heldIds.length > 1
                        ? heldIds.join(', ')
                        : (currentSeatInfo?.seatId ? String(currentSeatInfo.seatId) : row.seatId);
                    if (currentSeatInfo) {
                        row.tribune = currentSeatInfo.tribune ?? row.tribune ?? null;
                        row.seatRow = currentSeatInfo.row ?? row.seatRow ?? null;
                        row.seatNumber = currentSeatInfo.seat ?? row.seatNumber ?? null;
                        if (currentSeatInfo.combinedAll) {
                            row.combinedAll = String(currentSeatInfo.combinedAll).trim();
                        }
                        if (Number.isFinite(Number(currentSeatInfo.itemCount)) && Number(currentSeatInfo.itemCount) >= 2) {
                            const ic = Math.floor(Number(currentSeatInfo.itemCount));
                            row.seatItemCount = ic;
                            row.basketItemCount = ic;
                        }
                    }
                }
                return row;
            });
            runStore.upsert(runId, {
                pairDashboard: {
                    mode: isMulti ? 'multi' : 'single',
                    pairCount: merged.length,
                    cTargetPairIndex: cTarget,
                    activePairIndex: activePair,
                    pairs: merged,
                    updatedAt: new Date().toISOString()
                },
                paymentQueue: {
                    activePairIndex: paymentQueueActivePairIndex,
                    queue: paymentQueueState.map((item) => ({ ...item })),
                    updatedAt: new Date().toISOString()
                }
            });
        } catch {}
    };

    const setHolder = (role, seatInfo, catBlock) => {
        currentHolder = role;
        if (seatInfo) currentSeatInfo = seatInfo;
        if (catBlock) currentCatBlock = catBlock;
        try {
            if (dashboardPairs.length) {
                const cTarget = resolveDashboardCTarget();
                const activePair = resolveDashboardActivePair();
                const targetPair = activePair || cTarget;
                dashboardPairs = dashboardPairs.map((p) => {
                    if (Number(p.pairIndex) !== targetPair) return p;
                    const next = { ...p, holder: role };
                    if (seatInfo) {
                        const ids = normalizeHeldSeats(seatInfo).map((s) => s.seatId).filter(Boolean);
                        next.seatId = ids.length > 1 ? ids.join(', ') : (seatInfo.seatId ? String(seatInfo.seatId) : next.seatId);
                        next.seatLabel = fmtSeatLabel(seatInfo) || next.seatLabel || '—';
                        next.tribune = seatInfo.tribune ?? next.tribune ?? null;
                        next.seatRow = seatInfo.row ?? next.seatRow ?? null;
                        next.seatNumber = seatInfo.seat ?? next.seatNumber ?? null;
                        if (seatInfo.combinedAll) next.combinedAll = String(seatInfo.combinedAll).trim();
                        if (Number.isFinite(Number(seatInfo.itemCount)) && Number(seatInfo.itemCount) >= 2) {
                            const ic = Math.floor(Number(seatInfo.itemCount));
                            next.seatItemCount = ic;
                            next.basketItemCount = ic;
                        }
                    }
                    return next;
                });
            }
        } catch {}
        try { audit('holder_updated', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null }); } catch {}
        try { syncDashboardToRunStore(); } catch {}
    };

    const getFinalizeRequest = () => {
        try {
            const st = runStore.get(runId);
            if (!st) return { requested: false };
            return {
                requested: !!st.finalizeRequested,
                cAccount: st.cAccount || null,
                finalizeMeta: st.finalizeMeta || null,
                cTransferPairIndex: st.cTransferPairIndex ?? 1
            };
        } catch {
            return { requested: false };
        }
    };

    const getPairRecordKey = (pairIndex, seatInfo = null) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const existing = pairRecordKeyByIndex.get(idx);
        if (existing) return existing;
        const seatId = String(
            seatInfo?.seatId ||
            pairRuntimeByIndex.get(idx)?.currentSeatInfo?.seatId ||
            pairRuntimeByIndex.get(idx)?.aCtx?.seatInfo?.seatId ||
            currentSeatInfo?.seatId ||
            `pair-${idx}`
        ).trim();
        const key = `${runId}:${idx}:${seatId || `pair-${idx}`}`;
        pairRecordKeyByIndex.set(idx, key);
        return key;
    };

    const buildOrderRecordPayload = (pairIndex, extra = {}) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx) || {};
        const seat = extra.seat || runtime.currentSeatInfo || runtime.aCtx?.seatInfo || currentSeatInfo || null;
        const category = extra.category || runtime.currentCatBlock || runtime.aCtx?.catBlock || currentCatBlock || null;
        return {
            recordKey: getPairRecordKey(idx, seat),
            runId,
            teamId,
            teamName: team,
            eventUrl: eventAddress,
            ticketType,
            pairIndex: idx,
            sourceRole: extra.sourceRole || runtime.currentHolder || currentHolder || 'A',
            holderRole: extra.holderRole || runtime.currentHolder || currentHolder || '',
            paymentOwnerRole: extra.paymentOwnerRole || '',
            paymentSource: extra.paymentSource !== undefined ? extra.paymentSource : null,
            paymentActorEmail: extra.paymentActorEmail || '',
            paymentState: extra.paymentState || 'none',
            finalizeState: extra.finalizeState || 'none',
            recordStatus: extra.recordStatus || 'basketed',
            aAccountEmail: extra.aAccountEmail || runtime.aCtx?.email || emailA || '',
            bAccountEmail: extra.bAccountEmail || runtime.bCtx?.email || emailB || '',
            cAccountEmail: extra.cAccountEmail || getFinalizeRequest()?.cAccount?.email || '',
            seat,
            category,
            basketStatus: extra.basketStatus || 'in_basket',
            auditMeta: extra.auditMeta || {},
            failureReason: extra.failureReason || '',
            sessionLogs: Array.isArray(extra.sessionLogs) ? extra.sessionLogs : []
        };
    };

    const safePersistOrderRecord = async (label, fn) => {
        try {
            return await fn();
        } catch (error) {
            try { logger.warnSafe(`order_record_${label}_failed`, { runId, error: error?.message || String(error) }); } catch {}
            return null;
        }
    };

    const persistBasketRecordForPair = async (pairIndex, extra = {}) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        let normalizedExtra = { ...extra };
        try {
            const runtime = pairRuntimeByIndex.get(idx) || {};
            const candidatePage =
                runtime?.aCtx?.page ||
                runtime?.bCtx?.page ||
                pageA ||
                pageB ||
                null;
            const incomingSeat = normalizedExtra?.seat || runtime?.currentSeatInfo || runtime?.aCtx?.seatInfo || null;
            const missingSeatDetails = !!incomingSeat && !(
                String(incomingSeat?.row || '').trim() &&
                String(incomingSeat?.seat || '').trim() &&
                String(incomingSeat?.block || '').trim() &&
                String(incomingSeat?.tribune || '').trim()
            );
            if (candidatePage && missingSeatDetails) {
                const basketSeat = await readBasketData(candidatePage).catch(() => null);
                if (basketSeat) {
                    normalizedExtra.seat = {
                        ...incomingSeat,
                        tribune: incomingSeat?.tribune || basketSeat?.tribune || '',
                        block: incomingSeat?.block || basketSeat?.block || '',
                        row: incomingSeat?.row || basketSeat?.row || '',
                        seat: incomingSeat?.seat || basketSeat?.seat || '',
                        blockId: incomingSeat?.blockId || basketSeat?.blockId || '',
                        seatId: incomingSeat?.seatId || basketSeat?.seatId || '',
                        combined: incomingSeat?.combined || basketSeat?.combined || '',
                        itemCount: Math.max(Number(incomingSeat?.itemCount) || 0, Number(basketSeat?.itemCount) || 0),
                        heldSeats: (Array.isArray(incomingSeat?.heldSeats) && incomingSeat.heldSeats.length)
                            ? incomingSeat.heldSeats
                            : (Array.isArray(basketSeat?.heldSeats) ? basketSeat.heldSeats : [])
                    };
                    logger.info('order_record_seat_enriched_from_basket', {
                        pairIndex: idx,
                        seatId: normalizedExtra.seat?.seatId || null,
                        row: normalizedExtra.seat?.row || null,
                        seat: normalizedExtra.seat?.seat || null,
                        block: normalizedExtra.seat?.block || null,
                        tribune: normalizedExtra.seat?.tribune || null
                    });
                }
            }
        } catch (e) {
            logger.warnSafe('order_record_seat_enrich_failed', { pairIndex: idx, error: e?.message || String(e) });
        }
        const payload = buildOrderRecordPayload(idx, normalizedExtra);
        return safePersistOrderRecord('basket_upsert', () => orderRecordRepo.upsertBasketRecord(payload));
    };

    const persistTransferForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, extra);
        return safePersistOrderRecord('transfer', () => orderRecordRepo.markTransfer(payload.recordKey, payload));
    };

    const persistAPaymentReadyForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, extra);
        return safePersistOrderRecord('a_payment_ready', () => orderRecordRepo.markAPaymentReady(payload.recordKey, payload));
    };

    const persistAPaymentCompletedForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, extra);
        return safePersistOrderRecord('a_payment_completed', () => orderRecordRepo.markAPaymentCompleted(payload.recordKey, payload));
    };

    const persistCFinalizeReadyForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, extra);
        return safePersistOrderRecord('c_finalize_ready', () => orderRecordRepo.markCFinalizeReady(payload.recordKey, payload));
    };

    const persistCFinalizeCompletedForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, extra);
        return safePersistOrderRecord('c_finalize_completed', () => orderRecordRepo.markCFinalizeCompleted(payload.recordKey, payload));
    };

    const persistFailureForPair = async (pairIndex, extra = {}) => {
        const payload = buildOrderRecordPayload(pairIndex, {
            ...extra,
            failureReason: extra.failureReason || extra?.auditMeta?.error || '',
            sessionLogs: Array.isArray(extra?.sessionLogs) ? extra.sessionLogs : runLogBufferStore.get(runId)
        });
        return safePersistOrderRecord('failed', () => orderRecordRepo.markFailed(payload.recordKey, payload));
    };

    const updatePairRuntime = (pairIndex, patch = {}) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const prev = pairRuntimeByIndex.get(idx);
        if (!prev) return null;
        const next = { ...prev, ...patch };
        pairRuntimeByIndex.set(idx, next);
        return next;
    };

    const bindPairRuntime = (pairIndex, reason = 'bind') => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx);
        if (!runtime) return null;
        dashboardMeta.activePairIndex = idx;
        paymentQueueActivePairIndex = idx;
        if (runtime.aCtx) {
            browserA = runtime.aCtx.browser || browserA;
            pageA = runtime.aCtx.page || pageA;
            emailA = runtime.aCtx.email || emailA;
            passwordA = runtime.aCtx.password || passwordA;
        }
        if (runtime.bCtx) {
            browserB = runtime.bCtx.browser || browserB;
            pageB = runtime.bCtx.page || pageB;
            emailB = runtime.bCtx.email || emailB;
            passwordB = runtime.bCtx.password || passwordB;
        }
        idProfileA = runtime.idProfileA || aList[idx - 1] || idProfileA;
        idProfileB = runtime.idProfileB || bList[idx - 1] || idProfileB;
        if (runtime.currentCatBlock) currentCatBlock = runtime.currentCatBlock;
        if (runtime.currentSeatInfo) currentSeatInfo = runtime.currentSeatInfo;
        if (runtime.currentHolder) currentHolder = runtime.currentHolder;
        try {
            audit('pair_runtime_bound', {
                pairIndex: idx,
                reason,
                holder: currentHolder || null,
                seatId: currentSeatInfo?.seatId || null,
                aEmail: emailA || null,
                bEmail: emailB || null
            });
        } catch {}
        try { syncDashboardToRunStore(); } catch {}
        return runtime;
    };

    const bindFinalizePairFromRunState = () => {
        const fin = getFinalizeRequest();
        const idx = Math.max(1, Math.floor(Number(fin?.cTransferPairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx) || null;
        if (runtime && resolveAIntent(runtime?.aCtx || runtime?.idProfileA || {}) !== 'transfer') {
            throw new Error(`FINALIZE_PAIR_NOT_TRANSFER_ELIGIBLE:${idx}`);
        }
        return bindPairRuntime(idx, 'finalize');
    };

    const preparePaymentOnA = async (pairIndex, seatInfoForA = currentSeatInfo) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        if (!pageA) throw new Error(`A_PAYMENT_PAGE_MISSING:${idx}`);
        const runtime = pairRuntimeByIndex.get(idx) || null;
        const paymentIdentity = String(runtime?.idProfileA?.identity || idProfileA?.identity || identity || priorityTckn || '').trim();
        const isOnPaymentUrl = () => {
            try { return /\/odeme(\b|\/|\?|#)/i.test(String(pageA.url() || '')); } catch { return false; }
        };
        const waitForPaymentIframe = async (timeout = 15000) => {
            const iframe = await pageA.waitForSelector('iframe#payment_nkolay_frame', { timeout }).catch(() => null);
            return !!iframe;
        };
        markPairPaymentState(idx, {
            paymentOwnerRole: 'A',
            paymentEligible: true,
            paymentState: hasCardInfo ? 'preparing' : 'waiting',
            phase: hasCardInfo ? 'A ödeme sayfası hazırlanıyor' : 'A sepette tutuluyor'
        });

        if (!basketTimer) basketTimer = new BasketTimer();
        try { basketTimer.start(); } catch {}
        setHolder('A', seatInfoForA, currentCatBlock);

        if (!hasCardInfo) {
            updatePairRuntime(idx, { currentHolder: 'A', currentSeatInfo: seatInfoForA, currentCatBlock });
            return { ok: true, payment: 'no_card' };
        }

        if (!/^\d{11}$/.test(paymentIdentity)) {
            throw new Error(`A_PAYMENT_IDENTITY_REQUIRED:${idx}`);
        }

        setStep(`PAIR${idx}.A.payment.tcAssign.start`);
        const okTcAssign = await ensureTcAssignedOnBasket(pageA, paymentIdentity, { preferAssignToMyId: true, maxAttempts: 4 });
        setStep(`PAIR${idx}.A.payment.tcAssign.done`, { ok: !!okTcAssign });
        try { audit('a_payment_tc_assign', { pairIndex: idx, aEmail: emailA, seatId: seatInfoForA?.seatId || null, ok: !!okTcAssign }); } catch {}
        if (!okTcAssign) {
            throw new Error(`A_PAYMENT_TC_ASSIGN_FAILED:${idx}`);
        }

        setStep(`PAIR${idx}.A.payment.devamToOdeme.start`);
        const clickedContinue = await clickBasketDevamToOdeme(pageA);
        if (!clickedContinue) {
            throw new Error(`A_PAYMENT_CONTINUE_CLICK_FAILED:${idx}`);
        }
        if (!isOnPaymentUrl()) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                const didDismiss = await dismissPaymentInfoModalIfPresent(pageA).catch(() => false);
                if (isOnPaymentUrl()) break;
                if (!didDismiss) {
                    await pageA.waitForFunction(() => /\/odeme(\b|\/|\?|#)/i.test(String(location.href || '')), { timeout: 4000 }).catch(() => {});
                }
                if (isOnPaymentUrl()) break;
            }
        }
        setStep(`PAIR${idx}.A.payment.devamToOdeme.done`, { url: (() => { try { return pageA.url(); } catch { return null; } })(), ok: isOnPaymentUrl() });
        if (!isOnPaymentUrl()) {
            throw new Error(`A_PAYMENT_CONTINUE_BLOCKED:${idx}`);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            const dismissed = await dismissPaymentInfoModalIfPresent(pageA).catch(() => false);
            if (!dismissed) break;
        }

        let iframeReady = await waitForPaymentIframe(4000);
        if (!iframeReady) {
            setStep(`PAIR${idx}.A.payment.invoiceTc.start`);
            const okInvoice = await fillInvoiceTcAndContinue(pageA, paymentIdentity);
            setStep(`PAIR${idx}.A.payment.invoiceTc.done`, { ok: !!okInvoice });
            try { audit('a_payment_invoice_tc', { pairIndex: idx, aEmail: emailA, seatId: seatInfoForA?.seatId || null, ok: !!okInvoice }); } catch {}
            for (let attempt = 1; attempt <= 2; attempt++) {
                const dismissed = await dismissPaymentInfoModalIfPresent(pageA).catch(() => false);
                if (!dismissed) break;
            }
            iframeReady = await waitForPaymentIframe(6000);
        }

        if (!iframeReady) {
            setStep(`PAIR${idx}.A.payment.agreements.start`);
            const okAgreements = await acceptAgreementsAndContinue(pageA);
            setStep(`PAIR${idx}.A.payment.agreements.done`, { ok: !!okAgreements });
            try { audit('a_payment_agreements', { pairIndex: idx, aEmail: emailA, seatId: seatInfoForA?.seatId || null, ok: !!okAgreements }); } catch {}
            iframeReady = await waitForPaymentIframe(12000);
        }

        if (!iframeReady) {
            throw new Error(`A_PAYMENT_IFRAME_NOT_READY:${idx}`);
        }

        const cardData = { cardHolder, cardNumber, expiryMonth, expiryYear, cvv };
        setStep(`PAIR${idx}.A.payment.iframeFill.start`);
        const okIframe = await fillNkolayPaymentIframe(pageA, cardData, { clickPay: false });
        setStep(`PAIR${idx}.A.payment.iframeFill.done`, { ok: !!okIframe });
        try { audit('a_payment_iframe_filled', { pairIndex: idx, aEmail: emailA, seatId: seatInfoForA?.seatId || null, ok: !!okIframe }); } catch {}
        if (!okIframe) {
            throw new Error(`A_PAYMENT_IFRAME_FILL_FAILED:${idx}`);
        }

        markPairPaymentState(idx, {
            paymentOwnerRole: 'A',
            paymentEligible: true,
            paymentState: 'ready',
            phase: 'A ödeme sayfası hazır'
        });
        updatePairRuntime(idx, { currentHolder: 'A', currentSeatInfo: seatInfoForA, currentCatBlock });
        await persistAPaymentReadyForPair(idx, {
            holderRole: 'A',
            paymentOwnerRole: 'A',
            paymentSource: 'A',
            paymentActorEmail: emailA,
            paymentState: hasCardInfo ? 'a_ready' : 'none',
            recordStatus: hasCardInfo ? 'payment_ready' : 'basketed',
            aAccountEmail: emailA,
            seat: seatInfoForA,
            category: currentCatBlock,
            auditMeta: {
                phase: 'a_payment_ready',
                hasCardInfo,
                aEmail: emailA
            }
        });
        try { audit('a_payment_ready', { pairIndex: idx, aEmail: emailA, seatId: seatInfoForA?.seatId || null }); } catch {}
        return { ok: true, payment: 'ready' };
    };

    const moveSeatToAForPayment = async (pairIndex) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = bindPairRuntime(idx, 'payment_queue');
        if (!runtime) throw new Error(`PAIR_RUNTIME_NOT_FOUND:${idx}`);
        if (runtime.currentHolder === 'A' || currentHolder === 'A') {
            return runtime.currentSeatInfo || currentSeatInfo;
        }
        if (!runtime.bCtx || !runtime.currentSeatInfo?.seatId) {
            throw new Error(`PAIR_NOT_READY_FOR_A_PAYMENT:${idx}`);
        }

        markPairPaymentState(idx, {
            paymentOwnerRole: 'A',
            paymentEligible: true,
            paymentState: 'preparing',
            phase: 'B→A ödeme transferi hazırlanıyor'
        });

        const activeCatBlock = runtime.currentCatBlock || currentCatBlock || runtime.aCtx?.catBlock || null;
        const activeSeatInfo = runtime.currentSeatInfo || currentSeatInfo;
        const aIdentity = idProfileA?.identity ?? identity;
        const aFanCard = idProfileA?.fanCardCode ?? fanCardCode;
        const aSicilNo = idProfileA?.sicilNo ?? sicilNo;
        const aPriorityTicketCode = idProfileA?.priorityTicketCode ?? priorityTicketCode;

        try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
        await gotoWithRetry(pageA, String(eventAddress), {
            retries: 2,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        await clickBuy(pageA, eventAddress);
        await handlePrioritySaleModal(pageA, {
            prioritySale,
            fanCardCode: aFanCard,
            identity: aIdentity,
            sicilNo: aSicilNo,
            priorityTicketCode: aPriorityTicketCode,
            priorityPhone: runtime?.idProfileA?.phone ?? priorityPhone,
            priorityTckn
        });
        await ensureUrlContains(pageA, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        await pageA.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 12000 }).catch(() => {});

        try { await reloginIfRedirected(pageB, emailB, passwordB); } catch {}
        try {
            await gotoWithRetry(pageB, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await pageB.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 8000 }).catch(() => {});
        } catch {}

        let removed = false;
        let removeDiag = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (removed) break;
            removeDiag = await clearBasketFully(pageB, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
            removed = removeDiag?.ok === true;
            if (removed) break;
            try { await delay(1200 + (attempt * 300)); } catch {}
        }
        if (!removed) throw new Error(`B_TO_A_REMOVE_FAILED:${idx}`);

        try { await applyCategoryBlockSelection(pageA, categorySelectionMode, activeCatBlock, activeSeatInfo); } catch {}
        try { await openSeatMapStrict(pageA); } catch {}
        const exactMaxMs = Math.max(30000, Math.min((getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0), 120000));
        const seatInfoOnA = await pickExactSeatBundleReleaseAware(pageA, activeSeatInfo, exactMaxMs, {
            audit: (phase, payload) => audit(`a_queue_${phase}`, { pairIndex: idx, aEmail: emailA, ...payload })
        });
        await clickContinueInsidePage(pageA);
        await delay(getCfg().DELAYS.AFTER_CONTINUE);
        if (!basketTimer) basketTimer = new BasketTimer();
        try { basketTimer.start(); } catch {}
        const parkedOnA = await parkHolderOnBasket(pageA, basketTimer, {
            email: emailA,
            password: passwordA,
            reloginIfRedirected,
            label: `PAIR${idx}.A.afterContinue`
        });
        const basketTimingPatch = buildBasketTimingPatch({
            basketArrivedAtMs: Date.now(),
            remainingSeconds: parkedOnA?.remainingSeconds,
            observedAtMs: Date.now()
        });
        currentCatBlock = activeCatBlock || currentCatBlock;
        setHolder('A', seatInfoOnA, currentCatBlock);
        updatePairRuntime(idx, {
            aCtx: {
                ...(runtime?.aCtx || {}),
                ...basketTimingPatch
            },
            currentHolder: 'A',
            currentSeatInfo: seatInfoOnA,
            currentCatBlock,
            lastBRemoveDiag: removeDiag || null,
            ...basketTimingPatch
        });
        upsertDashboardPairRow(idx, {
            holder: 'A',
            seatId: seatInfoOnA?.seatId ? String(seatInfoOnA.seatId) : null,
            seatLabel: fmtSeatLabel(seatInfoOnA),
            combinedAll: seatInfoOnA?.combinedAll ? String(seatInfoOnA.combinedAll).trim() : null,
            seatItemCount: Number.isFinite(Number(seatInfoOnA?.itemCount)) && Number(seatInfoOnA.itemCount) > 1
                ? Math.floor(Number(seatInfoOnA.itemCount))
                : null,
            tribune: seatInfoOnA?.tribune ?? null,
            seatRow: seatInfoOnA?.row ?? null,
            seatNumber: seatInfoOnA?.seat ?? null,
            ...basketTimingPatch
        });
        return seatInfoOnA;
    };

    const getPairBasketRemainingSeconds = async (pairIndex) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx);
        if (!runtime) return null;
        const holder = String(runtime.currentHolder || '').toUpperCase();
        const page = holder === 'B' ? runtime?.bCtx?.page : runtime?.aCtx?.page;
        if (!page) return null;
        try {
            const uiStatus = await checkBasketTimeoutFromPage(page);
            const rem = Number(uiStatus?.remainingSeconds);
            if (Number.isFinite(rem) && rem >= 0) return rem;
        } catch {}
        const arrivedAt = holder === 'B'
            ? Number(runtime?.bCtx?.basketArrivedAtMs || runtime?.basketArrivedAtMs || 0)
            : Number(runtime?.aCtx?.basketArrivedAtMs || runtime?.basketArrivedAtMs || 0);
        if (!Number.isFinite(arrivedAt) || arrivedAt <= 0) return null;
        const holdSec = Number(getCfg()?.BASKET?.HOLDING_TIME_SECONDS || 600);
        const elapsedSec = Math.max(0, Math.floor((Date.now() - arrivedAt) / 1000));
        return Math.max(0, holdSec - elapsedSec);
    };
    const isBasketLikeRuntimeUrl = (u) => {
        try {
            return /\/(sepet|basket|cart|odeme|payment)(\b|\/|\?|#)/i.test(String(u || ''));
        } catch {
            return false;
        }
    };
    const isStrictBasketRuntimeUrl = (u) => {
        try {
            return /\/(sepet|basket|cart)(\b|\/|\?|#)/i.test(String(u || ''));
        } catch {
            return false;
        }
    };
    const readPairBasketHeartbeat = async (pairIndex) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx) || null;
        if (!runtime) return null;
        const holder = String(runtime.currentHolder || '').toUpperCase();
        if (holder !== 'A' && holder !== 'B') return null;
        const ctx = holder === 'B' ? runtime?.bCtx : runtime?.aCtx;
        const page = ctx?.page || null;
        if (!page) return null;
        const currentUrl = (() => { try { return String(page.url() || ''); } catch { return ''; } })();
        if (!isBasketLikeRuntimeUrl(currentUrl)) return null;
        const [basketData, uiStatus] = await Promise.all([
            readBasketData(page).catch(() => null),
            checkBasketTimeoutFromPage(page).catch(() => null)
        ]);
        const itemCount = Math.max(0, Number(basketData?.itemCount || 0));
        const hasSeatData = !!(
            basketData?.seatId ||
            basketData?.seat ||
            basketData?.row ||
            basketData?.tribune ||
            basketData?.block ||
            (basketData?.combined && String(basketData.combined).trim())
        );
        const basketPresent = basketData
            ? !!(itemCount > 0 || hasSeatData)
            : (isStrictBasketRuntimeUrl(currentUrl) ? false : null);
        const remainingSeconds = Number.isFinite(Number(uiStatus?.remainingSeconds))
            ? Math.max(0, Math.floor(Number(uiStatus.remainingSeconds)))
            : null;
        return {
            pairIndex: idx,
            holder,
            url: currentUrl,
            basketPresent,
            basketItemCount: itemCount,
            remainingSeconds,
            basketData,
            uiStatus
        };
    };
    const syncPairBasketHeartbeat = async (pairIndex) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx) || null;
        if (!runtime) return null;
        const heartbeat = await readPairBasketHeartbeat(idx);
        if (!heartbeat) return null;
        const holderKey = heartbeat.holder === 'B' ? 'bCtx' : 'aCtx';
        const prevCtx = runtime?.[holderKey] || {};
        const prevPresent = prevCtx?.basketPresent;
        const prevRemaining = prevCtx?.basketRemainingSeconds ?? runtime?.basketRemainingSeconds ?? null;
        const basketTimingPatch = buildBasketTimingPatch({
            basketArrivedAtMs: prevCtx?.basketArrivedAtMs ?? runtime?.basketArrivedAtMs ?? null,
            remainingSeconds: heartbeat.remainingSeconds != null ? heartbeat.remainingSeconds : prevRemaining,
            observedAtMs: Date.now()
        });
        updatePairRuntime(idx, {
            [holderKey]: {
                ...prevCtx,
                basketPresent: heartbeat.basketPresent,
                basketItemCount: heartbeat.basketItemCount,
                basketLastCheckedAt: new Date().toISOString(),
                ...basketTimingPatch
            },
            basketPresent: heartbeat.basketPresent,
            basketItemCount: heartbeat.basketItemCount,
            basketLastCheckedAt: new Date().toISOString(),
            ...basketTimingPatch
        });
        upsertDashboardPairRow(idx, {
            basketPresent: heartbeat.basketPresent,
            basketItemCount: heartbeat.basketItemCount,
            basketLastCheckedAt: new Date().toISOString(),
            ...basketTimingPatch
        });
        if (heartbeat.remainingSeconds != null && basketTimer && idx === Math.max(1, Math.floor(Number(dashboardMeta.activePairIndex || resolveDashboardCTarget() || 1)))) {
            try { basketTimer.syncFromRemainingSeconds(heartbeat.remainingSeconds); } catch {}
        }
        if (heartbeat.basketPresent === false && prevPresent !== false) {
            try {
                audit('basket_presence_lost', {
                    pairIndex: idx,
                    holder: heartbeat.holder,
                    seatId: runtime?.currentSeatInfo?.seatId || runtime?.aCtx?.seatInfo?.seatId || null,
                    aEmail: runtime?.aCtx?.email || null,
                    bEmail: runtime?.bCtx?.email || null,
                    url: heartbeat.url,
                    basketItemCount: heartbeat.basketItemCount
                }, 'warn');
            } catch {}
            logger.warn('Basket heartbeat: sepetten düştü', {
                runId,
                pairIndex: idx,
                holder: heartbeat.holder,
                url: heartbeat.url,
                basketItemCount: heartbeat.basketItemCount
            });
        }
        if (heartbeat.basketPresent === true && prevPresent === false) {
            try {
                audit('basket_presence_restored', {
                    pairIndex: idx,
                    holder: heartbeat.holder,
                    seatId: runtime?.currentSeatInfo?.seatId || runtime?.aCtx?.seatInfo?.seatId || null,
                    aEmail: runtime?.aCtx?.email || null,
                    bEmail: runtime?.bCtx?.email || null,
                    url: heartbeat.url,
                    basketItemCount: heartbeat.basketItemCount
                });
            } catch {}
            logger.info('Basket heartbeat: sepet yeniden göründü', {
                runId,
                pairIndex: idx,
                holder: heartbeat.holder,
                url: heartbeat.url,
                basketItemCount: heartbeat.basketItemCount
            });
        }
        return heartbeat;
    };
    const ensureBasketHeartbeatWatcher = () => {
        if (basketHeartbeatWatch) return;
        const ms = Math.max(10000, Number(getCfg()?.BASKET?.HEARTBEAT_CHECK_MS) || 10000);
        basketHeartbeatWatch = setInterval(async () => {
            try {
                const stKill = runStore.get(runId);
                if (stKill && stKill.status === 'killed') {
                    try { clearInterval(basketHeartbeatWatch); } catch {}
                    basketHeartbeatWatch = null;
                    return;
                }
                const entries = Array.from(pairRuntimeByIndex.entries());
                for (const [pairIndex] of entries) {
                    await syncPairBasketHeartbeat(pairIndex).catch(() => null);
                }
            } catch {}
        }, ms);
    };

    const transferSeatToBForHold = async (pairIndex, reason = 'threshold') => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx);
        if (!runtime) throw new Error(`PAIR_RUNTIME_NOT_FOUND:${idx}`);
        const aCtx = runtime.aCtx;
        const bCtx = runtime.bCtx;
        if (!aCtx?.seatInfo?.seatId) throw new Error(`PAIR_A_SEAT_MISSING:${idx}`);
        if (!bCtx?.page) throw new Error(`PAIR_B_CTX_MISSING:${idx}`);
        if (String(runtime.currentHolder || '').toUpperCase() === 'B') return runtime.currentSeatInfo || aCtx.seatInfo;

        audit('deferred_payer_transfer_start', {
            pairIndex: idx,
            reason,
            aEmail: aCtx.email,
            bEmail: bCtx.email,
            seatId: aCtx.seatInfo.seatId
        });

        try {
            await gotoWithRetry(aCtx.page, 'https://www.passo.com.tr/tr/sepet', {
                retries: 1,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 350
            });
        } catch {}

        let removed = false;
        let removeDiag = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (removed) break;
            removeDiag = await clearBasketFully(aCtx.page, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
            removed = removeDiag?.ok === true;
            if (removed) break;
            try { await delay(1200 + (attempt * 300)); } catch {}
        }
        if (!removed) throw new Error(`A_TO_B_DEFERRED_REMOVE_FAILED:${idx}`);

        try {
            await applyCategoryBlockSelection(bCtx.page, categorySelectionMode, aCtx.catBlock, aCtx.seatInfo);
        } catch (e) {
            audit('deferred_payer_transfer_apply_catblock_warn', {
                pairIndex: idx,
                bEmail: bCtx.email,
                error: e?.message || String(e)
            }, 'warn');
        }

        if (!bCtx.seatmapReady) {
            try {
                await openSeatMapStrict(bCtx.page);
                await bCtx.page.waitForFunction((sel) => {
                    try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                }, { timeout: 10000 }, SEAT_NODE_SELECTOR);
            } catch (e) {
                audit('deferred_payer_transfer_seatmap_reopen_warn', {
                    pairIndex: idx,
                    bEmail: bCtx.email,
                    error: e?.message || String(e)
                }, 'warn');
            }
        }

        const transferTargets = normalizeHeldSeats(aCtx.seatInfo);
        const exactMaxMs = Math.max(30000, Math.min((getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0) * Math.max(1, transferTargets.length || 1), 120000));
        const seatBInfo = await pickExactSeatBundleReleaseAware(bCtx.page, aCtx.seatInfo, exactMaxMs, {
            audit: (phase, payload) => audit(`deferred_payer_b_${phase}`, { pairIndex: idx, bEmail: bCtx.email, ...payload })
        });
        const basketTimingPatch = buildBasketTimingPatch({
            basketArrivedAtMs: Date.now(),
            remainingSeconds: seatBInfo?.remainingTime,
            observedAtMs: Date.now()
        });

        updatePairRuntime(idx, {
            aCtx,
            bCtx: {
                ...(bCtx || {}),
                ...basketTimingPatch
            },
            currentHolder: 'B',
            currentSeatInfo: seatBInfo || aCtx?.seatInfo || null,
            currentCatBlock: aCtx?.catBlock || null,
            lastBRemoveDiag: removeDiag || null,
            ...basketTimingPatch
        });
        const multiSeatSrc = seatBInfo || aCtx?.seatInfo || null;
        upsertDashboardPairRow(idx, {
            aEmail: aCtx?.email || '',
            bEmail: bCtx?.email || '',
            holder: 'B',
            seatId: seatBInfo?.seatId ? String(seatBInfo.seatId) : (aCtx?.seatInfo?.seatId ? String(aCtx.seatInfo.seatId) : null),
            seatLabel: fmtSeatLabel(seatBInfo),
            combinedAll: multiSeatSrc?.combinedAll ? String(multiSeatSrc.combinedAll).trim() : null,
            seatItemCount: Number.isFinite(Number(multiSeatSrc?.itemCount)) && Number(multiSeatSrc.itemCount) > 1
                ? Math.floor(Number(multiSeatSrc.itemCount))
                : null,
            tribune: seatBInfo?.tribune ?? null,
            seatRow: seatBInfo?.row ?? null,
            seatNumber: seatBInfo?.seat ?? null,
            phase: 'B sepette — A ödeme sırası bekliyor',
            paymentOwnerRole: 'A',
            paymentEligible: true,
            paymentState: hasCardInfo ? 'queued' : 'waiting',
            transferOk: true,
            ...basketTimingPatch
        });
        upsertPaymentQueueEntry({
            pairIndex: idx,
            paymentOwnerRole: 'A',
            paymentEligible: true,
            paymentState: hasCardInfo ? 'queued' : 'waiting',
            aEmail: aCtx?.email || '',
            bEmail: bCtx?.email || ''
        });
        await persistTransferForPair(idx, {
            sourceRole: 'B',
            holderRole: 'B',
            paymentOwnerRole: 'A',
            recordStatus: 'transferred',
            aAccountEmail: aCtx?.email || '',
            bAccountEmail: bCtx?.email || '',
            seat: seatBInfo,
            category: aCtx?.catBlock || null,
            auditMeta: {
                phase: 'deferred_payer_transfer_done',
                reason,
                aEmail: aCtx?.email || '',
                bEmail: bCtx?.email || ''
            }
        });
        audit('deferred_payer_transfer_done', {
            pairIndex: idx,
            reason,
            aEmail: aCtx.email,
            bEmail: bCtx.email,
            seatId: seatBInfo?.seatId || aCtx?.seatInfo?.seatId || null
        });
        return seatBInfo;
    };

    const ensureDeferredPayableTransferWatcher = () => {
        if (deferredPayableTransferWatch) return;
        deferredPayableTransferWatch = setInterval(async () => {
            try {
                const stKill = runStore.get(runId);
                if (stKill && stKill.status === 'killed') {
                    try { clearInterval(deferredPayableTransferWatch); } catch {}
                    deferredPayableTransferWatch = null;
                    return;
                }
                if (!hasCardInfo || finalizeInFlight || deferredPayableTransferInFlight) return;
                const threshold = Number.isFinite(extendWhenRemainingSecondsBelow)
                    ? extendWhenRemainingSecondsBelow
                    : 90;
                const activeIdx = Math.max(0, Math.floor(Number(paymentQueueActivePairIndex) || 0));
                const candidates = Array.from(pairRuntimeByIndex.entries())
                    .map(([candidateIndex, runtime]) => ({ pairIndex: Number(candidateIndex), runtime }))
                    .filter(({ pairIndex, runtime }) => (
                        runtime &&
                        runtime.aCtx?.canPay !== false &&
                        runtime.bCtx?.page &&
                        String(runtime.currentHolder || '').toUpperCase() === 'A' &&
                        pairIndex !== activeIdx
                    ))
                    .sort((a, b) => a.pairIndex - b.pairIndex);
                for (const candidate of candidates) {
                    const remaining = await getPairBasketRemainingSeconds(candidate.pairIndex);
                    if (!Number.isFinite(remaining) || remaining > threshold) continue;
                    audit('deferred_payer_transfer_triggered', {
                        pairIndex: candidate.pairIndex,
                        remainingSeconds: remaining,
                        threshold
                    });
                    deferredPayableTransferInFlight = transferSeatToBForHold(candidate.pairIndex, 'remaining_threshold');
                    try { await deferredPayableTransferInFlight; } finally { deferredPayableTransferInFlight = null; }
                    break;
                }
            } catch {}
        }, 2000);
    };

    const assertRunNotKilled = (label = '') => {
        try {
            const st = runStore.get(runId);
            if (st && st.status === 'killed') {
                const e = new Error(`RUN_KILLED${label ? `:${label}` : ''}`);
                e.code = 'RUN_KILLED';
                throw e;
            }
        } catch (e) {
            if (e && e.code === 'RUN_KILLED') throw e;
        }
    };
    const rethrowAsRunKilledIfNeeded = (err, label = '') => {
        if (err && err.code === 'RUN_KILLED') throw err;
        try {
            const st = runStore.get(runId);
            if (st && st.status === 'killed') {
                const killedErr = new Error(`RUN_KILLED${label ? `:${label}` : ''}`);
                killedErr.code = 'RUN_KILLED';
                killedErr.cause = err;
                throw killedErr;
            }
        } catch (e) {
            if (e && e.code === 'RUN_KILLED') throw e;
        }
    };

    const finalizeToC = async () => {
        assertRunNotKilled('finalizeToC');
        const fin = getFinalizeRequest();
        if (!fin?.requested) return null;
        try { bindFinalizePairFromRunState(); } catch {}
        const finalizePairIndex = Math.max(1, Math.floor(Number(dashboardMeta.activePairIndex || fin?.cTransferPairIndex || 1)));
        const cAcc = fin?.cAccount;
        const finMeta = fin?.finalizeMeta || null;
        if (!cAcc?.email || !cAcc?.password) throw new Error('FINALIZE_C_ACCOUNT_MISSING');
        if (!currentSeatInfo?.seatId) throw new Error('FINALIZE_SEATID_MISSING');
        if (!currentHolder) throw new Error('FINALIZE_HOLDER_UNKNOWN');

        try { clearPassiveSessionWatch(); } catch {}

        // Prefer finalize payload sensitive fields (identity/card) over initial request values.
        const identityFinal = (finMeta?.identity != null && String(finMeta.identity).trim())
            ? String(finMeta.identity).trim()
            : (() => {
                const i = identity != null ? String(identity).trim() : '';
                const p = priorityTckn != null ? String(priorityTckn).trim() : '';
                return i || p || null;
            })();
        const cardFinal = {
            cardHolder: (finMeta?.cardHolder != null && String(finMeta.cardHolder).trim()) ? String(finMeta.cardHolder).trim() : (cardHolder != null ? String(cardHolder).trim() : null),
            cardNumber: (finMeta?.cardNumber != null && String(finMeta.cardNumber).trim()) ? String(finMeta.cardNumber).trim() : (cardNumber != null ? String(cardNumber).trim() : null),
            expiryMonth: (finMeta?.expiryMonth != null && String(finMeta.expiryMonth).trim()) ? String(finMeta.expiryMonth).trim() : (expiryMonth != null ? String(expiryMonth).trim() : null),
            expiryYear: (finMeta?.expiryYear != null && String(finMeta.expiryYear).trim()) ? String(finMeta.expiryYear).trim() : (expiryYear != null ? String(expiryYear).trim() : null),
            cvv: (finMeta?.cvv != null && String(finMeta.cvv).trim()) ? String(finMeta.cvv).trim() : (cvv != null ? String(cvv).trim() : null)
        };
        const paymentRequiredFinal = !!(finMeta && (finMeta.paymentRequired === true || finMeta.autoPay === true));
        const autoPayFinal = paymentRequiredFinal && !!(finMeta && finMeta.autoPay === true);

        await persistCFinalizeReadyForPair(finalizePairIndex, {
            holderRole: currentHolder || 'B',
            paymentOwnerRole: 'C',
            paymentSource: 'C',
            paymentActorEmail: cAcc?.email || '',
            paymentState: 'c_ready',
            finalizeState: 'requested',
            recordStatus: 'finalize_ready',
            cAccountEmail: cAcc?.email || '',
            seat: currentSeatInfo,
            category: currentCatBlock,
            auditMeta: {
                phase: 'c_finalize_ready',
                cEmail: cAcc?.email || '',
                holder: currentHolder || null,
                paymentRequired: paymentRequiredFinal,
                autoPay: autoPayFinal
            }
        });

        audit('finalize_start', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null, cEmail: cAcc.email });
        logger.warn('Finalize requested: transferring seat to C', { holder: currentHolder, seatId: currentSeatInfo?.seatId || null, cEmail: cAcc.email });

        const holderPage = (currentHolder === 'A') ? pageA : pageB;
        const holderEmail = (currentHolder === 'A') ? emailA : emailB;
        const holderPass = (currentHolder === 'A') ? passwordA : passwordB;

        setStep('C.launchAndLogin.start', { email: cAcc.email });
        ({ browser: browserC, page: pageC } = await launchAndLoginWithManagedProxy({
            email: cAcc.email,
            password: cAcc.password,
            userDataDir: userDataDirC
        }, { role: 'C', idx: finalizePairIndex, email: cAcc.email }));
        try { multiBrowsers.push(browserC); } catch {}
        registerPassobotBrowser(browserC, runId);
        setStep('C.launchAndLogin.done', { email: cAcc.email, snap: await snapshotPage(pageC, 'C.afterLogin') });

        const eventPathIncludes = (() => {
            try {
                const u = new URL(String(eventAddress));
                return u.pathname || null;
            } catch {
                return null;
            }
        })();

        setStep('C.gotoEvent.start');
        await gotoWithRetry(pageC, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('C.gotoEvent.done', { snap: await snapshotPage(pageC, 'C.afterEventGoto') });

        await installRecaptchaCallbackInterceptor(pageC);
        setStep('C.clickBuy.start');
        await clickBuy(pageC, eventAddress);
        setStep('C.clickBuy.done');

        await handlePrioritySaleModal(pageC, { prioritySale, fanCardCode, identity, sicilNo, priorityTicketCode, priorityPhone, priorityTckn });

        await ensureUrlContains(pageC, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        try { await reloginIfRedirected(pageC, cAcc.email, cAcc.password); } catch {}
        // For finalize flow, do NOT open seat map / categories before holder releases; the seat will appear unavailable.
        // We only ensure C is logged in and on /koltuk-secim, and (if needed) Turnstile is solved.
        // Turnstile must be blocking here; background solving can lead to race conditions.
        try {
            setStep('C.turnstile.preRelease.waitMount.start');
            // Turnstile widget/token field can mount late after route transitions.
            // If we proceed to release before it mounts, C may start solving AFTER release -> critical delay.
            await pageC.waitForFunction(() => {
                try {
                    return !!document.querySelector('.cf-turnstile') || !!document.querySelector('input[name="cf-turnstile-response"]');
                } catch {
                    return false;
                }
            }, { timeout: 12000 }).catch(() => {});
            setStep('C.turnstile.preRelease.waitMount.done');
        } catch {}

        try {
            setStep('C.turnstile.preRelease.ensure.start');
            await ensureCaptchaOnPage(pageC, cAcc.email, 'C.seatSelection', { background: false });
            setStep('C.turnstile.preRelease.ensure.done');
        } catch (e) {
            logger.warnSafe('finalize C.seatSelection captcha (ilk)', { error: e?.message || String(e) });
            throw e;
        }

        setStep('C.turnstile.preRelease.waitToken.start');
        await waitUntilFinalizeCHumanChallengeReady(pageC, cAcc.email);
        setStep('C.turnstile.preRelease.waitToken.done');

        try {
            const tokenState = await readFinalizeCChallengeTokens(pageC);
            audit('finalize_c_turnstile_pre_release', { cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null, tokenState });
        } catch {}

        // IMPORTANT: Holder sepetten kaldırmadan önce C tarafında doğrulama token'ı hazır (yukarıdaki bekleme).
        audit('finalize_c_ready_for_release', {
            cEmail: cAcc.email,
            holder: currentHolder,
            seatId: currentSeatInfo?.seatId || null,
            urlC: (() => { try { return pageC.url(); } catch { return null; } })()
        });

        audit('finalize_holder_remove_start', { holder: currentHolder, holderEmail, seatId: currentSeatInfo?.seatId || null });
        try { await reloginIfRedirected(holderPage, holderEmail, holderPass); } catch {}
        try {
            await gotoWithRetry(holderPage, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await holderPage.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 8000 }).catch(() => {});
        } catch {}

        let removed = false;
        let removeDiag = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (removed) break;
            removeDiag = await clearBasketFully(holderPage, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
            removed = removeDiag?.ok === true;
            if (removed) break;
            try {
                await gotoWithRetry(holderPage, 'https://www.passo.com.tr/tr/sepet', {
                    retries: 0,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: '/sepet',
                    rejectIfHome: false,
                    backoffMs: 0
                });
                await delay(2500);
            } catch {}
        }
        if (!removed) throw new Error('FINALIZE_HOLDER_REMOVE_FAILED');
        audit('finalize_holder_remove_done', {
            holder: currentHolder,
            holderEmail,
            seatId: currentSeatInfo?.seatId || null,
            initialItemCount: removeDiag?.initialCount ?? null,
            remainingItemCount: removeDiag?.remainingCount ?? null,
            removedClicks: removeDiag?.removedClicks ?? null
        });

        const exactMaxMs = Math.max(30000, Math.min(getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0, 180000));
        try { await delay(350); } catch {}
        try { await reloginIfRedirected(pageC, cAcc.email, cAcc.password); } catch {}
        try { await ensureUrlContains(pageC, '/koltuk-secim', { retries: 1, waitMs: 9000, backoffMs: 450 }); } catch {}
        try {
            setStep('C.afterRelease.captcha.ensure.start');
            await ensureCaptchaOnPage(pageC, cAcc.email, 'C.afterRelease.seatSelection', { background: false });
            setStep('C.afterRelease.captcha.ensure.done');
        } catch (e) {
            logger.warnSafe('finalize C.afterRelease captcha', { error: e?.message || String(e) });
            throw e;
        }
        setStep('C.afterRelease.waitToken.start');
        await waitUntilFinalizeCHumanChallengeReady(pageC, cAcc.email);
        setStep('C.afterRelease.waitToken.done');

        try {
            if (currentSeatInfo && !currentSeatInfo.svgBlockId) {
                const sb = currentCatBlock?.svgBlockId || null;
                if (sb) currentSeatInfo.svgBlockId = String(sb);
            }
        } catch {}

        const ensureSeatmapMountedOnC = async () => {
            const svgBid = (currentSeatInfo?.svgBlockId || currentCatBlock?.svgBlockId || null);
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    setStep('C.seatmap.ensure.applyCategory.start', { attempt, mode: categorySelectionMode || null, svgBid: svgBid || null });
                    await applyCategoryBlockSelection(pageC, categorySelectionMode, (currentCatBlock || null), currentSeatInfo);
                    setStep('C.seatmap.ensure.applyCategory.done', { attempt });
                } catch (e) {
                    try { audit('finalize_c_apply_category_failed', { attempt, mode: categorySelectionMode || null, svgBid: svgBid || null, error: e?.message || String(e) }, 'warn'); } catch {}
                }

                try {
                    setStep('C.seatmap.ensure.openSeatmap.start', { attempt });
                    await openSeatMapStrict(pageC);
                    setStep('C.seatmap.ensure.openSeatmap.done', { attempt });
                } catch (e) {
                    try { audit('finalize_c_open_seatmap_failed', { attempt, error: e?.message || String(e) }, 'warn'); } catch {}
                }
                try {
                    await pageC.waitForFunction((sel) => {
                        try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                    }, { timeout: 20000 }, SEAT_NODE_SELECTOR);
                    return true;
                } catch {}
                if (svgBid) {
                    try { await selectSvgBlockById(pageC, String(svgBid)); } catch {}
                }
                try { await delay(350 + (attempt * 300)); } catch {}
            }
            return false;
        };

        setStep('C.seatmap.ensure.start');
        const seatmapOk = await ensureSeatmapMountedOnC().catch((e) => {
            try { audit('finalize_c_seatmap_ensure_failed', { error: e?.message || String(e) }, 'warn'); } catch {}
            return false;
        });
        setStep('C.seatmap.ensure.done', { ok: !!seatmapOk, snap: await snapshotPage(pageC, 'C.afterSeatmapEnsure') });
        if (!seatmapOk) throw new Error('FINALIZE_C_SEATMAP_MOUNT_FAILED');

        const seatInfoC = await pickExactSeatBundleReleaseAware(pageC, currentSeatInfo, exactMaxMs, {
            audit: (phase, payload) => audit(`finalize_c_${phase}`, { cEmail: cAcc.email, ...payload })
        });
        audit('finalize_c_exact_pick_done', {
            cEmail: cAcc.email,
            seatId: currentSeatInfo?.seatId || null,
            pickedSeatId: seatInfoC?.seatId || null,
            heldSeatCount: Array.isArray(seatInfoC?.heldSeats) ? seatInfoC.heldSeats.length : (seatInfoC?.itemCount || null)
        });

        setStep('C.clickContinue.start');
        await clickContinueInsidePage(pageC);
        await delay(getCfg().DELAYS.AFTER_CONTINUE);
        setStep('C.clickContinue.done', { snap: await snapshotPage(pageC, 'C.afterContinue') });

        // Payment / TCKN flow
        const paymentMeta = { paymentRequired: paymentRequiredFinal, transferredOnly: !paymentRequiredFinal, tcAssigned: false, invoiceTcFilled: false, agreementsAccepted: false, iframeFilled: false, payClicked: false, autoPay: autoPayFinal };
        const isCOnPaymentUrl = () => {
            try { return /\/odeme(\b|\/|\?|#)/i.test(String(pageC.url() || '')); } catch { return false; }
        };
        const waitForCPaymentIframe = async (timeout = 15000) => {
            const iframe = await pageC.waitForSelector('iframe#payment_nkolay_frame', { timeout }).catch(() => null);
            return !!iframe;
        };
        if (!paymentRequiredFinal) {
            finalizedToCResult = { success: true, grabbedBy: cAcc.email, seatC: seatInfoC, seatId: currentSeatInfo?.seatId || null, payment: paymentMeta };
            try {
                const activeIdx = Math.max(1, Math.floor(Number(paymentQueueActivePairIndex || dashboardMeta.activePairIndex || fin?.cTransferPairIndex || 1)));
                markPairPaymentState(activeIdx, {
                    paymentOwnerRole: 'C',
                    paymentEligible: false,
                    paymentState: 'c_ready',
                    phase: 'C hesabina transfer tamamlandi'
                });
            } catch {}
            await persistCFinalizeCompletedForPair(finalizePairIndex, {
                holderRole: 'C',
                paymentOwnerRole: 'C',
                paymentSource: 'C',
                paymentActorEmail: cAcc?.email || '',
                paymentState: 'c_ready',
                finalizeState: 'completed',
                recordStatus: 'finalized',
                cAccountEmail: cAcc?.email || '',
                seat: seatInfoC || currentSeatInfo,
                category: currentCatBlock,
                auditMeta: {
                    phase: 'c_finalize_completed',
                    cEmail: cAcc?.email || '',
                    paymentRequired: false,
                    transferredOnly: true
                }
            });
            audit('finalize_done', { grabbedBy: cAcc.email, seatId: currentSeatInfo?.seatId || null, paymentRequired: false, transferredOnly: true });
            return finalizedToCResult;
        }
        if (!/^\d{11}$/.test(String(identityFinal || '').trim())) {
            throw new Error('FINALIZE_IDENTITY_REQUIRED');
        }
        try {
            setStep('C.payment.gotoBasket.start');
            await gotoWithRetry(pageC, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await pageC.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i], input[placeholder="T.C. Kimlik No"][maxlength="11"], button', { timeout: 15000 }).catch(() => {});
            setStep('C.payment.gotoBasket.done', { url: (() => { try { return pageC.url(); } catch { return null; } })() });
        } catch {}

        setStep('C.payment.tcAssign.start');
        const okTc = await ensureTcAssignedOnBasket(pageC, String(identityFinal).trim(), { preferAssignToMyId: true, maxAttempts: 4 });
        paymentMeta.tcAssigned = !!okTc;
        audit('c_payment_tc_assign', { ok: !!okTc, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
        setStep('C.payment.tcAssign.done', { ok: !!okTc });
        if (!okTc) throw new Error('FINALIZE_TC_ASSIGN_FAILED');

        setStep('C.payment.devamToOdeme.start');
        const okContinue = await clickBasketDevamToOdeme(pageC);
        if (!okContinue) throw new Error('FINALIZE_CONTINUE_CLICK_FAILED');
        if (!isCOnPaymentUrl()) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                const didDismiss = await dismissPaymentInfoModalIfPresent(pageC).catch(() => false);
                if (isCOnPaymentUrl()) break;
                if (!didDismiss) {
                    await pageC.waitForFunction(() => /\/odeme(\b|\/|\?|#)/i.test(String(location.href || '')), { timeout: 4000 }).catch(() => {});
                }
                if (isCOnPaymentUrl()) break;
            }
        }
        setStep('C.payment.devamToOdeme.done', { url: (() => { try { return pageC.url(); } catch { return null; } })(), ok: isCOnPaymentUrl() });
        if (!isCOnPaymentUrl()) throw new Error('FINALIZE_CONTINUE_BLOCKED');

        setStep('C.payment.dismissInfoModal.start');
        let dismissedCount = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const didDismiss = await dismissPaymentInfoModalIfPresent(pageC).catch(() => false);
            if (!didDismiss) break;
            dismissedCount += 1;
        }
        setStep('C.payment.dismissInfoModal.done', { dismissedCount });

        let iframeReady = await waitForCPaymentIframe(4000);
        if (!iframeReady) {
            setStep('C.payment.invoiceTc.start');
            const okInv = await fillInvoiceTcAndContinue(pageC, String(identityFinal).trim());
            paymentMeta.invoiceTcFilled = !!okInv;
            audit('c_payment_invoice_tc', { ok: !!okInv, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
            setStep('C.payment.invoiceTc.done', { ok: !!okInv });
            for (let attempt = 1; attempt <= 2; attempt++) {
                const didDismiss = await dismissPaymentInfoModalIfPresent(pageC).catch(() => false);
                if (!didDismiss) break;
            }
            iframeReady = await waitForCPaymentIframe(6000);
        }

        if (!iframeReady) {
            setStep('C.payment.agreements.start');
            const okAg = await acceptAgreementsAndContinue(pageC);
            paymentMeta.agreementsAccepted = !!okAg;
            audit('c_payment_agreements', { ok: !!okAg, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
            setStep('C.payment.agreements.done', { ok: !!okAg });
            iframeReady = await waitForCPaymentIframe(12000);
        }

        if (!iframeReady) throw new Error('FINALIZE_PAYMENT_IFRAME_NOT_READY');

        if (cardFinal.cardHolder && cardFinal.cardNumber && cardFinal.expiryMonth && cardFinal.expiryYear && cardFinal.cvv) {
            setStep('C.payment.iframeFill.start');
            const okFrame = await fillNkolayPaymentIframe(pageC, cardFinal, { clickPay: autoPayFinal });
            if (autoPayFinal) {
                paymentMeta.iframeFilled = !!(okFrame && okFrame.ok);
                paymentMeta.payClicked = !!(okFrame && okFrame.payClicked);
            } else {
                paymentMeta.iframeFilled = !!okFrame;
            }
            audit('c_payment_iframe_filled', { ok: !!paymentMeta.iframeFilled, payClicked: !!paymentMeta.payClicked, autoPay: autoPayFinal, cEmail: cAcc.email, seatId: currentSeatInfo?.seatId || null });
            setStep('C.payment.iframeFill.done', { ok: !!paymentMeta.iframeFilled, payClicked: !!paymentMeta.payClicked, autoPay: autoPayFinal });
            if (!paymentMeta.iframeFilled) throw new Error('FINALIZE_PAYMENT_IFRAME_FILL_FAILED');
        } else {
            throw new Error('FINALIZE_CARD_INFO_MISSING');
        }

        finalizedToCResult = { success: true, grabbedBy: cAcc.email, seatC: seatInfoC, seatId: currentSeatInfo?.seatId || null, payment: paymentMeta };
        try {
            const activeIdx = Math.max(1, Math.floor(Number(paymentQueueActivePairIndex || dashboardMeta.activePairIndex || fin?.cTransferPairIndex || 1)));
            markPairPaymentState(activeIdx, {
                paymentOwnerRole: 'C',
                paymentEligible: false,
                paymentState: 'finalized',
                phase: 'C finalize tamamlandı'
            });
        } catch {}
        await persistCFinalizeCompletedForPair(finalizePairIndex, {
            holderRole: 'C',
            paymentOwnerRole: 'C',
            paymentSource: 'C',
            paymentActorEmail: cAcc?.email || '',
            paymentState: autoPayFinal && paymentMeta.payClicked ? 'c_paid' : 'c_ready',
            finalizeState: 'completed',
            recordStatus: 'finalized',
            cAccountEmail: cAcc?.email || '',
            seat: seatInfoC || currentSeatInfo,
            category: currentCatBlock,
            auditMeta: {
                phase: 'c_finalize_completed',
                cEmail: cAcc?.email || '',
                paymentRequired: paymentRequiredFinal,
                autoPay: autoPayFinal,
                payClicked: !!paymentMeta.payClicked
            }
        });
        audit('finalize_done', { grabbedBy: cAcc.email, seatId: currentSeatInfo?.seatId || null, paymentRequired: paymentRequiredFinal, payClicked: !!paymentMeta.payClicked });
        return finalizedToCResult;
    };

    const ensureFinalizeWatcher = () => {
        if (finalizeWatch) return;
        let finalizeFailedAt = null;
        const FINALIZE_RETRY_COOLDOWN_MS = 15000;
        finalizeWatch = setInterval(() => {
            try {
                const stKill = runStore.get(runId);
                if (stKill && stKill.status === 'killed') {
                    try { clearInterval(finalizeWatch); } catch {}
                    finalizeWatch = null;
                    return;
                }
                if (finalizedToCResult) return;
                if (finalizeInFlight) return;
                // Hata sonrası cooldown: aynı hata tekrar tekrar denenmesini önle.
                if (finalizeFailedAt && (Date.now() - finalizeFailedAt) < FINALIZE_RETRY_COOLDOWN_MS) return;
                const fin = getFinalizeRequest();
                if (!fin?.requested) return;
                if (!fin?.cAccount?.email || !fin?.cAccount?.password) return;
                try { bindFinalizePairFromRunState(); } catch {}
                if (!currentSeatInfo?.seatId || !currentHolder) return;
                const run = (async () => {
                    try {
                        return await finalizeToC();
                    } catch (e) {
                        finalizeFailedAt = Date.now();
                        try { audit('finalize_failed', { error: e?.message || String(e), seatId: currentSeatInfo?.seatId || null, cooldownMs: FINALIZE_RETRY_COOLDOWN_MS }, 'warn'); } catch {}
                        try {
                            const failPairIndex = Math.max(1, Math.floor(Number(dashboardMeta.activePairIndex || fin?.cTransferPairIndex || 1)));
                            await persistFailureForPair(failPairIndex, {
                                paymentState: 'failed',
                                finalizeState: 'failed',
                                recordStatus: 'failed',
                                cAccountEmail: fin?.cAccount?.email || '',
                                auditMeta: {
                                    phase: 'finalize_failed',
                                    error: e?.message || String(e)
                                }
                            });
                        } catch {}
                        throw e;
                    }
                })();
                finalizeInFlight = run;
                run.finally(() => {
                    try {
                        if (finalizeInFlight === run) finalizeInFlight = null;
                    } catch {}
                });
            } catch {}
        }, 1000);
    };

    /** Finalize panelden istendiğinde basket loop / pasif B oturum ping'i ile yarışmayı keser. */
    const pauseForFinalizeIfRequested = async (label) => {
        assertRunNotKilled(label);
        const fin = getFinalizeRequest();
        if (!fin?.requested || !fin?.cAccount?.email || !fin?.cAccount?.password) return null;
        if (finalizedToCResult) return 'done';
        try { ensureFinalizeWatcher(); } catch {}
        try { clearPassiveSessionWatch(); } catch {}
        for (let i = 0; i < 150 && !finalizeInFlight && !finalizedToCResult; i++) {
            await delay(100);
        }
        if (finalizedToCResult) return 'done';
        if (!finalizeInFlight) {
            try { audit('finalize_pause_no_inflight', { label }); } catch {}
            return null;
        }
        try {
            await finalizeInFlight;
        } catch {
            return 'error';
        }
        if (finalizedToCResult) return 'done';
        return 'error';
    };

    let browserA, pageA, browserB, pageB;
    let browserC, pageC;
    let multiBrowsers = [];
    /** Çoklu koşuda POST /run/:id/accounts/add ile eklenen A hesapları */
    let hotAccountIngestTimer = null;
    let basketTimer;
    let basketMonitor;
    let basketHeartbeatWatch;
    let passiveSessionWatch = null;
    let passiveSessionEarlyTimer = null;
    let passiveSeatTouchBusy = false;
    let dynamicTimingCheck;
    let finalizeWatch;
    let finalizeInFlight;
    let paymentQueueWatch;
    let paymentQueueInFlight;
    let deferredPayableTransferWatch;
    let deferredPayableTransferInFlight;
    let finalizedToCResult;
    let lastStep = 'init';
    const decorateStepMeta = (stepKey, meta = {}) => {
        const enriched = { ...(meta || {}) };
        try {
            if (!enriched.runId) enriched.runId = runId;
            const raw = String(stepKey || '').trim();
            let role = String(enriched.role || '').trim().toUpperCase();
            let idx = Number.isFinite(Number(enriched.idx)) ? Number(enriched.idx) : null;
            let pairIndex = Number.isFinite(Number(enriched.pairIndex)) ? Number(enriched.pairIndex) : null;

            let m = raw.match(/^([ABC])(\d+)(?:\.|$)/i);
            if (m) {
                role = role || String(m[1] || '').toUpperCase();
                if (idx == null) idx = Number(m[2]);
                if (pairIndex == null && role !== 'C' && Number.isFinite(idx)) pairIndex = idx + 1;
            } else {
                m = raw.match(/^PAIR(\d+)\.([ABC])(?:\.|$)/i);
                if (m) {
                    if (pairIndex == null) pairIndex = Number(m[1]);
                    role = role || String(m[2] || '').toUpperCase();
                    if (idx == null && Number.isFinite(pairIndex) && pairIndex >= 1) idx = pairIndex - 1;
                } else if (/^C(?:\.|$)/i.test(raw)) {
                    role = role || 'C';
                }
            }

            if (role) enriched.role = role;
            if (idx != null) enriched.idx = idx;
            if (pairIndex != null) enriched.pairIndex = pairIndex;

            let resolvedEmail = String(enriched.email || '').trim();
            if (!resolvedEmail && Number.isFinite(pairIndex) && pairIndex >= 1) {
                const runtime = pairRuntimeByIndex.get(pairIndex) || null;
                if (role === 'A') resolvedEmail = String(enriched.aEmail || runtime?.aCtx?.email || '').trim();
                else if (role === 'B') resolvedEmail = String(enriched.bEmail || runtime?.bCtx?.email || '').trim();
                else if (role === 'C') resolvedEmail = String(enriched.cEmail || getFinalizeRequest()?.cAccount?.email || '').trim();
            }
            if (!resolvedEmail && Number.isFinite(idx) && idx >= 0) {
                if (role === 'A') resolvedEmail = String(enriched.aEmail || aList[idx]?.email || '').trim();
                else if (role === 'B') resolvedEmail = String(enriched.bEmail || bList[idx]?.email || '').trim();
            }
            if (!resolvedEmail) {
                if (role === 'A') resolvedEmail = String(enriched.aEmail || emailA || '').trim();
                else if (role === 'B') resolvedEmail = String(enriched.bEmail || emailB || '').trim();
                else if (role === 'C') resolvedEmail = String(enriched.cEmail || getFinalizeRequest()?.cAccount?.email || '').trim();
            }
            if (resolvedEmail && !enriched.email) enriched.email = resolvedEmail;
            if (resolvedEmail && role === 'A' && !enriched.aEmail) enriched.aEmail = resolvedEmail;
            if (resolvedEmail && role === 'B' && !enriched.bEmail) enriched.bEmail = resolvedEmail;
            if (resolvedEmail && role === 'C' && !enriched.cEmail) enriched.cEmail = resolvedEmail;
        } catch {}
        return enriched;
    };
    const setStep = (s, meta = {}) => {
        lastStep = s;
        logger.info(`step:${s}`, decorateStepMeta(s, meta));
    };

    const isActiveAPaymentCompleted = async (pairIndex) => {
        const idx = Math.max(1, Math.floor(Number(pairIndex) || 1));
        const runtime = pairRuntimeByIndex.get(idx);
        const p = runtime?.aCtx?.page;
        if (!p) return false;
        try {
            const url = String(p.url() || '');
            if (!url) return false;
            return !/\/odeme(\b|\/|\?|#)/i.test(url);
        } catch {
            return false;
        }
    };

    const processNextAPaymentQueue = async () => {
        if (paymentQueueInFlight || !hasCardInfo) return paymentQueueInFlight || null;
        const nextEntry = paymentQueueState.find((item) => (
            item &&
            item.paymentOwnerRole === 'A' &&
            item.paymentEligible === true &&
            ['queued', 'waiting'].includes(String(item.paymentState || ''))
        ));
        if (!nextEntry) return null;

        const idx = Math.max(1, Math.floor(Number(nextEntry.pairIndex) || 1));
        const run = (async () => {
            markPairPaymentState(idx, {
                paymentOwnerRole: 'A',
                paymentEligible: true,
                paymentState: 'preparing',
                phase: 'A ödeme sırası aktif'
            });
            const seatInfoForA = await moveSeatToAForPayment(idx);
            await preparePaymentOnA(idx, seatInfoForA);
            paymentQueueActivePairIndex = idx;
            dashboardMeta.activePairIndex = idx;
            try { syncDashboardToRunStore(); } catch {}
            return idx;
        })();

        paymentQueueInFlight = run;
        run.finally(() => {
            try {
                if (paymentQueueInFlight === run) paymentQueueInFlight = null;
            } catch {}
        });
        return run;
    };

    const ensurePaymentQueueWatcher = () => {
        if (paymentQueueWatch) return;
        paymentQueueWatch = setInterval(async () => {
            try {
                const stKill = runStore.get(runId);
                if (stKill && stKill.status === 'killed') {
                    try { clearInterval(paymentQueueWatch); } catch {}
                    paymentQueueWatch = null;
                    return;
                }
                if (finalizedToCResult || finalizeInFlight || paymentQueueInFlight) return;

                const activeIdx = Math.max(0, Math.floor(Number(paymentQueueActivePairIndex) || 0));
                if (activeIdx > 0) {
                    const activeEntry = paymentQueueState.find((item) => Number(item?.pairIndex) === activeIdx);
                    if (activeEntry && String(activeEntry.paymentState || '') === 'ready') {
                        const completed = await isActiveAPaymentCompleted(activeIdx);
                        if (completed) {
                            markPairPaymentState(activeIdx, {
                                paymentOwnerRole: 'A',
                                paymentEligible: true,
                                paymentState: 'finalized',
                                phase: 'A ödemesi tamamlandı'
                            });
                            await persistAPaymentCompletedForPair(activeIdx, {
                                paymentActorEmail: pairRuntimeByIndex.get(activeIdx)?.aCtx?.email || emailA,
                                paymentState: 'a_paid',
                                recordStatus: 'payment_completed',
                                finalizeState: 'completed',
                                auditMeta: {
                                    phase: 'a_payment_completed',
                                    aEmail: pairRuntimeByIndex.get(activeIdx)?.aCtx?.email || emailA
                                }
                            });
                            paymentQueueActivePairIndex = null;
                            dashboardMeta.activePairIndex = null;
                            try { syncDashboardToRunStore(); } catch {}
                        }
                        return;
                    }
                }

                await processNextAPaymentQueue();
            } catch {}
        }, 1500);
    };
    const snapshotPage = async (page, label) => {
        if (!page) return null;
        try {
            return await evaluateSafe(page, (lbl, seatSel) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                const title = document.title;
                const url = location.href;
                const hasVerifyHuman = bodyText.includes('verify you are human');
                const hasTurnstileWidget = !!document.querySelector('.cf-turnstile');
                const hasTurnstileTokenField = !!document.querySelector('input[name="cf-turnstile-response"]');
                const seatCount = document.querySelectorAll(seatSel).length;
                const selectedCount = document.querySelectorAll(
                    'circle.seat-circle.selected, circle.seat-circle[aria-pressed="true"], [data-selected="true"], svg.seatmap-svg g.selected rect, svg.seatmap-svg rect.selected, svg.seatmap-svg g[class*="selected"] rect'
                ).length;
                const possibleErrors = Array.from(document.querySelectorAll('.error, .alert, .toast, .swal2-html-container, .validation, .invalid-feedback'))
                    .slice(0, 5)
                    .map(el => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean);
                return {
                    label: lbl,
                    title,
                    url,
                    hasVerifyHuman,
                    hasTurnstileWidget,
                    hasTurnstileTokenField,
                    seatCount,
                    selectedCount,
                    possibleErrors
                };
            }, label, SEAT_NODE_SELECTOR);
        } catch (e) {
            return { label, error: e?.message || String(e) };
        }
    };

    const clearPassiveSessionWatch = () => {
        try {
            if (passiveSessionWatch) clearInterval(passiveSessionWatch);
        } catch {}
        passiveSessionWatch = null;
        try {
            if (passiveSessionEarlyTimer) clearTimeout(passiveSessionEarlyTimer);
        } catch {}
        passiveSessionEarlyTimer = null;
    };

    /** Sepet A'dayken B koltuk sayfasında beklerken (veya döngüde tersi) oturum düşerse toparlar. */
    const touchPassiveSeatWaiter = async (page, email, password, recoveryUrl, label) => {
        if (!page) return;
        if (passiveSeatTouchBusy) return;
        passiveSeatTouchBusy = true;
        try {
            try {
                const fr = getFinalizeRequest();
                if (fr?.requested && fr?.cAccount?.email) return;
            } catch {}
            if (getCfg()?.BASKET?.PASSIVE_SEAT_SCROLL_KEEPALIVE) {
                try {
                    const u0 = (() => {
                        try {
                            return String(page.url() || '');
                        } catch {
                            return '';
                        }
                    })();
                    if (u0.includes('/koltuk-secim')) {
                        await evaluateSafe(page, () => {
                            try {
                                const doc = document.documentElement;
                                const body = document.body;
                                const sh = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0, 0);
                                const ch = window.innerHeight || (doc ? doc.clientHeight : 0) || 600;
                                const maxScroll = Math.max(0, sh - ch);
                                if (maxScroll < 100) return;
                                const cur = window.scrollY || (doc ? doc.scrollTop : 0) || 0;
                                const dir = Math.random() < 0.5 ? 1 : -1;
                                const delta = Math.floor(50 + Math.random() * 100) * dir;
                                const next = Math.max(0, Math.min(maxScroll, cur + delta));
                                window.scrollTo(0, next);
                            } catch (e) {}
                        });
                    }
                } catch {}
            }
            try {
                await reloginIfRedirected(page, email, password);
            } catch {}
            let u = (() => {
                try {
                    return String(page.url() || '');
                } catch {
                    return '';
                }
            })();
            if (recoveryUrl && !u.includes('/koltuk-secim')) {
                try {
                    await gotoWithRetry(page, String(recoveryUrl), {
                        retries: 1,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: 'passo',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                } catch {}
                try {
                    await reloginIfRedirected(page, email, password);
                } catch {}
                try {
                    await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 14000, backoffMs: 500 });
                } catch {}
            }
            u = (() => {
                try {
                    return String(page.url() || '');
                } catch {
                    return '';
                }
            })();
            try {
                audit('passive_seat_session_ping', { label, email: email || null, url: u.slice(0, 240) });
            } catch {}
        } catch (e) {
            try {
                logger.warnSafe('touchPassiveSeatWaiter failed', { label, error: e?.message || String(e) });
            } catch {}
        } finally {
            passiveSeatTouchBusy = false;
        }
    };

    const startPassiveSeatWatch = (opts) => {
        clearPassiveSessionWatch();
        const ms = Math.max(10000, Number(getCfg()?.BASKET?.PASSIVE_SESSION_CHECK_MS) || 45000);
        passiveSessionWatch = setInterval(() => {
            touchPassiveSeatWaiter(opts.page, opts.email, opts.password, opts.recoveryUrl, opts.label).catch(() => {});
        }, ms);
        try {
            const firstDelay = Math.min(15000, Math.max(4000, Math.floor(ms / 3)));
            passiveSessionEarlyTimer = setTimeout(() => {
                passiveSessionEarlyTimer = null;
                touchPassiveSeatWaiter(opts.page, opts.email, opts.password, opts.recoveryUrl, `${opts.label}:early`).catch(() => {});
            }, firstDelay);
        } catch {}
    };

    logger.infoSafe('Bot başlatılıyor', {
        team,
        ticketType,
        eventAddress,
        email: emailA,
        email2: emailB,
        categoryType: resolvedCategoryType,
        selectedCategories: selectedCategories.map((item) => item.label || item.categoryType),
        multi: isMulti,
        aCount: aList.length,
        bCount: bList.length
    });

    audit('run_start', {
        team,
        ticketType,
        eventAddress,
        categoryType: resolvedCategoryType,
        alternativeCategory: resolvedAlternativeCategory,
        selectedCategories: selectedCategories.map((item) => ({
            id: item.id || null,
            label: item.label || null,
            categoryType: item.categoryType,
            alternativeCategory: item.alternativeCategory || null,
            selectionModeHint: item.selectionModeHint || null
        })),
        categorySelectionMode,
        multi: isMulti,
        aCount: aList.length,
        bCount: bList.length,
        transferTargetEmail: transferTargetEmail || null,
        cTransferPairIndex: validatedData.cTransferPairIndex ?? 1
    });
    ensureBasketHeartbeatWatcher();

    try {
        const eventPathIncludes = (() => {
            try {
                const u = new URL(String(eventAddress));
                return u.pathname || null;
            } catch {
                return null;
            }
        })();

        let multiPostTransferReady = false;
        let catBlockA = { categoryText: '', blockText: '', blockVal: '' };
        let seatInfoA = null;
        let seatInfoB = null;
        let idProfileA = aList[0] || null;
        let idProfileB = bList[0] || null;

        if (isMulti) {
            const poolMap = async (items, concurrency, handler) => {
                const conc = Math.max(1, Number(concurrency) || 1);
                const results = new Array(items.length);
                let idx = 0;
                const workers = new Array(Math.min(conc, items.length)).fill(null).map(async () => {
                    while (true) {
                        const cur = idx++;
                        if (cur >= items.length) return;
                        try {
                            results[cur] = await handler(items[cur], cur);
                        } catch (e) {
                            // Isolate worker failures so one account doesn't abort whole multi pool.
                            const item = items[cur] || {};
                            logger.warn('multi:pool_worker_failed', {
                                index: cur,
                                email: item?.email || null,
                                error: e?.message || String(e)
                            });
                            results[cur] = null;
                        }
                    }
                });
                await Promise.all(workers);
                return results;
            };

            // 1) Prepare all B accounts to seat selection (ready state)
            const multiAConcurrency = Math.max(1, Number(getCfg()?.MULTI?.A_CONCURRENCY || 4));
            const multiBConcurrency = Math.max(1, Number(getCfg()?.MULTI?.B_CONCURRENCY || 2));
            const multiStaggerMs = Math.max(0, Number(getCfg()?.MULTI?.STAGGER_MS || 0));

            // A hesapları önce koltuk kapsın (öncelik), sonra B hesapları hazırlansın
            setStep('MULTI.aFirst.start', { aCount: aList.length, bCount: bList.length, multiAConcurrency, multiBConcurrency, multiStaggerMs });

            const bCtxFn = async () => {
                setStep('MULTI.B.prepare.start', { bCount: bList.length, concurrency: multiBConcurrency, multiStaggerMs });
                audit('multi_b_prepare_start', { bCount: bList.length, concurrency: multiBConcurrency, multiStaggerMs });
                const bCtxList = await poolMap(bList, multiBConcurrency, async (acc, i) => {
                const label = `B${i}`;
                let bBrowser = null;
                try {
                if (multiStaggerMs > 0) {
                    try { await delay(i * multiStaggerMs); } catch {}
                }
                setStep(`${label}.launchAndLogin.start`, { email: acc.email });
                audit('account_launch_start', { role: 'B', idx: i, email: acc.email });
                const userDataDir = buildRunUserDataDir(getCfg().USER_DATA_DIR_B, `B${i}`);
                const { browser, page } = await launchAndLoginWithManagedProxy({
                    email: acc.email,
                    password: acc.password,
                    userDataDir
                }, { role: 'B', idx: i, email: acc.email });
                bBrowser = browser;
                try { multiBrowsers.push(browser); } catch {}
                registerPassobotBrowser(browser, runId);
                setStep(`${label}.launchAndLogin.done`, { email: acc.email, snap: await snapshotPage(page, `${label}.afterLogin`) });
                audit('account_launch_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.gotoEvent.start`, { eventAddress });
                audit('account_goto_event_start', { role: 'B', idx: i, email: acc.email, eventAddress });
                await gotoWithRetry(page, String(eventAddress), {
                    retries: 3,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: eventPathIncludes,
                    rejectIfHome: true,
                    backoffMs: 450
                });
                setStep(`${label}.gotoEvent.done`, { snap: await snapshotPage(page, `${label}.afterEventGoto`) });
                audit('account_goto_event_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await installRecaptchaCallbackInterceptor(page);
                setStep(`${label}.clickBuy.start`);
                audit('account_click_buy_start', { role: 'B', idx: i, email: acc.email });
                const clicked = await clickBuy(page, eventAddress);
                if (!clicked) throw new Error(formatError('BUY_BUTTON_FAILED_B'));
                setStep(`${label}.clickBuy.done`);
                audit('account_click_buy_done', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity, sicilNo: acc?.sicilNo ?? sicilNo, priorityTicketCode: acc?.priorityTicketCode ?? priorityTicketCode, priorityPhone: acc?.phone ?? priorityPhone, priorityTckn });

                setStep(`${label}.postBuy.ensureUrl.start`);
                await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                setStep(`${label}.postBuy.ensureUrl.done`, { snap: await snapshotPage(page, `${label}.afterEnsureUrl`) });
                audit('account_seat_selection_ready', { role: 'B', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.postBuy.reloginCheck.start`);
                await reloginIfRedirected(page, acc.email, acc.password);
                setStep(`${label}.postBuy.reloginCheck.done`, { snap: await snapshotPage(page, `${label}.afterReloginCheck`) });

                // Priority sale modal can appear after redirect/login on /koltuk-secim as well.
                const ps2 = await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity, sicilNo: acc?.sicilNo ?? sicilNo, priorityTicketCode: acc?.priorityTicketCode ?? priorityTicketCode, priorityPhone: acc?.phone ?? priorityPhone, priorityTckn });
                if (ps2) {
                    try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                }

                // Guard: session drift may leave us on / or /giris; ensure we are back on seat selection.
                try {
                    const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
                    let path = '';
                    try { path = new URL(String(curUrl || '')).pathname || ''; } catch { path = String(curUrl || ''); }
                    const isSeatSelection = String(path || '').includes('/koltuk-secim');
                    const isLogin = String(path || '').includes('/giris');
                    if ((!isSeatSelection || isLogin) && String(eventAddress || '').includes('/etkinlik/')) {
                        try {
                            await gotoWithRetry(page, String(eventAddress), {
                                retries: 1,
                                waitUntil: 'domcontentloaded',
                                expectedUrlIncludes: '/etkinlik/',
                                rejectIfHome: false,
                                backoffMs: 450
                            });
                        } catch {}
                        try { await clickBuy(page, eventAddress); } catch {}
                        try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                    }
                } catch {}

                setStep(`${label}.turnstile.ensure.start`);
                await ensureTurnstileTokenOnPage(page, acc.email, `${label}.seatSelection`, { background: true });
                setStep(`${label}.turnstile.ensure.done`, { snap: await snapshotPage(page, `${label}.afterTurnstileEnsure`) });

                // STRATEJI: B kategori seçim ekranında (seatmap KAPALI) bekler.
                // A koltuğu seatmap açıkken bırakırsa koltuk "dolu" (gri) görünür ve sayfanın
                // yenilenmesi gerekir. Bunun yerine: A bırakır → B kategoriyi tıklar →
                // seatmap SIFIRDAN açılır → koltuk anında serbest görünür → B hemen tıklar.
                const seatSelectionUrl = (() => { try { return page.url(); } catch { return null; } })();

                // Keep B on seat selection category screen; do NOT open seatmap yet.
                setStep(`${label}.preRelease.ready`);
                audit('b_standby_ready', { idx: i, email: acc.email, seatmapReady: false, url: seatSelectionUrl });

                return {
                    idx: i,
                    label,
                    email: acc.email,
                    password: acc.password,
                    browser,
                    page,
                    seatSelectionUrl,
                    seatmapReady: false
                };
                } catch (e) {
                    rethrowAsRunKilledIfNeeded(e, `${label}.prepare`);
                    audit('b_prepare_failed', { idx: i, email: acc.email, error: e?.message || String(e) }, 'warn');
                    logger.warn(`${label} başarısız — tarayıcı kapatılıyor`, { email: acc.email, error: e?.message });
                    try { if (bBrowser) { unregisterPassobotBrowser(bBrowser); await bBrowser.close().catch(() => {}); const bIdx = multiBrowsers.indexOf(bBrowser); if (bIdx >= 0) multiBrowsers.splice(bIdx, 1); } } catch {}
                    return null;
                }
                });
                const bCtxOk = bCtxList.filter(x => x !== null);
                const bFailedCount = bCtxList.length - bCtxOk.length;
                if (bCtxOk.length === 0) {
                    throw new Error('Tüm B hesapları başarısız oldu — devam edilemiyor');
                }
                if (bFailedCount > 0) {
                    audit('multi_b_partial_failure', { total: bList.length, ok: bCtxOk.length, failed: bFailedCount });
                    logger.warn(`${bFailedCount}/${bList.length} B hesabı başarısız, ${bCtxOk.length} hesapla devam ediliyor`);
                }
                setStep('MULTI.B.prepare.done', { bCount: bCtxOk.length, failedCount: bFailedCount });
                audit('multi_b_prepare_done', { bCount: bCtxOk.length, failedCount: bFailedCount, bEmails: bCtxOk.map(x => x?.email).filter(Boolean) });
                return bCtxOk;
            };

            let dynamicMultiAIndex = aList.length;
            let hotIngestBusy = false;

            async function runOneMultiAHold(acc, i) {
                const label = `A${i}`;
                let aBrowser = null;
                try {
                const userDataDir = buildRunUserDataDir(getCfg().USER_DATA_DIR_A, `A${i}`);

                if (multiStaggerMs > 0) {
                    try { await delay(i * multiStaggerMs); } catch {}
                }

                setStep(`${label}.launchAndLogin.start`, { email: acc.email });
                audit('account_launch_start', { role: 'A', idx: i, email: acc.email });
                const { browser, page } = await launchAndLoginWithManagedProxy({
                    email: acc.email,
                    password: acc.password,
                    userDataDir
                }, { role: 'A', idx: i, email: acc.email });
                aBrowser = browser;
                try { multiBrowsers.push(browser); } catch {}
                registerPassobotBrowser(browser, runId);
                setStep(`${label}.launchAndLogin.done`, { email: acc.email, snap: await snapshotPage(page, `${label}.afterLogin`) });
                audit('account_launch_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.gotoEvent.start`, { eventAddress });
                audit('account_goto_event_start', { role: 'A', idx: i, email: acc.email, eventAddress });
                await gotoWithRetry(page, String(eventAddress), {
                    retries: 3,
                    waitUntil: 'networkidle2',
                    expectedUrlIncludes: eventPathIncludes,
                    rejectIfHome: true,
                    backoffMs: 450
                });
                setStep(`${label}.gotoEvent.done`, { snap: await snapshotPage(page, `${label}.afterEventGoto`) });
                audit('account_goto_event_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await installRecaptchaCallbackInterceptor(page);
                setStep(`${label}.clickBuy.start`);
                audit('account_click_buy_start', { role: 'A', idx: i, email: acc.email });
                const clicked = await clickBuy(page, eventAddress);
                if (!clicked) throw new Error(formatError('BUY_BUTTON_FAILED_A'));
                setStep(`${label}.clickBuy.done`);
                audit('account_click_buy_done', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity, sicilNo: acc?.sicilNo ?? sicilNo, priorityTicketCode: acc?.priorityTicketCode ?? priorityTicketCode, priorityPhone: acc?.phone ?? priorityPhone, priorityTckn });

                setStep(`${label}.postBuy.ensureUrl.start`);
                await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                setStep(`${label}.postBuy.ensureUrl.done`, { snap: await snapshotPage(page, `${label}.afterEnsureUrl`) });
                audit('account_seat_selection_ready', { role: 'A', idx: i, email: acc.email, url: (() => { try { return page.url(); } catch { return null; } })() });

                setStep(`${label}.postBuy.reloginCheck.start`);
                await reloginIfRedirected(page, acc.email, acc.password);
                setStep(`${label}.postBuy.reloginCheck.done`, { snap: await snapshotPage(page, `${label}.afterReloginCheck`) });

                // Priority sale modal can appear after redirect/login on /koltuk-secim as well.
                await handlePrioritySaleModal(page, { prioritySale, fanCardCode: acc?.fanCardCode ?? fanCardCode, identity: acc?.identity ?? identity, sicilNo: acc?.sicilNo ?? sicilNo, priorityTicketCode: acc?.priorityTicketCode ?? priorityTicketCode, priorityPhone: acc?.phone ?? priorityPhone, priorityTckn });

                // Guard: session drift may leave us on / or /giris; ensure we are back on seat selection.
                try {
                    const curUrl = (() => { try { return page.url(); } catch { return ''; } })();
                    let path = '';
                    try { path = new URL(String(curUrl || '')).pathname || ''; } catch { path = String(curUrl || ''); }
                    const isSeatSelection = String(path || '').includes('/koltuk-secim');
                    const isLogin = String(path || '').includes('/giris');
                    if ((!isSeatSelection || isLogin) && String(eventAddress || '').includes('/etkinlik/')) {
                        try {
                            await gotoWithRetry(page, String(eventAddress), {
                                retries: 1,
                                waitUntil: 'domcontentloaded',
                                expectedUrlIncludes: '/etkinlik/',
                                rejectIfHome: false,
                                backoffMs: 450
                            });
                        } catch {}
                        try { await clickBuy(page, eventAddress); } catch {}
                        try { await ensureUrlContains(page, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
                    }
                } catch {}

                setStep(`${label}.turnstile.ensure.start`);
                await ensureTurnstileTokenOnPage(page, acc.email, `${label}.seatSelection`, { background: true });
                setStep(`${label}.turnstile.ensure.done`, { snap: await snapshotPage(page, `${label}.afterTurnstileEnsure`) });

                // ticket type selection (if present)
                const hasTicketType = await page.$('.ticket-type-title');
                if (hasTicketType) {
                    setStep(`${label}.ticketType.select.start`);
                    await page.evaluate(() => {
                        const titles = Array.from(document.querySelectorAll('.ticket-type-title'));
                        const target = titles.find(el => (el.innerText || '').includes('Passolig E-Bilet'));
                        target?.click();
                    });
                    setStep(`${label}.ticketType.select.done`, { snap: await snapshotPage(page, `${label}.afterTicketType`) });
                }

                const accountAllowedCategories = await resolveCategoriesForCredential(teamId, selectedCategories, acc.categoryIds || [], categorySelectionMode);
                const accountAllowedBlocks = await resolveBlocksForCredential(teamId, selectedBlocks, acc.blockIds || []);
                const { chooser: accountCategoryChooser, blockMap: accountBlockMap } = buildAccountChooser(
                    accountAllowedBlocks,
                    accountAllowedCategories,
                    resolvedCategoryType,
                    resolvedAlternativeCategory,
                    categorySelectionMode,
                    isMulti ? { runId, ticketCount, workerIndex: i } : null
                );
                let ticketQuantityPrimed = false;
                const targetPeek = accountCategoryChooser.peekNext ? accountCategoryChooser.peekNext() : null;
                setStep(`${label}.categoryBlock.select.start`, {
                    categorySelectionMode,
                    categoryId: targetPeek?.id || null,
                    categoryLabel: targetPeek?.label || null,
                    categoryType: targetPeek?.categoryType || resolvedCategoryType || null,
                    svgBlockId: targetPeek?.svgBlockId || null,
                    alternativeCategory: targetPeek?.alternativeCategory || resolvedAlternativeCategory || null,
                });
                const cbStart = Date.now();
                const cbRes = await accountCategoryChooser.choose(page, resolvedCategoryType, resolvedAlternativeCategory, categorySelectionMode);
                setStep(`${label}.categoryBlock.select.done`, { snap: await snapshotPage(page, `${label}.afterCategoryBlock`) });
                audit('a_category_block_selected', {
                    idx: i,
                    email: acc.email,
                    mode: categorySelectionMode,
                    ms: Date.now() - cbStart,
                    categoryId: cbRes?.chosenCategory?.id || null,
                    categoryLabel: cbRes?.chosenCategory?.label || null,
                    categoryType: cbRes?.chosenCategory?.categoryType || resolvedCategoryType || null,
                    svgBlockId: cbRes?.svgBlockId || cbRes?.chosenCategory?.svgBlockId || null,
                    blockOverride: !!(cbRes?.chosenBlock),
                });

                let catBlock = { categoryText: '', blockText: '', blockVal: '' };
                if (cbRes && cbRes.svgBlockId) {
                    try { catBlock = { ...catBlock, svgBlockId: cbRes.svgBlockId }; } catch {}
                }
                for (let r = 0; r < 6; r++) {
                    try {
                        const c = await readCatBlock(page);
                        const catTxt = (c?.categoryText || '').trim();
                        const isPlaceholder = !catTxt || catTxt.toLowerCase() === 'kategori';
                        const blocksOk = !!(c?.blockVal || c?.blockText);
                        if (!isPlaceholder && blocksOk) { catBlock = { ...(c || {}), svgBlockId: catBlock?.svgBlockId }; break; }
                        catBlock = { ...(c || catBlock), svgBlockId: catBlock?.svgBlockId };
                    } catch {}
                    await delay(350);
                }

                if (Number(ticketCount) === 1 && cbRes?.chosenCategory) {
                    const blk =
                        String(catBlock?.blockVal || '').trim() ||
                        String(catBlock?.blockText || '').trim().slice(0, 120);
                    if (blk) {
                        const base = categoryLoadRegistry.slotKeyFromCategory(cbRes.chosenCategory);
                        if (base) {
                            try {
                                accountCategoryChooser.rebindLoadKey(`${base}|b:${blk.slice(0, 120)}`);
                            } catch {}
                        }
                    }
                }

                if (ticketCount > 1) {
                    const qtyRes = await applyTicketQuantityDropdown(page, `${label}:postCategory`, ticketCount);
                    ticketQuantityPrimed = qtyRes?.ok === true;
                }

                setStep(`${label}.seat.pickRandom.start`);
                const seatSelectionUrl = (() => { try { return page.url(); } catch { return null; } })();
                const netSeat = captureSeatIdFromNetwork(page, getCfg().TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
                const seatHelper = require('../helpers/seat');
                let seatInfo = null;
                const seatPickStart = Date.now();
                const maxCycle = Math.max(12, Number(getCfg()?.TIMEOUTS?.SEAT_SELECTION_CYCLES || 0) || 12);
                const waitUntilFound = getCfg()?.TIMEOUTS?.SEAT_WAIT_UNTIL_FOUND === true;
                const waitMaxMinutes = Math.max(1, Number(getCfg()?.TIMEOUTS?.SEAT_WAIT_MAX_MINUTES || 90) || 90);
                const waitDeadlineAt = Date.now() + (waitMaxMinutes * 60 * 1000);
                let cycleStartedAt = Date.now();
                for (let cycle = 1; (waitUntilFound ? (Date.now() < waitDeadlineAt) : (cycle <= maxCycle)); cycle++) {
                    try {
                        const remaining = Math.max(15000, Number(getCfg().TIMEOUTS.SEAT_SELECTION_MAX) - (Date.now() - cycleStartedAt));
                        const catRule = cbRes?.chosenCategory || {};
                        const catMinTickets = (catRule.ticketCount && catRule.ticketCount > 1) ? catRule.ticketCount : 1;
                        const effectiveTicketCount = Math.max(ticketCount, catMinTickets);
                        const adjacentSeats = catRule.adjacentSeats === true;
                        seatInfo = await seatHelper.pickRandomSeatWithVerify(page, remaining, {
                            context: label,
                            expectedUrlIncludes: '/koltuk-secim',
                            recoveryUrl: seatSelectionUrl,
                            roamCategoryTexts: accountCategoryChooser.getRoamTexts(),
                            email: acc.email,
                            password: acc.password,
                            reloginIfRedirected,
                            ensureTurnstileFn: ensureCaptchaOnPage,
                            chooseCategoryFn: accountCategoryChooser.choose,
                            categorySelectionMode,
                            seatSelectionMode,
                            claimGroupKey: runId,
                            ticketCount: effectiveTicketCount,
                            quantitySelectionMode: 'afterCategory',
                            ticketQuantityPrimed,
                            adjacentSeats
                        });
                        break;
                    } catch (e) {
                        const msg = e?.message || String(e);
                        if (/NO_SELECTABLE_SEATS/i.test(msg) || msg.includes('Seçilen blokta boş/aktif koltuk bulunamadı')) {
                            logger.warn(`${label}.seat.noSelectable.retry_block`, { cycle, msg });
                            audit('a_seat_pick_retry_no_selectable', { idx: i, email: acc.email, cycle, error: msg }, 'warn');
                            const roamEvery = Math.max(0, Number(getCfg()?.TIMEOUTS?.CATEGORY_ROAM_EVERY_CYCLES || 0) || 0);
                            const baseMode = String(categorySelectionMode || 'legacy').toLowerCase();
                            const mode2 = (baseMode === 'svg') ? categorySelectionMode : ((roamEvery > 0 && (cycle % roamEvery) === 0) ? 'scan' : categorySelectionMode);
                            const cbRes2 = await accountCategoryChooser.choose(page, resolvedCategoryType, resolvedAlternativeCategory, mode2);
                            if (cbRes2 && cbRes2.svgBlockId) {
                                try { catBlock = { ...(catBlock || {}), svgBlockId: cbRes2.svgBlockId }; } catch {}
                            }
                            const catMinTickets2 = (cbRes2?.chosenCategory?.ticketCount && cbRes2.chosenCategory.ticketCount > 1) ? cbRes2.chosenCategory.ticketCount : 1;
                            const effectiveTicketCount2 = Math.max(ticketCount, catMinTickets2);
                            if (effectiveTicketCount2 > 1) {
                                const qtyRes2 = await applyTicketQuantityDropdown(page, `${label}:postCategoryRetry`, effectiveTicketCount2);
                                ticketQuantityPrimed = qtyRes2?.ok === true;
                            }
                            // Reselect can take time (loader). Reset the seat-pick deadline so we don't fail early.
                            cycleStartedAt = Date.now();
                            continue;
                        }
                        throw e;
                    }
                }
                if (!seatInfo) throw new Error(formatError('SEAT_SELECTION_FAILED_A'));
                // Persist SVG block id onto seatInfo so transfer flows can deterministically mount seatmap.
                try {
                    if (catBlock && catBlock.svgBlockId && !seatInfo.svgBlockId) {
                        seatInfo.svgBlockId = String(catBlock.svgBlockId);
                    }
                } catch {}
                const sidNet = await netSeat;
                if (sidNet) {
                    if (!seatInfo.seatId) seatInfo.seatId = sidNet.seatId;
                    if (!seatInfo.row) seatInfo.row = sidNet.row;
                    if (!seatInfo.seat) seatInfo.seat = sidNet.seat;
                }
                setStep(`${label}.seat.pickRandom.done`, { seatInfo, snap: await snapshotPage(page, `${label}.afterSeatPick`) });
                audit('a_hold_acquired', {
                    idx: i,
                    email: acc.email,
                    seatId: seatInfo?.seatId || null,
                    row: seatInfo?.row || null,
                    seat: seatInfo?.seat || null,
                    categoryText: catBlock?.categoryText || null,
                    blockText: catBlock?.blockText || null,
                    blockVal: catBlock?.blockVal || null,
                    ms: Date.now() - seatPickStart,
                    seatSelectionUrl
                });

                // park on basket
                let basketArrivedAtMs = null;
                try {
                    await gotoWithRetry(page, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 2,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                    await page.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 15000 }).catch(() => {});
                    basketArrivedAtMs = Date.now();
                } catch {}
                try {
                    const bd = await readBasketData(page).catch(() => null);
                    if (bd) {
                        const ic = Math.max(Number(seatInfo?.itemCount) || 0, Number(bd.itemCount) || 0);
                        let combinedAll = seatInfo?.combinedAll ? String(seatInfo.combinedAll).trim() : '';
                        if (Array.isArray(bd.heldSeats) && bd.heldSeats.length >= 2) {
                            combinedAll = bd.heldSeats.map((h) => String(h.combined || '').trim()).filter(Boolean).join(' · ');
                        } else if (!combinedAll && ic >= 2 && bd.combined) {
                            combinedAll = `${ic} ürün (sepet) · ${bd.combined}`;
                        }
                        seatInfo = {
                            ...seatInfo,
                            itemCount: ic > 0 ? ic : seatInfo.itemCount,
                            ...(combinedAll ? { combinedAll } : {}),
                            ...(Array.isArray(bd.heldSeats) && bd.heldSeats.length ? { heldSeats: bd.heldSeats } : {})
                        };
                    }
                } catch {}
                const basketTimingPatch = buildBasketTimingPatch({
                    basketArrivedAtMs,
                    remainingSeconds: seatInfo?.remainingTime,
                    observedAtMs: Date.now()
                });

                const dashItemCount = Number.isFinite(Number(seatInfo?.itemCount)) ? Math.floor(Number(seatInfo.itemCount)) : 0;
                audit('a_hold_in_basket', { idx: i, email: acc.email, seatId: seatInfo?.seatId || null, url: (() => { try { return page.url(); } catch { return null; } })() });
                upsertDashboardPairRow(i + 1, {
                    aEmail: acc.email || '',
                    bEmail: '\u2014',
                    aIntent: resolveAIntent(acc),
                    holder: 'A',
                    seatId: seatInfo?.seatId ? String(seatInfo.seatId) : null,
                    seatLabel: fmtSeatLabel(seatInfo),
                    combinedAll: seatInfo?.combinedAll ? String(seatInfo.combinedAll).trim() : null,
                    seatItemCount: dashItemCount >= 2 ? dashItemCount : null,
                    basketItemCount: dashItemCount >= 2 ? dashItemCount : null,
                    tribune: seatInfo?.tribune ?? null,
                    seatRow: seatInfo?.row ?? null,
                    seatNumber: seatInfo?.seat ?? null,
                    phase: normalizeCanPay(acc?.canPay, true)
                        ? (hasCardInfo ? 'A ödeme kuyruğunda' : 'Sepette tutuluyor')
                        : 'C finalize bekliyor',
                    paymentOwnerRole: normalizeCanPay(acc?.canPay, true) ? 'A' : 'C',
                    paymentEligible: normalizeCanPay(acc?.canPay, true),
                    paymentState: normalizeCanPay(acc?.canPay, true) ? (hasCardInfo ? 'queued' : 'waiting') : 'waiting',
                    transferOk: null,
                    unmatched: true,
                    ...basketTimingPatch
                });
                pairRuntimeByIndex.set(i + 1, {
                    pairIndex: i + 1,
                    aCtx: {
                        idx: i,
                        email: acc.email,
                        password: acc.password,
                        browser,
                        page,
                        seatInfo,
                        catBlock,
                        canPay: normalizeCanPay(acc?.canPay, true),
                        transferPurpose: normalizeTransferPurpose(acc?.transferPurpose, false),
                        accountProfile: acc,
                        ...basketTimingPatch
                    },
                    bCtx: null,
                    idProfileA: aList[i] || acc || null,
                    idProfileB: null,
                    currentHolder: 'A',
                    currentSeatInfo: seatInfo || null,
                    currentCatBlock: catBlock || null,
                    ...basketTimingPatch
                });
                await persistBasketRecordForPair(i + 1, {
                    sourceRole: 'A',
                    holderRole: 'A',
                    paymentOwnerRole: normalizeCanPay(acc?.canPay, true) ? 'A' : 'C',
                    paymentState: 'none',
                    recordStatus: 'basketed',
                    aAccountEmail: acc.email,
                    seat: seatInfo,
                    category: catBlock,
                    auditMeta: {
                        phase: 'a_hold_in_basket',
                        seatSelectionUrl,
                        canPay: normalizeCanPay(acc?.canPay, true)
                    }
                });

                return {
                    idx: i,
                    label,
                    email: acc.email,
                    password: acc.password,
                    canPay: normalizeCanPay(acc?.canPay, true),
                    accountProfile: acc,
                    browser,
                    page,
                    seatInfo,
                    catBlock,
                    seatSelectionUrl,
                    basketArrivedAtMs
                };
                } catch (e) {
                    rethrowAsRunKilledIfNeeded(e, `${label}.hold`);
                    audit('a_hold_failed', { idx: i, email: acc.email, error: e?.message || String(e) }, 'warn');
                    logger.warn(`${label} başarısız — tarayıcı kapatılıyor`, { email: acc.email, error: e?.message });
                    try { if (aBrowser) { unregisterPassobotBrowser(aBrowser); await aBrowser.close().catch(() => {}); const bIdx = multiBrowsers.indexOf(aBrowser); if (bIdx >= 0) multiBrowsers.splice(bIdx, 1); } } catch {}
                    return null;
                }
            }

            setStep('MULTI.A.hold.start', { aCount: aList.length, concurrency: multiAConcurrency, multiStaggerMs });
            audit('multi_a_hold_start', { aCount: aList.length, concurrency: multiAConcurrency, multiStaggerMs });
            const rawMultiA = await poolMap(aList, multiAConcurrency, runOneMultiAHold);
            let aCtxList = [];
            for (let ri = 0; ri < rawMultiA.length; ri++) {
                if (rawMultiA[ri]) aCtxList.push(rawMultiA[ri]);
            }

            const aFailedCount = aList.length - aCtxList.length;
            if (aCtxList.length === 0) {
                throw new Error('Tüm A hesapları başarısız oldu — devam edilemiyor');
            }
            if (aFailedCount > 0) {
                audit('multi_a_partial_failure', { total: aList.length, ok: aCtxList.length, failed: aFailedCount });
                logger.warn(`${aFailedCount}/${aList.length} A hesabı başarısız, ${aCtxList.length} hesapla devam ediliyor`);
            }
            setStep('MULTI.A.hold.done', { aCount: aCtxList.length, failedCount: aFailedCount });
            audit('multi_a_hold_done', { aCount: aCtxList.length, failedCount: aFailedCount, aEmails: aCtxList.map(x => x?.email).filter(Boolean) });

            async function processHotAccountQueueTick() {
                if (hotIngestBusy) return;
                const st = runStore.get(runId);
                if (!st || st.status === 'killed' || st.status === 'completed' || st.status === 'error') {
                    try { if (hotAccountIngestTimer) clearInterval(hotAccountIngestTimer); } catch {}
                    hotAccountIngestTimer = null;
                    return;
                }
                const cur0 = st;
                const pendAll = Array.isArray(cur0.pendingHotAccounts?.aCredentialIds)
                    ? cur0.pendingHotAccounts.aCredentialIds
                    : [];
                if (!pendAll.length) return;
                hotIngestBusy = true;
                try {
                    const cur = runStore.get(runId) || cur0;
                    const pend = Array.isArray(cur.pendingHotAccounts?.aCredentialIds)
                        ? [...cur.pendingHotAccounts.aCredentialIds]
                        : [];
                    if (!pend.length) return;
                    const head = String(pend.shift() || '').trim();
                    if (!head || !teamId) return;
                    const docs = await credentialRepo.getCredentialsByIds(teamId, [head]);
                    if (!docs.length) {
                        logger.warnSafe('hot_account_credential_missing', { runId, credentialId: head });
                        // ID'yi geri kuyruğa ekleme — silinmiş/pasif credential, kayıt kaybı yok
                        return;
                    }
                    // Doğrulama geçti; şimdi store'dan kaldır
                    runStore.upsert(runId, {
                        pendingHotAccounts: {
                            ...(cur.pendingHotAccounts || {}),
                            aCredentialIds: pend
                        }
                    });
                    const item = docs[0];
                    const payerSet = new Set(
                        Array.isArray(cur.pendingHotAccounts?.payerACredentialIds)
                            ? cur.pendingHotAccounts.payerACredentialIds.map((x) => String(x || '').trim()).filter(Boolean)
                            : []
                    );
                    const transferSet = new Set(
                        Array.isArray(cur.pendingHotAccounts?.transferACredentialIds)
                            ? cur.pendingHotAccounts.transferACredentialIds.map((x) => String(x || '').trim()).filter(Boolean)
                            : []
                    );
                    const credId = String(item.id || '');
                    const acc = {
                        email: String(item.email || ''),
                        password: decryptSecret(item.encryptedPassword),
                        identity: item.identity || null,
                        fanCardCode: item.fanCardCode || null,
                        sicilNo: item.sicilNo || null,
                        priorityTicketCode: item.priorityTicketCode || null,
                        categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds.map(String) : [],
                        canPay: payerSet.has(credId),
                        transferPurpose: transferSet.has(credId)
                    };
                    const useIdx = dynamicMultiAIndex;
                    audit('hot_a_account_start', { email: acc.email, idx: useIdx });
                    const ctx = await runOneMultiAHold(acc, useIdx);
                    dynamicMultiAIndex += 1;
                    if (ctx) {
                        aCtxList.push(ctx);
                        upsertPaymentQueueEntry({
                            pairIndex: ctx.idx + 1,
                            paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                            paymentEligible: ctx?.canPay !== false,
                            paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                            aEmail: ctx?.email || '',
                            bEmail: null
                        });
                        try { syncDashboardToRunStore(); } catch {}
                    }
                    audit('hot_a_account_done', { email: acc.email, ok: !!ctx });
                } catch (e) {
                    try {
                        logger.warnSafe('hot_account_ingest_failed', { runId, error: e?.message || String(e) });
                    } catch {}
                } finally {
                    hotIngestBusy = false;
                }
            }

            hotAccountIngestTimer = setInterval(() => {
                processHotAccountQueueTick().catch(() => {});
            }, 3200);

            // B hesabı yoksa: transfer loop yok, direkt ödeme veya hold
            if (!hasRealB) {
                audit('multi_a_only_mode', { aCount: aCtxList.length, hasCardInfo });
                logger.info('A-only mod: B hesabi tanimli degil, transfer yapilmayacak');

                dashboardPairs = aCtxList.map((ctx, i) => {
                    const pairIndex = i + 1;
                    const runtime = pairRuntimeByIndex.get(pairIndex) || null;
                    const basketTimingPatch = resolveRuntimeBasketTiming(runtime, 'A');
                    return {
                        pairIndex,
                        aEmail: ctx.email || '',
                        bEmail: '\u2014',
                        aIntent: resolveAIntent(ctx),
                        holder: ctx?.seatInfo?.seatId ? 'A' : null,
                        seatId: ctx?.seatInfo?.seatId ? String(ctx.seatInfo.seatId) : null,
                        seatLabel: fmtSeatLabel(ctx?.seatInfo),
                        combinedAll: ctx?.seatInfo?.combinedAll ? String(ctx.seatInfo.combinedAll).trim() : null,
                        seatItemCount: Number.isFinite(Number(ctx?.seatInfo?.itemCount)) && Number(ctx.seatInfo.itemCount) > 1
                            ? Math.floor(Number(ctx.seatInfo.itemCount))
                            : null,
                        phase: ctx?.canPay === false ? 'C finalize bekliyor' : (hasCardInfo ? 'A ödeme kuyruğunda' : 'Sepette tutuluyor'),
                        paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                        paymentEligible: ctx?.canPay !== false,
                        paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                        transferOk: null,
                        unmatched: true,
                        ...basketTimingPatch
                    };
                });
                aCtxList.forEach((ctx, i) => {
                    const pairIndex = i + 1;
                    const prevRuntime = pairRuntimeByIndex.get(pairIndex) || {};
                    const basketTimingPatch = resolveRuntimeBasketTiming(prevRuntime, 'A');
                    pairRuntimeByIndex.set(pairIndex, {
                        ...prevRuntime,
                        pairIndex,
                        aCtx: {
                            ...(prevRuntime?.aCtx || {}),
                            ...ctx,
                            ...basketTimingPatch
                        },
                        bCtx: null,
                        idProfileA: aList[i] || ctx?.accountProfile || null,
                        idProfileB: null,
                        currentHolder: ctx?.seatInfo?.seatId ? 'A' : null,
                        currentSeatInfo: ctx?.seatInfo || null,
                        currentCatBlock: ctx?.catBlock || null,
                        ...basketTimingPatch
                    });
                    upsertPaymentQueueEntry({
                        pairIndex,
                        paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                        paymentEligible: ctx?.canPay !== false,
                        paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                        aEmail: ctx?.email || '',
                        bEmail: null
                    });
                });
                syncDashboardToRunStore();

                const primaryA = aCtxList.find((ctx) => ctx?.canPay !== false) || aCtxList[0];
                const primaryPairIndex = Math.max(1, (aCtxList.indexOf(primaryA) + 1) || 1);
                dashboardMeta.activePairIndex = primaryPairIndex;
                paymentQueueActivePairIndex = primaryPairIndex;
                browserA = primaryA.browser;
                pageA = primaryA.page;
                emailA = primaryA.email;
                passwordA = primaryA.password;
                seatInfoA = primaryA.seatInfo;
                catBlockA = primaryA.catBlock || catBlockA;

                basketTimer = new BasketTimer();
                basketTimer.start();
                setHolder('A', seatInfoA, catBlockA);
                if (primaryA?.canPay !== false) {
                    await preparePaymentOnA(primaryPairIndex, seatInfoA);
                } else {
                    markPairPaymentState(primaryPairIndex, {
                        paymentOwnerRole: 'C',
                        paymentEligible: false,
                        paymentState: 'waiting',
                        phase: 'C finalize bekliyor'
                    });
                }
                if (hasCardInfo && primaryA?.canPay !== false) logger.info('A-only mod: Odeme sayfasi hazir, onay bekleniyor');
                else {
                    logger.info('A-only mod: Kart bilgisi yok, sepette tutuluyor');
                    audit('a_only_holding', { email: emailA, seatId: seatInfoA?.seatId });
                }

                // A-only koşu tamamlanıyor: sıcak hesap zamanlayıcısını durdur
                try { if (hotAccountIngestTimer) clearInterval(hotAccountIngestTimer); } catch {}
                hotAccountIngestTimer = null;

                const finalStatus = basketTimer.getStatus();
                try { runStore.upsert(runId, { status: 'completed', result: { success: true, mode: 'a_only', aEmail: emailA, seatInfo: seatInfoA, basketStatus: finalStatus, payment: hasCardInfo ? 'ready' : 'no_card' } }); } catch {}
                return res.json({ success: true, mode: 'a_only', aEmail: emailA, seatInfo: seatInfoA, basketStatus: finalStatus, payment: hasCardInfo ? 'ready' : 'no_card' });
            }

            // A koltukları kapıldı, şimdi B hesaplarını hazırla (A sepette beklerken)
            const bCtxList = await bCtxFn();
            setStep('MULTI.aFirst.done', { aCount: aCtxList.length, bCount: bCtxList.length });

            const pairCount = Math.min(aCtxList.length, bCtxList.length);
            const stDash = runStore.get(runId) || {};
            let wantPairDash = parseInt(String(stDash.cTransferPairIndex ?? validatedData.cTransferPairIndex ?? 1), 10);
            if (!Number.isFinite(wantPairDash) || wantPairDash < 1) wantPairDash = 1;
            if (wantPairDash > pairCount) wantPairDash = pairCount;
            dashboardMeta.cTargetPairIndex = wantPairDash;
            dashboardPairs = aCtxList.slice(0, pairCount).map((ctx, i) => {
                const hasA = !!(ctx?.seatInfo?.seatId);
                return {
                    pairIndex: i + 1,
                    aEmail: ctx.email || '',
                    bEmail: bList[i]?.email || '',
                    holder: hasA ? 'A' : null,
                    seatId: ctx?.seatInfo?.seatId ? String(ctx.seatInfo.seatId) : null,
                    seatLabel: fmtSeatLabel(ctx?.seatInfo),
                    phase: hasA ? 'A sepette — B transfer bekleniyor' : 'A hazırlık',
                    paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                    paymentEligible: ctx?.canPay !== false,
                    paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    transferOk: null
                };
            });
            for (let j = 0; j < aCtxList.length - pairCount; j++) {
                const ctx = aCtxList[pairCount + j];
                const hasA = !!(ctx?.seatInfo?.seatId);
                dashboardPairs.push({
                    pairIndex: pairCount + j + 1,
                    aEmail: ctx.email || '',
                    bEmail: '—',
                    holder: hasA ? 'A' : null,
                    seatId: ctx?.seatInfo?.seatId ? String(ctx.seatInfo.seatId) : null,
                    seatLabel: fmtSeatLabel(ctx?.seatInfo),
                    phase: ctx?.canPay === false ? 'C finalize bekliyor (B yok)' : 'A ödeme kuyruğunda (B yok)',
                    paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                    paymentEligible: ctx?.canPay !== false,
                    paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    transferOk: null,
                    unmatched: true
                });
                const pairIndex = pairCount + j + 1;
                pairRuntimeByIndex.set(pairIndex, {
                    pairIndex,
                    aCtx: ctx,
                    bCtx: null,
                    idProfileA: aList[pairIndex - 1] || ctx?.accountProfile || null,
                    idProfileB: null,
                    currentHolder: hasA ? 'A' : null,
                    currentSeatInfo: ctx?.seatInfo || null,
                    currentCatBlock: ctx?.catBlock || null
                });
                upsertPaymentQueueEntry({
                    pairIndex,
                    paymentOwnerRole: ctx?.canPay === false ? 'C' : 'A',
                    paymentEligible: ctx?.canPay !== false,
                    paymentState: ctx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    aEmail: ctx?.email || '',
                    bEmail: null
                });
            }
            syncDashboardToRunStore();

            // 3) Transfer phase: A[i] -> B[i] if B exists, otherwise keep A holding.
            setStep('MULTI.transfer.start', { pairs: pairCount });
            audit('multi_transfer_start', { pairCount });
            const results = [];
            for (let i = 0; i < pairCount; i++) {
                assertRunNotKilled(`multi_transfer_${i}`);
                const aCtx = aCtxList[i];
                const bCtx = bCtxList[i];
                if (!aCtx?.seatInfo?.seatId) {
                    results.push({ idx: i, ok: false, error: 'A seatId yok', seatA: aCtx?.seatInfo || null });
                    audit('transfer_pair_skip_no_seatid', { idx: i, aEmail: aCtx?.email || null, bEmail: bCtx?.email || null }, 'warn');
                    upsertPaymentQueueEntry({
                        pairIndex: i + 1,
                        paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                        paymentEligible: aCtx?.canPay !== false,
                        paymentState: 'failed',
                        aEmail: aCtx?.email || '',
                        bEmail: bCtx?.email || ''
                    });
                    await persistFailureForPair(i + 1, {
                        paymentState: 'failed',
                        finalizeState: 'failed',
                        recordStatus: 'failed',
                        aAccountEmail: aCtx?.email || '',
                        bAccountEmail: bCtx?.email || '',
                        seat: aCtx?.seatInfo || null,
                        category: aCtx?.catBlock || null,
                        auditMeta: { phase: 'transfer_pair_skip_no_seatid' }
                    });
                    if (dashboardPairs[i]) {
                        dashboardPairs[i] = { ...dashboardPairs[i], phase: 'Hata: A koltuk yok', transferOk: false, holder: null, paymentState: 'failed' };
                        syncDashboardToRunStore();
                    }
                    continue;
                }

                if (aCtx?.canPay !== false) {
                    results.push({
                        idx: i,
                        ok: true,
                        keptOnA: true,
                        seatA: aCtx.seatInfo,
                        seatB: null,
                        aEmail: aCtx.email,
                        bEmail: bCtx?.email || null
                    });
                    audit('payer_pair_kept_on_a', {
                        idx: i,
                        seatId: aCtx.seatInfo.seatId,
                        aEmail: aCtx.email,
                        bEmail: bCtx?.email || null,
                        hasCardInfo
                    });
                    upsertDashboardPairRow(i + 1, {
                        aEmail: aCtx.email || '',
                        bEmail: bCtx?.email || '',
                        holder: 'A',
                        seatId: aCtx?.seatInfo?.seatId ? String(aCtx.seatInfo.seatId) : null,
                        seatLabel: fmtSeatLabel(aCtx?.seatInfo),
                        combinedAll: aCtx?.seatInfo?.combinedAll ? String(aCtx.seatInfo.combinedAll).trim() : null,
                        seatItemCount: Number.isFinite(Number(aCtx?.seatInfo?.itemCount)) && Number(aCtx.seatInfo.itemCount) > 1
                            ? Math.floor(Number(aCtx.seatInfo.itemCount))
                            : null,
                        tribune: aCtx?.seatInfo?.tribune ?? null,
                        seatRow: aCtx?.seatInfo?.row ?? null,
                        seatNumber: aCtx?.seatInfo?.seat ?? null,
                        phase: hasCardInfo ? 'A ödeme kuyruğunda' : 'Sepette tutuluyor',
                        paymentOwnerRole: 'A',
                        paymentEligible: true,
                        paymentState: hasCardInfo ? 'queued' : 'waiting',
                        transferOk: null
                    });
                    pairRuntimeByIndex.set(i + 1, {
                        pairIndex: i + 1,
                        aCtx,
                        bCtx,
                        idProfileA: aList[i] || aCtx?.accountProfile || null,
                        idProfileB: bList[i] || null,
                        currentHolder: 'A',
                        currentSeatInfo: aCtx?.seatInfo || null,
                        currentCatBlock: aCtx?.catBlock || null
                    });
                    upsertPaymentQueueEntry({
                        pairIndex: i + 1,
                        paymentOwnerRole: 'A',
                        paymentEligible: true,
                        paymentState: hasCardInfo ? 'queued' : 'waiting',
                        aEmail: aCtx?.email || '',
                        bEmail: bCtx?.email || ''
                    });
                    continue;
                }

                setStep(`PAIR${i}.start`, { a: aCtx.email, b: bCtx.email, seatId: aCtx.seatInfo.seatId });
                const pairStart = Date.now();
                audit('transfer_pair_start', {
                    idx: i,
                    seatId: aCtx.seatInfo.seatId,
                    aEmail: aCtx.email,
                    bEmail: bCtx.email,
                    categoryText: aCtx?.catBlock?.categoryText || null,
                    blockText: aCtx?.catBlock?.blockText || null,
                    blockVal: aCtx?.catBlock?.blockVal || null,
                    transferTargetEmail: transferTargetEmail || null
                });

                // attach recovery options for exact pick
                try {
                    aCtx.seatInfo.__recoveryOptions = {
                        context: `B${i}`,
                        expectedUrlIncludes: '/koltuk-secim',
                        recoveryUrl: bCtx.seatSelectionUrl,
                        email: bCtx.email,
                        password: bCtx.password,
                        reloginIfRedirected,
                        ensureTurnstileFn: ensureCaptchaOnPage
                    };
                } catch {}

                // Do NOT mount seatmap pre-release. Just confirm B is on seat selection and ready.
                audit('b_ready_for_exact_pick', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, url: (() => { try { return bCtx.page.url(); } catch { return null; } })() });

                // remove from A basket
                const aRemoveStartedAt = Date.now();
                let aRemoveAttempts = 0;
                audit('a_remove_from_basket_flow_start', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId });

                const ensureRemoveDelayAfterBasket = async () => {
                    const minMsRaw = Number(getCfg()?.BASKET?.REMOVE_MIN_AFTER_BASKET_MS);
                    const minMs = Number.isFinite(minMsRaw) ? Math.max(0, minMsRaw) : 30000;

                    const sleep = async (ms) => { try { await delay(ms); } catch {} };

                    // Prefer UI countdown on /sepet (mm:ss) to know true basket remaining time.
                    // This avoids relying on our local timestamps when navigation/reloads happen.
                    try {
                        // Wait a bit for the countdown widget to mount
                        try {
                            await aCtx.page.waitForSelector('basket-countdown .basket-remaining-container, .basket-remaining-container', { timeout: 5000 });
                        } catch {}

                        const holdSec = Number(getCfg()?.BASKET?.HOLDING_TIME_SECONDS);
                        if (Number.isFinite(holdSec) && holdSec > 0) {
                            for (let r = 0; r < 8; r++) {
                                const ui = await checkBasketTimeoutFromPage(aCtx.page);
                                const remSec = Number(ui?.remainingSeconds);
                                if (Number.isFinite(remSec)) {
                                    const elapsedSec = Math.max(0, holdSec - remSec);
                                    const elapsedMs = elapsedSec * 1000;
                                    if (elapsedMs < minMs) {
                                        const waitMs = minMs - elapsedMs;
                                        audit('a_remove_from_basket_wait_min_hold', {
                                            idx: i,
                                            aEmail: aCtx.email,
                                            seatId: aCtx.seatInfo.seatId,
                                            waitMs,
                                            elapsedMs,
                                            minMs,
                                            source: 'ui_timer',
                                            remainingSeconds: remSec
                                        });
                                        await sleep(waitMs);
                                        return;
                                    }
                                    return;
                                }
                                await sleep(400);
                            }
                        }
                    } catch {}

                    // Fallback: local timestamp since we first observed /sepet.
                    const arrivedAt = Number.isFinite(aCtx?.basketArrivedAtMs) ? aCtx.basketArrivedAtMs : null;
                    if (!arrivedAt) {
                        // Last-resort: enforce a conservative wait so we don't remove immediately.
                        if (minMs > 0) {
                            audit('a_remove_from_basket_wait_min_hold', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, waitMs: minMs, elapsedMs: 0, minMs, source: 'fallback_sleep' });
                            await sleep(minMs);
                        }
                        return;
                    }
                    const elapsed = Date.now() - arrivedAt;
                    if (elapsed < minMs) {
                        const waitMs = minMs - elapsed;
                        audit('a_remove_from_basket_wait_min_hold', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, waitMs, elapsedMs: elapsed, minMs, source: 'timestamp' });
                        await sleep(waitMs);
                    }
                };

                // A oturumu hold sırasında bitmiş olabilir; sepete gitmeden önce yeniden giriş kontrolü yap.
                try { await reloginIfRedirected(aCtx.page, aCtx.email, aCtx.password); } catch {}
                try {
                    await gotoWithRetry(aCtx.page, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 1,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 350
                    });
                } catch {}
                let removed = false;
                let removeDiag = null;

                // ── Seat Availability Watcher: A bırakmadan önce B'nin sayfasında watcher başlat ──
                // Böylece A clearBasket yaptığı anda koltuk müsait görünür görünmez B haberdar olur.
                const _watcherBlockId = resolveApiBlockId(aCtx.seatInfo);
                const _watcherAc = new AbortController();
                let _transferWatcherP = null;
                if (_watcherBlockId && bCtx?.page) {
                    const _evId = String(eventAddress || '').split('/').filter(Boolean).pop() || '';
                    if (_evId && /^\d+$/.test(_evId)) {
                        _transferWatcherP = startSeatAvailabilityWatcher(bCtx.page, {
                            eventId: _evId,
                            serieId: '',
                            blockIds: [_watcherBlockId],
                            targetSeatIds: aCtx.seatInfo.seatId ? [Number(aCtx.seatInfo.seatId)] : null,
                            intervalMs: 600,
                            timeoutMs: 60_000,
                            signal: _watcherAc.signal,
                        }).catch(() => null);
                        audit('transfer_watcher_started', {
                            idx: i, bEmail: bCtx.email,
                            blockId: _watcherBlockId,
                            seatId: aCtx.seatInfo.seatId,
                        });
                    }
                }
                // ────────────────────────────────────────────────────────────────────────────────

                await ensureRemoveDelayAfterBasket();
                for (let attempt = 1; attempt <= 3; attempt++) {
                    if (removed) break;
                    aRemoveAttempts = attempt;
                    const beforeItemCount = await getBasketItemCountSafe(aCtx.page);
                    audit('a_remove_from_basket_start', { idx: i, aEmail: aCtx.email, seatId: aCtx.seatInfo.seatId, attempt, beforeItemCount });
                    removeDiag = await clearBasketFully(aCtx.page, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
                    removed = removeDiag?.ok === true;
                    if (removed) break;
                    try { await delay(1500); } catch {}
                }

                // Sepet zaten boşsa (oturum bitmişse veya süre dolmuşsa) yanlış success — uyar.
                if (removed && removeDiag?.initialCount === 0 && removeDiag?.removedClicks === 0) {
                    audit('a_remove_basket_was_already_empty', {
                        idx: i,
                        aEmail: aCtx.email,
                        seatId: aCtx.seatInfo.seatId,
                        note: 'Sepet boş geldi — oturum süresi bitmiş veya bilet daha önce düşmüş olabilir'
                    }, 'warn');
                }

                if (!removed) {
                    results.push({ idx: i, ok: false, error: formatError('REMOVE_FROM_CART_FAILED'), seatA: aCtx.seatInfo });
                    audit('a_remove_from_basket_failed', {
                        idx: i,
                        aEmail: aCtx.email,
                        seatId: aCtx.seatInfo.seatId,
                        ms: Date.now() - aRemoveStartedAt,
                        attempts: aRemoveAttempts,
                        remainingItemCount: removeDiag?.remainingCount ?? null,
                        removedClicks: removeDiag?.removedClicks ?? null
                    }, 'warn');
                    if (dashboardPairs[i]) {
                        dashboardPairs[i] = { ...dashboardPairs[i], phase: 'Hata: A sepetten kaldırılamadı', transferOk: false, holder: 'A', paymentState: 'failed' };
                        syncDashboardToRunStore();
                    }
                    upsertPaymentQueueEntry({
                        pairIndex: i + 1,
                        paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                        paymentEligible: aCtx?.canPay !== false,
                        paymentState: 'failed',
                        aEmail: aCtx?.email || '',
                        bEmail: bCtx?.email || ''
                    });
                    await persistFailureForPair(i + 1, {
                        paymentState: 'failed',
                        finalizeState: 'failed',
                        recordStatus: 'failed',
                        aAccountEmail: aCtx?.email || '',
                        bAccountEmail: bCtx?.email || '',
                        seat: aCtx?.seatInfo || null,
                        category: aCtx?.catBlock || null,
                        auditMeta: { phase: 'a_remove_from_basket_failed' }
                    });
                    continue;
                }

                audit('a_remove_from_basket_done', {
                    idx: i,
                    aEmail: aCtx.email,
                    seatId: aCtx.seatInfo.seatId,
                    ms: Date.now() - aRemoveStartedAt,
                    attempts: aRemoveAttempts,
                    initialItemCount: removeDiag?.initialCount ?? null,
                    remainingItemCount: removeDiag?.remainingCount ?? null,
                    removedClicks: removeDiag?.removedClicks ?? null
                });

                // A bıraktı → B kategoriyi şimdi seçiyor → seatmap SIFIRDAN açılıyor.
                // B daha önce seatmap açmadı (kategori listesinde bekliyordu); böylece
                // seatmap ilk açıldığında koltuk zaten serbest görünür, yenileme gerekmez.
                setStep(`PAIR${i}.b_apply_catblock.start`);
                audit('b_apply_catblock_start', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId });

                try {
                    await applyCategoryBlockSelection(bCtx.page, categorySelectionMode, aCtx.catBlock, aCtx.seatInfo);
                    audit('b_catblock_applied', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId });
                } catch (e) {
                    audit('b_catblock_apply_warn', { idx: i, bEmail: bCtx.email, error: e?.message }, 'warn');
                }

                setStep(`PAIR${i}.b_apply_catblock.done`);

                // start B exact pick immediately with short timeout for fast response
                const transferTargets = normalizeHeldSeats(aCtx.seatInfo);
                const exactMaxMs = Math.max(30000, Math.min((getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0) * Math.max(1, transferTargets.length || 1), 120000));

                audit('b_exact_pick_start', {
                    idx: i,
                    bEmail: bCtx.email,
                    seatId: aCtx.seatInfo.seatId,
                    heldSeatCount: transferTargets.length || 1,
                    maxMs: exactMaxMs,
                    seatmapReady: bCtx.seatmapReady
                });
                const exactPromise = pickExactSeatBundleReleaseAware(bCtx.page, aCtx.seatInfo, exactMaxMs, {
                    audit: (phase, payload) => audit(`b_${phase}`, { idx: i, bEmail: bCtx.email, ...payload })
                });

                let seatBInfo = null;
                try {
                    seatBInfo = await exactPromise;
                } catch (e) {
                    // Watcher'ı durdur — pick tamamlandı (başarısız)
                    _watcherAc.abort();
                    results.push({ idx: i, ok: false, error: e?.message || String(e), seatA: aCtx.seatInfo });
                    audit('b_exact_pick_failed', { idx: i, bEmail: bCtx.email, seatId: aCtx.seatInfo.seatId, error: e?.message || String(e) }, 'warn');
                    if (dashboardPairs[i]) {
                        dashboardPairs[i] = { ...dashboardPairs[i], phase: 'Hata: B koltuğu alamadı', transferOk: false, holder: null, paymentState: 'failed' };
                        syncDashboardToRunStore();
                    }
                    upsertPaymentQueueEntry({
                        pairIndex: i + 1,
                        paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                        paymentEligible: aCtx?.canPay !== false,
                        paymentState: 'failed',
                        aEmail: aCtx?.email || '',
                        bEmail: bCtx?.email || ''
                    });
                    await persistFailureForPair(i + 1, {
                        paymentState: 'failed',
                        finalizeState: 'failed',
                        recordStatus: 'failed',
                        aAccountEmail: aCtx?.email || '',
                        bAccountEmail: bCtx?.email || '',
                        seat: aCtx?.seatInfo || null,
                        category: aCtx?.catBlock || null,
                        auditMeta: { phase: 'b_exact_pick_failed', error: e?.message || String(e) }
                    });
                    continue;
                }

                // Watcher'ı durdur — pick başarıyla tamamlandı
                _watcherAc.abort();

                audit('b_exact_pick_done', {
                    idx: i,
                    bEmail: bCtx.email,
                    seatId: aCtx.seatInfo.seatId,
                    pickedSeatId: seatBInfo?.seatId || null,
                    row: seatBInfo?.row || null,
                    seat: seatBInfo?.seat || null,
                    heldSeatCount: Array.isArray(seatBInfo?.heldSeats) ? seatBInfo.heldSeats.length : (seatBInfo?.itemCount || null)
                });
                const basketTimingPatch = buildBasketTimingPatch({
                    basketArrivedAtMs: Date.now(),
                    remainingSeconds: seatBInfo?.remainingTime,
                    observedAtMs: Date.now()
                });

                results.push({ idx: i, ok: true, seatA: aCtx.seatInfo, seatB: seatBInfo, aEmail: aCtx.email, bEmail: bCtx.email });
                setStep(`PAIR${i}.done`, { ok: true, seatId: aCtx.seatInfo.seatId });
                audit('transfer_pair_done', {
                    idx: i,
                    ok: true,
                    seatId: aCtx.seatInfo.seatId,
                    aEmail: aCtx.email,
                    bEmail: bCtx.email,
                    ms: Date.now() - pairStart
                });

                if (dashboardPairs[i]) {
                    dashboardPairs[i] = {
                        ...dashboardPairs[i],
                        holder: 'B',
                        seatId: seatBInfo?.seatId ? String(seatBInfo.seatId) : dashboardPairs[i].seatId,
                        seatLabel: fmtSeatLabel(seatBInfo),
                        phase: aCtx?.canPay === false ? 'B sepette — C finalize bekliyor' : 'B sepette — A ödeme kuyruğunda',
                        paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                        paymentEligible: aCtx?.canPay !== false,
                        paymentState: aCtx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                        transferOk: true,
                        ...basketTimingPatch
                    };
                    syncDashboardToRunStore();
                }
                pairRuntimeByIndex.set(i + 1, {
                    pairIndex: i + 1,
                    aCtx,
                    bCtx: {
                        ...(bCtx || {}),
                        ...basketTimingPatch
                    },
                    idProfileA: aList[i] || aCtx?.accountProfile || null,
                    idProfileB: bList[i] || null,
                    currentHolder: 'B',
                    currentSeatInfo: seatBInfo || aCtx?.seatInfo || null,
                    currentCatBlock: aCtx?.catBlock || null,
                    ...basketTimingPatch
                });
                upsertPaymentQueueEntry({
                    pairIndex: i + 1,
                    paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                    paymentEligible: aCtx?.canPay !== false,
                    paymentState: aCtx?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    aEmail: aCtx?.email || '',
                    bEmail: bCtx?.email || ''
                });
                await persistTransferForPair(i + 1, {
                    sourceRole: 'B',
                    holderRole: 'B',
                    paymentOwnerRole: aCtx?.canPay === false ? 'C' : 'A',
                    recordStatus: 'transferred',
                    aAccountEmail: aCtx?.email || '',
                    bAccountEmail: bCtx?.email || '',
                    seat: seatBInfo,
                    category: aCtx?.catBlock || null,
                    auditMeta: {
                        phase: 'transfer_pair_done',
                        aEmail: aCtx?.email || '',
                        bEmail: bCtx?.email || '',
                        canPay: aCtx?.canPay !== false
                    }
                });
            }
            setStep('MULTI.transfer.done', { resultsCount: results.length });
            audit('multi_transfer_done', { resultsCount: results.length });

            // Keep A accounts without matching B holding in basket.
            const holdingOnly = aCtxList.slice(pairCount).map(a => ({ idx: a.idx, email: a.email, seatInfo: a.seatInfo }));
            audit('multi_holding_only', { count: holdingOnly.length, holdingOnly: holdingOnly.map(x => ({ idx: x.idx, email: x.email, seatId: x?.seatInfo?.seatId || null })) });

            const successfulPairs = results.filter((r) => r && r.ok === true && r.keptOnA !== true);
            const successfulPayablePairs = results.filter((r) => r && r.ok === true && aCtxList[r.idx]?.canPay !== false);
            if (!results.some((r) => r && r.ok === true) && !holdingOnly.length) {
                throw new Error('Hiç başarılı A/B transferi oluşmadı');
            }

            const stRun = runStore.get(runId) || {};
            let pairWant = parseInt(String(stRun.cTransferPairIndex ?? validatedData.cTransferPairIndex ?? 1), 10);
            if (!Number.isFinite(pairWant) || pairWant < 1) pairWant = 1;
            if (pairWant > pairCount) pairWant = pairCount;
            const chosen = successfulPairs.find((r) => r.idx === (pairWant - 1));
            const firstSuccessful = successfulPairs[0] || null;
            const firstPayable = successfulPayablePairs[0] || null;

            if (chosen) {
                const aPick = aCtxList[chosen.idx];
                const bPick = bCtxList[chosen.idx];
                browserA = aPick.browser;
                pageA = aPick.page;
                browserB = bPick.browser;
                pageB = bPick.page;
                emailA = aPick.email;
                passwordA = aPick.password;
                emailB = bPick.email;
                passwordB = bPick.password;
                idProfileA = aList[chosen.idx] || idProfileA;
                idProfileB = bList[chosen.idx] || idProfileB;
                seatInfoA = chosen.seatA;
                seatInfoB = chosen.seatB;
                catBlockA = { ...(aPick.catBlock || { categoryText: '', blockText: '', blockVal: '' }) };
                updatePairRuntime(pairWant, {
                    currentHolder: 'B',
                    currentSeatInfo: seatInfoB || seatInfoA || null,
                    currentCatBlock: catBlockA
                });
                dashboardPairs = dashboardPairs.map((row) => {
                    if (row.unmatched) return row;
                    if (row.pairIndex === pairWant) {
                        const base = String(row.phase || '').trim();
                        const next = base.includes('C hedefi') ? base : (base ? `${base} · C hedefi` : 'C hedefi');
                        return { ...row, phase: next };
                    }
                    return row;
                });
                dashboardMeta.cTargetPairIndex = pairWant;
                dashboardMeta.activePairIndex = pairWant;
                paymentQueueActivePairIndex = pairWant;
                setHolder('B', seatInfoB, catBlockA);
                basketTimer = new BasketTimer();
                basketTimer.start();
                audit('multi_bind_for_c', {
                    cTransferPairIndex: pairWant,
                    aEmail: emailA,
                    bEmail: emailB,
                    seatId: seatInfoB?.seatId || null
                });
                logger.infoSafe('Çoklu mod: C/finalize için seçilen eşleşme bağlandı', {
                    cTransferPairIndex: pairWant,
                    aEmail: emailA,
                    bEmail: emailB,
                    seatId: seatInfoB?.seatId || null
                });
            } else if (firstSuccessful) {
                bindPairRuntime(firstSuccessful.idx + 1, 'first_successful_pair');
            }

            if (hasCardInfo && firstPayable) {
                paymentQueueActivePairIndex = null;
                dashboardMeta.activePairIndex = null;
                try { ensurePaymentQueueWatcher(); } catch {}
                try { ensureDeferredPayableTransferWatcher(); } catch {}
                try { await processNextAPaymentQueue(); } catch (queueErr) {
                    audit('a_payment_queue_prepare_failed', { pairIndex: firstPayable.idx + 1, error: queueErr?.message || String(queueErr) }, 'warn');
                }
            }
            try { ensureFinalizeWatcher(); } catch {}
            try { syncDashboardToRunStore(); } catch {}

            multiPostTransferReady = true;
        }

        if (!multiPostTransferReady) {
        // A: Launch + Login
        setStep('A.launchAndLogin.start', { email: emailA });
        audit('account_launch_start', { role: 'A', idx: 0, email: emailA });
        ({browser: browserA, page: pageA} = await launchAndLoginWithManagedProxy({
            email: emailA,
            password: passwordA,
            userDataDir: userDataDirA
        }, { role: 'A', idx: 0, email: emailA }));
        registerPassobotBrowser(browserA, runId);
        setStep('A.launchAndLogin.done', { email: emailA, snap: await snapshotPage(pageA, 'A.afterLogin') });
        audit('account_launch_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });
        logger.info('A hesabı giriş yaptı');

        // B login, A koltuk kapıp sepete girdikten sonra yapılacak (A öncelikli)

        // Start finalize watcher (A sayfası hazır, C finalize A holder üzerinden çalışır).
        try { ensureFinalizeWatcher(); } catch {}

        if (!dashboardPairs.length) {
            dashboardMeta.cTargetPairIndex = 1;
            dashboardPairs = [{
                pairIndex: 1,
                aEmail: emailA,
                bEmail: emailB,
                holder: null,
                seatId: null,
                seatLabel: '—',
                phase: 'Başlatılıyor',
                transferOk: null
            }];
            syncDashboardToRunStore();
        }

        // A: go event -> BUY -> ticket type (if present) -> category/block -> random seat
        setStep('A.gotoEvent.start', { eventAddress });
        audit('account_goto_event_start', { role: 'A', idx: 0, email: emailA, eventAddress });
        const aGoto = await gotoWithRetry(pageA, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('A.gotoEvent.done', { goto: aGoto, snap: await snapshotPage(pageA, 'A.afterEventGoto') });
        audit('account_goto_event_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        await installRecaptchaCallbackInterceptor(pageA);
        setStep('A.clickBuy.start');
        audit('account_click_buy_start', { role: 'A', idx: 0, email: emailA });
        const clickedA = await clickBuy(pageA, eventAddress);
        if (!clickedA) throw new Error(formatError('BUY_BUTTON_FAILED_A'));
        setStep('A.clickBuy.done');
        audit('account_click_buy_done', { role: 'A', idx: 0, email: emailA, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        await handlePrioritySaleModal(pageA, { prioritySale, fanCardCode: a0?.fanCardCode ?? fanCardCode, identity: a0?.identity ?? identity, sicilNo: a0?.sicilNo ?? sicilNo, priorityTicketCode: a0?.priorityTicketCode ?? priorityTicketCode, priorityPhone: a0?.phone ?? priorityPhone, priorityTckn });
        logger.info('A hesabı SATIN AL butonuna tıkladı');

        setStep('A.waitNavAfterBuy.start');
        const aPreUrl = (() => { try { return pageA.url(); } catch { return null; } })();
        const aNavResult = await Promise.race([
            pageA.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
                .then(() => ({ type: 'navigation' }))
                .catch((e) => ({ type: 'nav_error', message: e?.message })),
            waitForFunctionSafe(pageA, (pre) => location.href !== pre, { timeout: 10000 }, aPreUrl)
                .then(() => ({ type: 'url_change' }))
                .catch((e) => ({ type: 'url_wait_error', message: e?.message })),
            delay(10000).then(() => ({ type: 'timeout' }))
        ]);
        await pageA.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 10000 }).catch(() => {});
        setStep('A.waitNavAfterBuy.done', { result: aNavResult, snap: await snapshotPage(pageA, 'A.afterBuyNav') });

        setStep('A.postBuy.ensureUrl.start');
        const aUrlCheck = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        setStep('A.postBuy.ensureUrl.done', { urlCheck: aUrlCheck, snap: await snapshotPage(pageA, 'A.afterEnsureUrl') });
        audit('account_seat_selection_ready', { role: 'A', idx: 0, email: emailA, ok: !!aUrlCheck?.ok, url: (() => { try { return pageA.url(); } catch { return null; } })() });

        setStep('A.postBuy.reloginCheck.start');
        const aRelog = await reloginIfRedirected(pageA, emailA, passwordA);
        setStep('A.postBuy.reloginCheck.done', { relogged: aRelog, snap: await snapshotPage(pageA, 'A.afterReloginCheck') });

        const psA2 = await handlePrioritySaleModal(pageA, { prioritySale, fanCardCode: a0?.fanCardCode ?? fanCardCode, identity: a0?.identity ?? identity, sicilNo: a0?.sicilNo ?? sicilNo, priorityTicketCode: a0?.priorityTicketCode ?? priorityTicketCode, priorityPhone: a0?.phone ?? priorityPhone, priorityTckn });
        if (psA2) {
            try { await ensureUrlContains(pageA, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
        }

        setStep('A.seatSelection.captcha.ensure.start');
        const captchaResultA = await ensureCaptchaOnPage(pageA, emailA, 'A.seatSelection');
        // After reCAPTCHA solve, wait for page to unlock (dropdown or seatmap appearing)
        if (captchaResultA?.attempted && captchaResultA?.type === 'recaptcha') {
            try {
                await pageA.waitForFunction(() => {
                    return !!document.querySelector('.custom-select-box, select option, .dropdown-option') ||
                           document.querySelectorAll('svg.seatmap-svg, .seatmap-container, [class*="seatmap"]').length > 0;
                }, { timeout: 8000 });
                logger.info('A.seatSelection.captcha.page_unlocked');
            } catch {
                logger.warn('A.seatSelection.captcha.page_unlock_timeout');
            }
        }
        setStep('A.seatSelection.captcha.ensure.done', { snap: await snapshotPage(pageA, 'A.afterCaptchaEnsure') });

        // Hard guard: compute canonical seat selection URL and force navigation back to /koltuk-secim if we drifted.
        const canonicalSeatUrlA = (() => {
            try {
                const u = new URL(String(eventAddress));
                const p = String(u.pathname || '');
                const seatPath = p.includes('/koltuk-secim') ? p : (p.endsWith('/') ? `${p}koltuk-secim` : `${p}/koltuk-secim`);
                return `${u.origin}${seatPath}`;
            } catch {
                const s = String(eventAddress || '');
                if (!s) return null;
                if (s.includes('/koltuk-secim')) return s;
                return s.endsWith('/') ? `${s}koltuk-secim` : `${s}/koltuk-secim`;
            }
        })();

        try {
            const okNow = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 0, waitMs: 10 });
            if (!okNow?.ok && canonicalSeatUrlA) {
                logger.warn('A.force_goto_canonical_seat_url', {
                    currentUrl: (() => { try { return pageA.url(); } catch { return null; } })(),
                    canonicalSeatUrlA
                });
                try {
                    await gotoWithRetry(pageA, canonicalSeatUrlA, {
                        retries: 3,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: '/koltuk-secim',
                        rejectIfHome: true,
                        backoffMs: 450
                    });
                } catch {}

                const okAfter = await ensureUrlContains(pageA, '/koltuk-secim', {
                    retries: 1,
                    waitMs: 9000,
                    backoffMs: 450,
                    recoveryUrl: canonicalSeatUrlA
                }).catch(() => null);
                if (!okAfter?.ok) {
                    throw new Error('Seat selection sayfasına gidilemedi (/koltuk-secim)');
                }
            }
        } catch {}

        // If we are still on login page, recover by navigating to decoded returnUrl.
        try {
            const cur = (() => { try { return pageA.url(); } catch { return ''; } })();
            if (/\/giris(\?|$)/i.test(cur)) {
                let returnUrl = null;
                try {
                    const u = new URL(cur);
                    returnUrl = u.searchParams.get('returnUrl');
                    if (returnUrl) {
                        try { returnUrl = decodeURIComponent(returnUrl); } catch {}
                        if (!/^https?:\/\//i.test(returnUrl)) {
                            returnUrl = `https://www.passo.com.tr${returnUrl.startsWith('/') ? '' : '/'}${returnUrl}`;
                        }
                    }
                } catch {}

                if (returnUrl) {
                    logger.warn('A.login_stuck_recover_returnUrl', { cur, returnUrl });
                    await gotoWithRetry(pageA, returnUrl, {
                        retries: 2,
                        waitUntil: 'domcontentloaded',
                        expectedUrlIncludes: '/koltuk-secim',
                        rejectIfHome: false,
                        backoffMs: 450
                    }).catch(() => {});
                }
            }
        } catch {}

        // Guard: page can drift to home due to session/captcha/network issues. Do not continue category selection on wrong page.
        const seatUrlA_forRecover = canonicalSeatUrlA || (() => { try { return pageA.url(); } catch { return null; } })();
        const seatUrlOk = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 1, waitMs: 4000, backoffMs: 350, recoveryUrl: seatUrlA_forRecover });
        if (!seatUrlOk?.ok) {
            logger.warn('A.seatSelection.url_drift_before_category', { urlCheck: seatUrlOk, currentUrl: (() => { try { return pageA.url(); } catch { return null; } })(), seatUrlA_forRecover });
            if (seatUrlA_forRecover) {
                await gotoWithRetry(pageA, String(seatUrlA_forRecover), {
                    retries: 2,
                    waitUntil: 'domcontentloaded',
                    expectedUrlIncludes: '/koltuk-secim',
                    rejectIfHome: true,
                    backoffMs: 450
                }).catch(() => {});
            }
        }

        // Final guard: refuse to run category selection if we are not on seat page.
        const seatUrlOk2 = await ensureUrlContains(pageA, '/koltuk-secim', { retries: 0, waitMs: 10 });
        if (!seatUrlOk2?.ok) {
            throw new Error('Seat selection sayfasına gidilemedi (/koltuk-secim)');
        }

        // Final guard before category selection: do not continue on /giris.
        try {
            const cur = (() => { try { return pageA.url(); } catch { return ''; } })();
            if (/\/giris(\?|$)/i.test(cur)) {
                throw new Error('Login sayfasında kaldı (kategori seçimine geçilemedi)');
            }
        } catch (e) {
            throw e;
        }

        const hasTicketType = await pageA.$('.ticket-type-title');
        if (hasTicketType) {
            setStep('A.ticketType.select.start');
            await pageA.evaluate(() => {
                const titles = Array.from(document.querySelectorAll('.ticket-type-title'));
                const target = titles.find(el => (el.innerText || '').includes('Passolig E-Bilet'));
                target?.click();
            });
            setStep('A.ticketType.select.done', { snap: await snapshotPage(pageA, 'A.afterTicketType') });
        }

        // Capture selected category & block for transfer to B. DOM can be late/placeholder, so retry a bit.
        catBlockA = { categoryText: '', blockText: '', blockVal: '' };

        // DOM diagnostic: capture exactly what category-related elements exist before selection
        try {
            const domDiag = await pageA.evaluate(() => {
                const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                const isVis = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect?.();
                    if (!r || r.width < 2 || r.height < 2) return false;
                    const st = window.getComputedStyle(el);
                    return st.display !== 'none' && st.visibility !== 'hidden';
                };

                // All <select> elements
                const selects = Array.from(document.querySelectorAll('select')).map(s => ({
                    id: s.id || null,
                    name: s.getAttribute('name') || null,
                    visible: isVis(s),
                    optionCount: s.options?.length || 0,
                    options: Array.from(s.options || []).slice(0, 8).map(o => norm(o.textContent).slice(0, 80)),
                    disabled: s.disabled
                }));

                // .custom-select-box
                const csb = document.querySelector('.custom-select-box');
                const csbInfo = csb ? {
                    visible: isVis(csb),
                    text: norm(csb.innerText || csb.textContent || '').slice(0, 200),
                    selectedOption: norm(csb.querySelector('.selected-option')?.textContent || ''),
                    childTags: Array.from(csb.children || []).map(c => c.tagName + (c.className ? '.' + String(c.className).split(' ')[0] : '')).slice(0, 10)
                } : null;

                // .dropdown-option elements
                const dropdownOpts = Array.from(document.querySelectorAll('.dropdown-option')).map(d => ({
                    text: norm(d.textContent).slice(0, 80),
                    visible: isVis(d),
                    disabled: d.classList.contains('disabled')
                }));

                // Any element containing "Kategori" text
                const kategoriEls = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
                let node;
                while ((node = walker.nextNode())) {
                    if (node.textContent && /kategori/i.test(node.textContent) && node.parentElement) {
                        const p = node.parentElement;
                        kategoriEls.push({
                            tag: p.tagName,
                            id: p.id || null,
                            className: (p.className || '').toString().slice(0, 100),
                            text: norm(p.textContent).slice(0, 120),
                            visible: isVis(p)
                        });
                        if (kategoriEls.length >= 10) break;
                    }
                }

                // reCAPTCHA / Turnstile state
                const recaptchaIframes = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]')).map(f => f.src?.slice(0, 150) || '');
                const gRecaptchaDiv = document.querySelector('.g-recaptcha');
                const recaptchaResponse = document.querySelector('textarea[name="g-recaptcha-response"]');
                const turnstileWidget = document.querySelector('.cf-turnstile');
                const turnstileToken = document.querySelector('input[name="cf-turnstile-response"]');

                // Overlays
                const overlays = [];
                const centerX = window.innerWidth / 2;
                const centerY = window.innerHeight / 3;
                const topEl = document.elementFromPoint(centerX, centerY);
                if (topEl) {
                    overlays.push({
                        tag: topEl.tagName,
                        id: topEl.id || null,
                        className: (topEl.className || '').toString().slice(0, 100),
                        text: norm(topEl.textContent).slice(0, 100)
                    });
                }

                return {
                    url: location.href,
                    title: document.title,
                    selects,
                    customSelectBox: csbInfo,
                    dropdownOptions: dropdownOpts,
                    kategoriElements: kategoriEls,
                    captcha: {
                        recaptchaIframes: recaptchaIframes.length,
                        hasGRecaptchaDiv: !!gRecaptchaDiv,
                        recaptchaResponseLen: recaptchaResponse?.value?.length || 0,
                        hasTurnstileWidget: !!turnstileWidget,
                        turnstileTokenLen: turnstileToken?.value?.length || 0
                    },
                    topElementAtCenter: overlays[0] || null,
                    bodyTextSnippet: norm(document.body?.innerText || '').slice(0, 500)
                };
            });
            logger.info('A.categoryBlock.dom_diagnostic', domDiag);
        } catch (e) {
            logger.warn('A.categoryBlock.dom_diagnostic_failed', { error: e?.message });
        }

        const aCredential = idProfileA || aList[0] || null;
        const bCredential = idProfileB || bList[0] || null;
        const aAllowedCategories = await resolveCategoriesForCredential(teamId, selectedCategories, aCredential?.categoryIds || [], categorySelectionMode);
        const bAllowedCategories = await resolveCategoriesForCredential(teamId, selectedCategories, bCredential?.categoryIds || [], categorySelectionMode);
        const aAllowedBlocks = await resolveBlocksForCredential(teamId, selectedBlocks, aCredential?.blockIds || []);
        const { chooser: singleCategoryChooserA, blockMap: aBlockMap } = buildAccountChooser(
            aAllowedBlocks,
            aAllowedCategories,
            resolvedCategoryType,
            resolvedAlternativeCategory,
            categorySelectionMode,
            null
        );
        const singleCategoryChooserB = createCategoryChooser(
            bAllowedCategories,
            resolvedCategoryType,
            resolvedAlternativeCategory,
            categorySelectionMode
        );
        let ticketQuantityPrimedA = false;
        const singleTargetPeekA = singleCategoryChooserA.peekNext ? singleCategoryChooserA.peekNext() : null;
        setStep('A.categoryBlock.select.start', {
            categoryId: singleTargetPeekA?.id || null,
            categoryType: singleTargetPeekA?.categoryType || resolvedCategoryType || null,
            alternativeCategory: singleTargetPeekA?.alternativeCategory || resolvedAlternativeCategory || null,
            categoryLabel: singleTargetPeekA?.label || null,
            svgBlockId: singleTargetPeekA?.svgBlockId || null,
            categorySelectionMode,
        });
        let cbResA;
        cbResA = await singleCategoryChooserA.choose(pageA, resolvedCategoryType, resolvedAlternativeCategory, categorySelectionMode);
        if (cbResA && cbResA.svgBlockId) {
            try { catBlockA = { ...catBlockA, svgBlockId: cbResA.svgBlockId }; } catch {}
        }
        setStep('A.categoryBlock.select.done', { snap: await snapshotPage(pageA, 'A.afterCategoryBlock') });

        for (let i = 0; i < 6; i++) {
            try {
                const c = await readCatBlock(pageA);
                const catTxt = (c?.categoryText || '').trim();
                const isPlaceholder = !catTxt || catTxt.toLowerCase() === 'kategori';
                const blocksOk = !!(c?.blockVal || c?.blockText);
                if (!isPlaceholder && blocksOk) { catBlockA = { ...(c || {}), svgBlockId: catBlockA?.svgBlockId }; break; }
                catBlockA = { ...(c || catBlockA), svgBlockId: catBlockA?.svgBlockId };
            } catch {}
            await delay(350);
        }
        if (ticketCount > 1) {
            const qtyResA = await applyTicketQuantityDropdown(pageA, 'A:postCategory', ticketCount);
            ticketQuantityPrimedA = qtyResA?.ok === true;
        }
        logger.info('A hesabı kategori/blok okundu', { catBlockA });

        setStep('A.seat.pickRandom.start');
        const seatSelectionUrlA = (() => { try { return pageA.url(); } catch { return null; } })();
        const netSeatA = captureSeatIdFromNetwork(pageA, getCfg().TIMEOUTS.NETWORK_CAPTURE_TIMEOUT);
        const seatHelper = require('../helpers/seat');

        seatInfoA = null;
        const maxCycle = Math.max(12, Number(getCfg()?.TIMEOUTS?.SEAT_SELECTION_CYCLES || 0) || 12);
        const waitUntilFound = getCfg()?.TIMEOUTS?.SEAT_WAIT_UNTIL_FOUND === true;
        const waitMaxMinutes = Math.max(1, Number(getCfg()?.TIMEOUTS?.SEAT_WAIT_MAX_MINUTES || 90) || 90);
        const waitDeadlineAt = Date.now() + (waitMaxMinutes * 60 * 1000);
        let cycleStartedAt = Date.now();
        for (let cycle = 1; (waitUntilFound ? (Date.now() < waitDeadlineAt) : (cycle <= maxCycle)); cycle++) {
            try {
                const remaining = Math.max(15000, Number(getCfg().TIMEOUTS.SEAT_SELECTION_MAX) - (Date.now() - cycleStartedAt));
                const catRuleA = cbResA?.chosenCategory || {};
                const catMinTicketsA = (catRuleA.ticketCount && catRuleA.ticketCount > 1) ? catRuleA.ticketCount : 1;
                const effectiveTicketCountA = Math.max(ticketCount, catMinTicketsA);
                const adjacentSeatsA = catRuleA.adjacentSeats === true;
                seatInfoA = await seatHelper.pickRandomSeatWithVerify(
                    pageA,
                    remaining,
                    {
                        context: 'A',
                        expectedUrlIncludes: '/koltuk-secim',
                        recoveryUrl: seatSelectionUrlA,
                        roamCategoryTexts: singleCategoryChooserA.getRoamTexts(),
                        email: emailA,
                        password: passwordA,
                        reloginIfRedirected,
                        ensureTurnstileFn: ensureCaptchaOnPage,
                        chooseCategoryFn: singleCategoryChooserA.choose,
                        categorySelectionMode,
                        seatSelectionMode,
                        claimGroupKey: runId,
                        ticketCount: effectiveTicketCountA,
                        quantitySelectionMode: 'afterCategory',
                        ticketQuantityPrimed: ticketQuantityPrimedA,
                        adjacentSeats: adjacentSeatsA
                    }
                );
                break;
            } catch (e) {
                const msg = e?.message || String(e);
                if (/NO_SELECTABLE_SEATS/i.test(msg) || msg.includes('Seçilen blokta boş/aktif koltuk bulunamadı')) {
                    logger.warn('A.seat.noSelectable.retry_block', { cycle, msg });
                    setStep('A.categoryBlock.reselect.start', { cycle });
                    const roamEvery = Math.max(0, Number(getCfg()?.TIMEOUTS?.CATEGORY_ROAM_EVERY_CYCLES || 0) || 0);
                    const baseMode = String(categorySelectionMode || 'legacy').toLowerCase();
                    const mode2 = (baseMode === 'svg') ? categorySelectionMode : ((roamEvery > 0 && (cycle % roamEvery) === 0) ? 'scan' : categorySelectionMode);
                    const cbResA2 = await singleCategoryChooserA.choose(pageA, resolvedCategoryType, resolvedAlternativeCategory, mode2);
                    if (cbResA2 && cbResA2.svgBlockId) {
                        try { catBlockA = { ...(catBlockA || {}), svgBlockId: cbResA2.svgBlockId }; } catch {}
                    }
                    const catMinTicketsA2 = (cbResA2?.chosenCategory?.ticketCount && cbResA2.chosenCategory.ticketCount > 1) ? cbResA2.chosenCategory.ticketCount : 1;
                    const effectiveTicketCountA2 = Math.max(ticketCount, catMinTicketsA2);
                    if (effectiveTicketCountA2 > 1) {
                        const qtyResA2 = await applyTicketQuantityDropdown(pageA, 'A:postCategoryRetry', effectiveTicketCountA2);
                        ticketQuantityPrimedA = qtyResA2?.ok === true;
                    }
                    setStep('A.categoryBlock.reselect.done', { cycle, snap: await snapshotPage(pageA, `A.afterReselect_${cycle}`) });
                    // Reset the seat-pick deadline after a reselect. Reselect can take significant time (loader/UI),
                    // and we don't want to fail just because we spent time switching blocks with no seats.
                    cycleStartedAt = Date.now();
                    continue;
                }
                throw e;
            }
        }
        if (!seatInfoA) throw new Error(formatError('SEAT_SELECTION_FAILED_A'));
        const sidNet = await netSeatA;
        if (sidNet) {
            if (!seatInfoA.seatId) seatInfoA.seatId = sidNet.seatId;
            if (!seatInfoA.row) seatInfoA.row = sidNet.row;
            if (!seatInfoA.seat) seatInfoA.seat = sidNet.seat;
            logger.info('A koltuk bilgisi networkten alındı', { seatId: seatInfoA.seatId, row: seatInfoA.row, seat: seatInfoA.seat });
        }
        setStep('A.seat.pickRandom.done', { seatInfoA, sidNet, snap: await snapshotPage(pageA, 'A.afterSeatPick') });

        // Used to enforce deterministic remove timing: wait 30s after arriving basket page.
        let aBasketArrivedAtMs = null;

        // Passo sometimes keeps the UI on /koltuk-secim even after basket is created.
        // For transfer flow we need A to be on basket page to remove the item reliably.
        try {
            setStep('A.gotoBasket.start');
            await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                retries: 2,
                waitUntil: 'networkidle2',
                expectedUrlIncludes: '/sepet',
                rejectIfHome: false,
                backoffMs: 450
            });
            await pageA.waitForSelector('.basket-list-detail, .basket-list, .basket, [data-testid*="basket" i], [data-testid*="sepet" i]', { timeout: 15000 }).catch(() => {});
            aBasketArrivedAtMs = Date.now();
            setStep('A.gotoBasket.done', { snap: await snapshotPage(pageA, 'A.afterGotoBasket') });
        } catch {}

        // Seat helper can return early from add-to-basket network with partial fields (row/seat empty).
        // After landing on /sepet, enrich seat info from basket DOM/api snapshot for accurate UI/log output.
        try {
            const basketSeatA = await readBasketData(pageA);
            if (basketSeatA && seatInfoA) {
                seatInfoA = {
                    ...seatInfoA,
                    tribune: seatInfoA.tribune || basketSeatA.tribune || '',
                    block: seatInfoA.block || basketSeatA.block || '',
                    row: seatInfoA.row || basketSeatA.row || '',
                    seat: seatInfoA.seat || basketSeatA.seat || '',
                    blockId: seatInfoA.blockId || basketSeatA.blockId || '',
                    seatId: seatInfoA.seatId || basketSeatA.seatId || '',
                    combined: seatInfoA.combined || basketSeatA.combined || '',
                    itemCount: Math.max(
                        Number(seatInfoA.itemCount) || 0,
                        Number(basketSeatA.itemCount) || 0
                    ),
                    heldSeats: (Array.isArray(seatInfoA.heldSeats) && seatInfoA.heldSeats.length)
                        ? seatInfoA.heldSeats
                        : (Array.isArray(basketSeatA.heldSeats) ? basketSeatA.heldSeats : [])
                };
                logger.info('A.seatInfo.enriched_from_basket', {
                    seatId: seatInfoA.seatId || null,
                    row: seatInfoA.row || null,
                    seat: seatInfoA.seat || null,
                    block: seatInfoA.block || null,
                    tribune: seatInfoA.tribune || null
                });
            }
        } catch (e) {
            logger.warnSafe('A.seatInfo.enrich_from_basket_failed', { error: e?.message || String(e) });
        }

        const ensureRemoveDelayAfterBasket = async () => {
            const MIN_AFTER_BASKET_MS = 30000;
            if (!aBasketArrivedAtMs) aBasketArrivedAtMs = Date.now();
            const elapsed = Date.now() - aBasketArrivedAtMs;
            if (elapsed < MIN_AFTER_BASKET_MS) {
                const waitMs = MIN_AFTER_BASKET_MS - elapsed;
                logger.info('A.removeFromCart.delayAfterBasket', { waitMs, elapsedMs: elapsed });
                await delay(waitMs);
            }
        };
        
        // Sepette tutma süresi takibini başlat
        basketTimer = new BasketTimer();
        basketTimer.start();

        setHolder('A', seatInfoA, catBlockA);
        
        // Sayfadan sepette tutma süresini okumaya çalış (opsiyonel)
        const pageBasketInfo = await checkBasketTimeoutFromPage(pageA);
        if (pageBasketInfo && pageBasketInfo.foundTimeText) {
            logger.info('Sayfadan sepette tutma süresi okundu', { basketInfo: pageBasketInfo });
        }
        
        const basketStatus = basketTimer.getStatus();
        const basketTimingPatch = buildBasketTimingPatch({
            basketArrivedAtMs: aBasketArrivedAtMs,
            remainingSeconds: basketStatus?.remainingSeconds ?? seatInfoA?.remainingTime,
            observedAtMs: Date.now()
        });
        logger.info('A hesabı koltuk seçti ve sepete eklendi', { 
            seatInfo: seatInfoA,
            basketStatus: basketStatus
        });
        upsertDashboardPairRow(1, {
            aEmail: emailA,
            bEmail: hasRealB ? emailB : '\u2014',
            aIntent: resolveAIntent(a0 || {}),
            holder: 'A',
            seatId: seatInfoA?.seatId ? String(seatInfoA.seatId) : null,
            seatLabel: fmtSeatLabel(seatInfoA),
            combinedAll: seatInfoA?.combinedAll ? String(seatInfoA.combinedAll).trim() : null,
            seatItemCount: Number.isFinite(Number(seatInfoA?.itemCount)) && Number(seatInfoA.itemCount) > 1
                ? Math.floor(Number(seatInfoA.itemCount))
                : null,
            tribune: seatInfoA?.tribune ?? null,
            seatRow: seatInfoA?.row ?? null,
            seatNumber: seatInfoA?.seat ?? null,
            phase: normalizeCanPay(a0?.canPay, true)
                ? (hasCardInfo ? 'A ödeme sayfası hazırlanıyor' : 'Sepette tutuluyor')
                : 'C finalize bekliyor',
            paymentOwnerRole: normalizeCanPay(a0?.canPay, true) ? 'A' : 'C',
            paymentEligible: normalizeCanPay(a0?.canPay, true),
            paymentState: normalizeCanPay(a0?.canPay, true) ? (hasCardInfo ? 'queued' : 'waiting') : 'waiting',
            transferOk: null,
            unmatched: !hasRealB,
            ...basketTimingPatch
        });
        pairRuntimeByIndex.set(1, {
            pairIndex: 1,
            aCtx: { idx: 0, email: emailA, password: passwordA, browser: browserA, page: pageA, seatInfo: seatInfoA, catBlock: catBlockA, canPay: normalizeCanPay(a0?.canPay, true), transferPurpose: normalizeTransferPurpose(a0?.transferPurpose, false), accountProfile: a0 || null, ...basketTimingPatch },
            bCtx: null,
            idProfileA: a0 || null,
            idProfileB: b0 || null,
            currentHolder: 'A',
            currentSeatInfo: seatInfoA || null,
            currentCatBlock: catBlockA || null,
            ...basketTimingPatch
        });
        await persistBasketRecordForPair(1, {
            sourceRole: 'A',
            holderRole: 'A',
            paymentOwnerRole: normalizeCanPay(a0?.canPay, true) ? 'A' : 'C',
            paymentState: 'none',
            recordStatus: 'basketed',
            aAccountEmail: emailA,
            seat: seatInfoA,
            category: catBlockA,
            auditMeta: {
                phase: 'single_a_basketed',
                basketStatus
            }
        });

        // B hesabı yoksa: transfer yok, direkt ödeme veya hold
        if (!hasRealB) {
            audit('single_a_only_mode', { email: emailA, seatId: seatInfoA?.seatId, hasCardInfo });
            logger.info('A-only mod (tekli): B hesabi yok, transfer yapilmayacak');

                if (!dashboardPairs.length) {
                    const existingRuntime = pairRuntimeByIndex.get(1) || null;
                    const basketTimingPatch = resolveRuntimeBasketTiming(existingRuntime, 'A');
                dashboardPairs = [{
                    pairIndex: 1,
                    aEmail: emailA,
                    bEmail: '\u2014',
                    holder: 'A',
                    seatId: seatInfoA?.seatId ? String(seatInfoA.seatId) : null,
                    seatLabel: fmtSeatLabel(seatInfoA),
                    phase: a0?.canPay === false ? 'C finalize bekliyor' : (hasCardInfo ? 'A ödeme sayfası hazırlanıyor' : 'Sepette tutuluyor'),
                    paymentOwnerRole: a0?.canPay === false ? 'C' : 'A',
                    paymentEligible: a0?.canPay !== false,
                    paymentState: a0?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    transferOk: null,
                        unmatched: true,
                        ...basketTimingPatch
                }];
                pairRuntimeByIndex.set(1, {
                        ...(existingRuntime || {}),
                    pairIndex: 1,
                        aCtx: {
                            ...(existingRuntime?.aCtx || {}),
                            idx: 0,
                            email: emailA,
                            password: passwordA,
                            browser: browserA,
                            page: pageA,
                            seatInfo: seatInfoA,
                            catBlock: catBlockA,
                            canPay: normalizeCanPay(a0?.canPay, true),
                            accountProfile: a0 || null,
                            ...basketTimingPatch
                        },
                    bCtx: null,
                    idProfileA: a0 || null,
                    idProfileB: null,
                    currentHolder: 'A',
                    currentSeatInfo: seatInfoA || null,
                        currentCatBlock: catBlockA || null,
                        ...basketTimingPatch
                });
                upsertPaymentQueueEntry({
                    pairIndex: 1,
                    paymentOwnerRole: a0?.canPay === false ? 'C' : 'A',
                    paymentEligible: a0?.canPay !== false,
                    paymentState: a0?.canPay === false ? 'waiting' : (hasCardInfo ? 'queued' : 'waiting'),
                    aEmail: emailA,
                    bEmail: null
                });
                syncDashboardToRunStore();
            }

            if (a0?.canPay !== false) {
                await preparePaymentOnA(1, seatInfoA);
            } else {
                markPairPaymentState(1, {
                    paymentOwnerRole: 'C',
                    paymentEligible: false,
                    paymentState: 'waiting',
                    phase: 'C finalize bekliyor'
                });
            }
            if (hasCardInfo && a0?.canPay !== false) logger.info('A-only mod: Odeme sayfasi hazir, onay bekleniyor');
            else {
                logger.info('A-only mod: Kart bilgisi yok, sepette tutuluyor');
                audit('a_only_holding', { email: emailA, seatId: seatInfoA?.seatId });
            }

            const finalStatus = basketTimer.getStatus();
            try { runStore.upsert(runId, { status: 'completed', result: { success: true, mode: 'a_only', aEmail: emailA, seatInfo: seatInfoA, basketStatus: finalStatus, payment: hasCardInfo ? 'ready' : 'no_card' } }); } catch {}
            return res.json({ success: true, mode: 'a_only', aEmail: emailA, seatInfo: seatInfoA, basketStatus: finalStatus, payment: hasCardInfo ? 'ready' : 'no_card' });
        }

        // B: Launch + Login (A koltuk sepette beklerken)
        setStep('B.launchAndLogin.start', { email: emailB });
        audit('account_launch_start', { role: 'B', idx: 0, email: emailB });
        ({browser: browserB, page: pageB} = await launchAndLoginWithManagedProxy({
            email: emailB,
            password: passwordB,
            userDataDir: userDataDirB
        }, { role: 'B', idx: 0, email: emailB }));
        registerPassobotBrowser(browserB, runId);
        setStep('B.launchAndLogin.done', { email: emailB, snap: await snapshotPage(pageB, 'B.afterLogin') });
        audit('account_launch_done', { role: 'B', idx: 0, email: emailB, url: (() => { try { return pageB.url(); } catch { return null; } })() });
        logger.info('B hesabı giriş yaptı (A koltuk sepette beklerken)');

        // B: go event -> BUY -> same category & block -> target seat (locked strategy)
        setStep('B.gotoEvent.start', { eventAddress });
        const bGoto = await gotoWithRetry(pageB, String(eventAddress), {
            retries: 3,
            waitUntil: 'networkidle2',
            expectedUrlIncludes: eventPathIncludes,
            rejectIfHome: true,
            backoffMs: 450
        });
        setStep('B.gotoEvent.done', { goto: bGoto, snap: await snapshotPage(pageB, 'B.afterEventGoto') });

        await installRecaptchaCallbackInterceptor(pageB);
        setStep('B.clickBuy.start');
        const clickedB = await clickBuy(pageB, eventAddress);
        if (!clickedB) throw new Error(formatError('BUY_BUTTON_FAILED_B'));
        setStep('B.clickBuy.done');
        logger.info('B hesabı SATIN AL butonuna tıkladı');

        await handlePrioritySaleModal(pageB, { prioritySale, fanCardCode: b0?.fanCardCode ?? fanCardCode, identity: b0?.identity ?? identity, sicilNo: b0?.sicilNo ?? sicilNo, priorityTicketCode: b0?.priorityTicketCode ?? priorityTicketCode, priorityPhone: b0?.phone ?? priorityPhone, priorityTckn });

        setStep('B.waitNavAfterBuy.start');
        const bPreUrl = (() => { try { return pageB.url(); } catch { return null; } })();
        const bNavResult = await Promise.race([
            pageB.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
                .then(() => ({ type: 'navigation' }))
                .catch((e) => ({ type: 'nav_error', message: e?.message })),
            waitForFunctionSafe(pageB, (pre) => location.href !== pre, { timeout: 10000 }, bPreUrl)
                .then(() => ({ type: 'url_change' }))
                .catch((e) => ({ type: 'url_wait_error', message: e?.message })),
            delay(10000).then(() => ({ type: 'timeout' }))
        ]);
        await pageB.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 10000 }).catch(() => {});
        setStep('B.waitNavAfterBuy.done', { result: bNavResult, snap: await snapshotPage(pageB, 'B.afterBuyNav') });

        setStep('B.postBuy.ensureUrl.start');
        const bUrlCheck = await ensureUrlContains(pageB, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
        setStep('B.postBuy.ensureUrl.done', { urlCheck: bUrlCheck, snap: await snapshotPage(pageB, 'B.afterEnsureUrl') });

        setStep('B.postBuy.reloginCheck.start');
        const bRelog = await reloginIfRedirected(pageB, emailB, passwordB);
        setStep('B.postBuy.reloginCheck.done', { relogged: bRelog, snap: await snapshotPage(pageB, 'B.afterReloginCheck') });

        const psB2 = await handlePrioritySaleModal(pageB, { prioritySale, fanCardCode: b0?.fanCardCode ?? fanCardCode, identity: b0?.identity ?? identity, sicilNo: b0?.sicilNo ?? sicilNo, priorityTicketCode: b0?.priorityTicketCode ?? priorityTicketCode, priorityPhone: b0?.phone ?? priorityPhone, priorityTckn });
        if (psB2) {
            try { await ensureUrlContains(pageB, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 }); } catch {}
        }

        setStep('B.seatSelection.captcha.ensure.start');
        const captchaResultB = await ensureCaptchaOnPage(pageB, emailB, 'B.seatSelection');
        if (captchaResultB?.attempted && captchaResultB?.type === 'recaptcha') {
            try {
                await pageB.waitForFunction(() => {
                    return !!document.querySelector('.custom-select-box, select option, .dropdown-option') ||
                           document.querySelectorAll('svg.seatmap-svg, .seatmap-container, [class*="seatmap"]').length > 0;
                }, { timeout: 8000 });
                logger.info('B.seatSelection.captcha.page_unlocked');
            } catch {
                logger.warn('B.seatSelection.captcha.page_unlock_timeout');
            }
        }
        setStep('B.seatSelection.captcha.ensure.done', { snap: await snapshotPage(pageB, 'B.afterCaptchaEnsure') });

        // B catBlock seçimi A kaldırdıktan sonra yapılacak
        // setStep('B.catBlock.sync.start');
        // await setCatBlockOnB(pageB, catBlockA);
        // setStep('B.catBlock.sync.done', { catBlockA, snap: await snapshotPage(pageB, 'B.afterCatBlockSet') });
        // logger.info('B hesabı kategori/blok ayarlandı', { catBlockA });

        const seatSelectionUrlB = (() => { try { return pageB.url(); } catch { return null; } })();
        try {
            seatInfoA.__recoveryOptions = {
                context: 'B',
                expectedUrlIncludes: '/koltuk-secim',
                recoveryUrl: seatSelectionUrlB,
                email: emailB,
                password: passwordB,
                reloginIfRedirected,
                ensureTurnstileFn: ensureCaptchaOnPage
            };
        } catch {}

        setStep('B.target.ready.start', { targetSeat: seatInfoA });
        const ready = await waitForTargetSeatReady(pageB, seatInfoA, 15000);
        if (!ready) logger.warn('B hesabı hedef koltuk DOM\'da bulunamadı, yine de denenecek');
        setStep('B.target.ready.done', { ready, snap: await snapshotPage(pageB, 'B.afterReady') });

        // B hazır ama blok seçimi yapmadan bekliyor - A kaldırdıktan sonra yapacak
        let aRemovedResolve;
        const aRemovedPromise = new Promise(resolve => { aRemovedResolve = resolve; });

        setStep('B.target.grabLoop.start', { targetSeat: seatInfoA });
        const waitPickB = (async () => {
            // A kaldırmadan önce bekle
            logger.info('B koltuk seçiminde hazır, A kaldırması bekleniyor');
            audit('b_waiting_a_remove', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });
            await aRemovedPromise;
            logger.info('A kaldırdı, B blok seçimi yapıyor');
            audit('b_a_remove_received', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });

            // After release, select block & mount seatmap deterministically.
            try { await applyCategoryBlockSelection(pageB, categorySelectionMode, catBlockA, seatInfoA); } catch {}
            const ensureSeatmapMountedOnB = async () => {
                const svgBid = (catBlockA?.svgBlockId || seatInfoA?.svgBlockId || null);
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try { await openSeatMapStrict(pageB); } catch {}
                    try {
                        await pageB.waitForFunction((sel) => {
                            try { return document.querySelectorAll(sel).length > 0; } catch { return false; }
                        }, { timeout: 20000 }, SEAT_NODE_SELECTOR);
                        return true;
                    } catch {}
                    if (svgBid) {
                        try { await selectSvgBlockById(pageB, String(svgBid)); } catch {}
                    }
                    try { await delay(350 + (attempt * 300)); } catch {}
                }
                return false;
            };
            try { await ensureSeatmapMountedOnB(); } catch {}

            logger.info('B blok seçimi tamamlandı, koltuk seçiliyor');
            audit('b_cat_block_set', {
                aEmail: emailA,
                bEmail: emailB,
                seatId: seatInfoA?.seatId || null,
                categoryText: catBlockA?.categoryText || null,
                blockText: catBlockA?.blockText || null,
                blockVal: catBlockA?.blockVal || null,
                svgBlockId: catBlockA?.svgBlockId || seatInfoA?.svgBlockId || null
            });

            // Öncelik: A'nın koltuğunu (aynı seatId) B hesabına aynen yakalat.
            const exactTargets = normalizeHeldSeats(seatInfoA);
            const exactMaxMs = Math.max(30000, Math.min((getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0) * Math.max(1, exactTargets.length || 1), 180000));
            logger.info('B hedef koltukları zorluyor (aynı seatId listesi)', { seatId: seatInfoA?.seatId || null, heldSeatCount: exactTargets.length || 1, exactMaxMs });
            audit('b_exact_pick_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, heldSeatCount: exactTargets.length || 1, maxMs: exactMaxMs, seatSelectionUrlB });
            try {
                const gotExact = await pickExactSeatBundleReleaseAware(pageB, seatInfoA, exactMaxMs, {
                    audit: (phase, payload) => audit(`b_${phase}`, { aEmail: emailA, bEmail: emailB, ...payload })
                });
                if (gotExact) {
                    logger.info('B hedef koltuğu yakaladı (exact)', { seat: gotExact });
                    audit('b_exact_pick_done', {
                        aEmail: emailA,
                        bEmail: emailB,
                        seatId: seatInfoA?.seatId || null,
                        pickedSeatId: gotExact?.seatId || null,
                        row: gotExact?.row || null,
                        seat: gotExact?.seat || null,
                        heldSeatCount: Array.isArray(gotExact?.heldSeats) ? gotExact.heldSeats.length : (gotExact?.itemCount || null)
                    });
                    return gotExact;
                }
            } catch (e) {
                logger.warn('B hedef koltuk exact denemesi başarısız', { error: e?.message || String(e) });
                audit('b_exact_pick_failed', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, error: e?.message || String(e) }, 'warn');
            }

            // Fallback: Eğer exact koltuk alınamazsa (başkası aldı vs), random dene.
            logger.warn('B exact seat alınamadı, random fallback', { seatId: seatInfoA?.seatId || null });
            audit('b_random_fallback_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null });
            const catRuleBFallback = cbResA?.chosenCategory || {};
            const catMinBFallback = (catRuleBFallback.ticketCount && catRuleBFallback.ticketCount > 1) ? catRuleBFallback.ticketCount : 1;
            const randomGot = await pickRandomSeatWithVerify(
                pageB,
                getCfg().TIMEOUTS.SEAT_SELECTION_MAX,
                {
                    context: 'B',
                    expectedUrlIncludes: '/koltuk-secim',
                    recoveryUrl: seatSelectionUrlB,
                    email: emailB,
                    password: passwordB,
                    reloginIfRedirected,
                    ensureTurnstileFn: ensureCaptchaOnPage,
                    chooseCategoryFn: singleCategoryChooserB.choose,
                    categorySelectionMode,
                    seatSelectionMode,
                    claimGroupKey: runId,
                    ticketCount: Math.max(ticketCount, catMinBFallback),
                    adjacentSeats: catRuleBFallback.adjacentSeats === true
                }
            );
            logger.info('B rastgele koltuk yakaladı (fallback)', { seat: randomGot });
            audit('b_random_fallback_done', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, pickedSeatId: randomGot?.seatId || null, row: randomGot?.row || null, seat: randomGot?.seat || null });
            return randomGot;
        })();

        // Sepette tutma süresini kontrol et ve dinamik zamanlama yap
        const checkBasketStatus = async () => {
            const status = basketTimer.getStatus();
            
            // Sepet timeout'una yaklaşıyor mu kontrol et
            if (basketTimer.isNearExpiry()) {
                logger.warn('Sepette tutma süresi dolmak üzere!', {
                    remaining: status.remainingFormatted,
                    remainingSeconds: status.remainingSeconds
                });
            }
            
            // Sepet timeout olmuş mu kontrol et
            if (basketTimer.isExpired()) {
                logger.error('Sepette tutma süresi doldu!', {
                    elapsedSeconds: status.elapsedSeconds,
                    holdingTimeSeconds: status.holdingTimeSeconds
                });
                throw new Error('Sepette tutma süresi doldu. Koltuk serbest kaldı.');
            }
            
            return status;
        };

        // B hesabı hazır olana kadar sepette tutma süresini kontrol et
        let intervalError;
        const abortOnIntervalError = new Promise((_, reject) => {
            basketMonitor = setInterval(async () => {
                try {
                    await checkBasketStatus();
                } catch (error) {
                    intervalError = error;
                    clearInterval(basketMonitor);
                    clearPassiveSessionWatch();
                    reject(error);
                }
            }, 5000); // Her 5 saniyede bir kontrol et
        });

        startPassiveSeatWatch({
            page: pageB,
            email: emailB,
            password: passwordB,
            recoveryUrl: seatSelectionUrlB,
            label: 'b_while_a_holds_basket'
        });

        // Sepette tutma süresine göre dinamik zamanlama
        let shouldRemoveNow = false;
        const removeBeforeTimeout = async () => {
            const status = basketTimer.getStatus();
            
            // Dinamik uzatma: kalan süre eşik değerin altına düştüyse ve hala transfer gerçekleşmediyse,
            // bileti B hesabına geçirip (B sepetinde yeniden süre başlatacak şekilde) yakalat.
            const threshold = Number.isFinite(extendWhenRemainingSecondsBelow)
                ? extendWhenRemainingSecondsBelow
                : 90;
            const remaining = status.remainingSeconds;
            if (status.remainingSeconds <= threshold && !shouldRemoveNow) {
                // Default behavior: transfer to B by removing from A
                shouldRemoveNow = true;
                clearInterval(basketMonitor);
                clearPassiveSessionWatch();

                logger.info('Dinamik uzatma tetiklendi (B hesabına geçiş)', {
                    remainingSeconds: remaining,
                    extendWhenRemainingSecondsBelow: threshold,
                    message: `${remaining} saniye kala koltuk A sepetinden kaldırılıp B hesabına geçiriliyor`
                });
                audit('dynamic_transfer_triggered', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, remainingSeconds: remaining, threshold });
                
                // A hesabı koltuğu sepetten kaldır
                logger.debug('A hesabı koltuğu sepetten kaldırıyor (dinamik zamanlama)');
                audit('a_remove_from_basket_start', { aEmail: emailA, bEmail: emailB, seatId: seatInfoA?.seatId || null, reason: 'dynamic_timing' });
                try {
                    try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                    await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                        retries: 2,
                        waitUntil: 'networkidle2',
                        expectedUrlIncludes: '/sepet',
                        rejectIfHome: false,
                        backoffMs: 450
                    });
                    aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                } catch {}

                // If we got dumped on home/root, try one more time to reach basket (common when session flaps).
                try {
                    const u = (() => { try { return pageA.url(); } catch { return ''; } })();
                    if (u === 'https://www.passo.com.tr/' || u === 'https://www.passo.com.tr') {
                        try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 1,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        });
                        aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                    }
                } catch {}

                // Ensure basket DOM is present; if not, one last retry (session drift / partial loads happen).
                try {
                    const ok = await pageA.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 8000 }).then(() => true).catch(() => false);
                    if (!ok) {
                        try { await reloginIfRedirected(pageA, emailA, passwordA); } catch {}
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 1,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        }).catch(() => {});
                        await pageA.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 8000 }).catch(() => {});
                        aBasketArrivedAtMs = aBasketArrivedAtMs || Date.now();
                    }
                } catch {}

                let removed = false;
                let removeDiag = null;

                // DOM-based removal only (API/XHR removed per user request)
                await ensureRemoveDelayAfterBasket();

                for (let attempt = 1; attempt <= 3; attempt++) {
                    if (removed) break;
                    removeDiag = await clearBasketFully(pageA, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
                    removed = removeDiag?.ok === true;
                    if (removed) break;
                    try {
                        logger.warn('A.removeFromCart.retry.reload', { attempt });
                        await gotoWithRetry(pageA, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 0,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 0
                        });
                        await delay(2500);
                    } catch {}
                }
                if (!removed) {
                    audit('a_remove_from_basket_failed', {
                        aEmail: emailA,
                        bEmail: emailB,
                        seatId: seatInfoA?.seatId || null,
                        reason: 'dynamic_timing',
                        remainingItemCount: removeDiag?.remainingCount ?? null,
                        removedClicks: removeDiag?.removedClicks ?? null
                    }, 'warn');
                    try {
                        try {
                            const frames = (() => {
                                try { return pageA.frames(); } catch { return []; }
                            })();
                            const frameMeta = frames.map(f => {
                                let url = null;
                                let name = null;
                                try { url = f.url(); } catch {}
                                try { name = typeof f.name === 'function' ? f.name() : null; } catch {}
                                return { name, url };
                            });
                            logger.warn('A.removeFromCart.failed.frames', { count: frameMeta.length, frameMeta });
                        } catch {}

                        const diag = await pageA.evaluate(() => {
                            const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
                            const pickInfo = (n) => {
                                const t = norm(n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.innerText || n.textContent || '');
                                const cls = norm(n.getAttribute?.('class') || '');
                                const dt = norm(n.getAttribute?.('data-testid') || '');
                                const id = norm(n.getAttribute?.('id') || '');
                                const href = norm(n.getAttribute?.('href') || '');
                                const type = norm(n.getAttribute?.('type') || '');
                                return { tag: n.tagName, text: t.slice(0, 140), id: id.slice(0, 80), href: href.slice(0, 120), type: type.slice(0, 40), testid: dt.slice(0, 80), className: cls.slice(0, 140) };
                            };

                            const all = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],img,svg,i,span')].slice(0, 1500);
                            const allBtn = [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')].slice(0, 60);

                            const picks = [];
                            for (const n of all) {
                                const t = norm(n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.getAttribute?.('alt') || n.innerText || n.textContent || '');
                                const cls = norm(n.getAttribute?.('class') || '');
                                const dt = norm(n.getAttribute?.('data-testid') || '');
                                const id = norm(n.getAttribute?.('id') || '');
                                const key = (t + ' ' + cls + ' ' + dt + ' ' + id).toLowerCase();
                                if (!key) continue;
                                if (/(kald\w*r|sepett\w*\s*ç\w*kar|\bç\w*kar\b|\bsil\b|remove|delete|trash|bin|çöp)/i.test(key)) {
                                    picks.push(pickInfo(n));
                                    if (picks.length >= 25) break;
                                }
                            }

                            const basketRoots = [
                                document.querySelector('.basket-list-detail'),
                                document.querySelector('.basket-list'),
                                document.querySelector('.basket'),
                                document.querySelector('[data-testid*="basket" i]'),
                                document.querySelector('[data-testid*="sepet" i]')
                            ].filter(Boolean);
                            const basketSample = [];
                            if (basketRoots[0]) {
                                const inside = [...basketRoots[0].querySelectorAll('button,a,[role="button"],svg,i,img,span')].slice(0, 300);
                                for (const n of inside) {
                                    const info = pickInfo(n);
                                    if (info.text || info.className || info.testid || info.id) basketSample.push(info);
                                    if (basketSample.length >= 25) break;
                                }
                            }

                            const swal = !!document.querySelector('.swal2-container.swal2-shown');
                            const swalText = norm(document.querySelector('.swal2-container.swal2-shown .swal2-html-container')?.innerText || document.querySelector('.swal2-container.swal2-shown')?.innerText || '');

                            const iframes = [...document.querySelectorAll('iframe')].slice(0, 25).map(f => ({
                                id: norm(f.getAttribute('id') || ''),
                                name: norm(f.getAttribute('name') || ''),
                                src: norm(f.getAttribute('src') || ''),
                                title: norm(f.getAttribute('title') || '')
                            }));
                            return {
                                url: location.href,
                                swal,
                                swalText: swalText.slice(0, 200),
                                nodeCounts: { all: all.length, btnLike: allBtn.length, basketRoots: basketRoots.length },
                                candidates: picks,
                                firstButtons: allBtn.map(pickInfo),
                                basketSample,
                                iframes
                            };
                        });
                        logger.warn('A.removeFromCart.failed.domDiag', diag);
                    } catch {}
                    throw new Error(formatError('REMOVE_FROM_CART_FAILED'));
                }
                logger.info('A hesabı koltuğu sepetten kaldırdı (dinamik zamanlama)', {
                    remainingSeconds: remaining,
                    elapsedSeconds: status.elapsedSeconds
                });

                audit('a_remove_from_basket_done', {
                    aEmail: emailA,
                    bEmail: emailB,
                    seatId: seatInfoA?.seatId || null,
                    reason: 'dynamic_timing',
                    initialItemCount: removeDiag?.initialCount ?? null,
                    remainingItemCount: removeDiag?.remainingCount ?? null,
                    removedClicks: removeDiag?.removedClicks ?? null
                });

                // B tarafı A'nın kaldırmasını bekliyor; sinyal gönder.
                try { aRemovedResolve?.(); } catch {}
            }
        };

        // Dinamik zamanlama kontrolü (her 2 saniyede bir)
        const abortOnDynamicTimingError = new Promise((_, reject) => {
            dynamicTimingCheck = setInterval(async () => {
                try {
                    await removeBeforeTimeout();
                } catch (error) {
                    intervalError = error;
                    clearInterval(dynamicTimingCheck);
                    clearInterval(basketMonitor);
                    clearPassiveSessionWatch();
                    reject(error);
                }
            }, 2000);
        });

        // Transfer yakalama B tarafında hazır bekler; A kaldırma işlemi sadece dinamik eşik tetiklendiğinde yapılır.
        try {
            const pickPromise = Promise.race([
                waitPickB,
                abortOnIntervalError,
                abortOnDynamicTimingError,
                (finalizeInFlight ? finalizeInFlight : new Promise(() => {}))
            ]);
            seatInfoB = await pickPromise;
            setStep('B.target.grabLoop.done', { seatInfoB, snap: await snapshotPage(pageB, 'B.afterGrab') });
            clearInterval(dynamicTimingCheck);
            clearInterval(basketMonitor);
            clearPassiveSessionWatch();
        } catch (error) {
            clearInterval(dynamicTimingCheck);
            clearInterval(basketMonitor);
            clearPassiveSessionWatch();

            // Fallback: eski locked strateji ile bir kez daha dene (özellikle DOM farklıysa)
            try {
                logger.warn('Transfer akışında hata, locked strateji ile fallback deneniyor', { error: error?.message || error });
                const got = await pickExactSeatWithVerify_Locked(pageB, seatInfoA, getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX);
                if (got) {
                    seatInfoB = got;
                    setStep('B.target.grabLoop.fallback.locked.done', { seatInfoB, snap: await snapshotPage(pageB, 'B.afterGrabFallback') });
                } else {
                    throw error;
                }
            } catch {
                throw error;
            }
        }
        logger.info('B hesabı koltuğu yakaladı', { seatInfo: seatInfoB });
        try {
            const cbB = await readCatBlock(pageB).catch(() => null);
            const lastSvgBlockIdB = await pageB.evaluate(() => {
                try { return window.__passobotLastSvgBlockId || null; } catch { return null; }
            }).catch(() => null);
            // Derive the actual svg block id for the picked seat from the seat node itself.
            // window.__passobotLastSvgBlockId can be stale (e.g. preselected block before release).
            const derivedSvgBlockIdB = await pageB.evaluate((sid) => {
                try {
                    const seatId = String(sid || '').trim();
                    if (!seatId) return null;
                    const sel = [
                        `g.g${seatId}`,
                        `g[id="g${seatId}"]`,
                        `#g${seatId}`,
                        `.g${seatId}`,
                        `.block${seatId}`,
                        `rect.block${seatId}`,
                        `rect[id="block${seatId}"]`,
                        `#block${seatId}`
                    ].join(',');
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const b = el.closest('[id^="block"]');
                    const bid = b && b.id ? String(b.id) : null;
                    return bid && bid.startsWith('block') ? bid : null;
                } catch {
                    return null;
                }
            }, seatInfoB?.seatId || null).catch(() => null);

            if (cbB && (cbB.categoryText || cbB.blockText || cbB.blockVal)) {
                catBlockA = { ...cbB, svgBlockId: derivedSvgBlockIdB || lastSvgBlockIdB || cbB.svgBlockId || catBlockA?.svgBlockId };
            } else if (lastSvgBlockIdB) {
                catBlockA = { ...(catBlockA || {}), svgBlockId: derivedSvgBlockIdB || lastSvgBlockIdB };
            } else if (derivedSvgBlockIdB) {
                catBlockA = { ...(catBlockA || {}), svgBlockId: derivedSvgBlockIdB };
            }
            if (seatInfoB && (derivedSvgBlockIdB || (catBlockA && catBlockA.svgBlockId))) {
                seatInfoB.svgBlockId = String(derivedSvgBlockIdB || catBlockA.svgBlockId);
            }
        } catch {}
        setHolder('B', seatInfoB, catBlockA);
        await persistTransferForPair(1, {
            sourceRole: 'B',
            holderRole: 'B',
            paymentOwnerRole: 'A',
            recordStatus: 'transferred',
            aAccountEmail: emailA,
            bAccountEmail: emailB,
            seat: seatInfoB,
            category: catBlockA,
            auditMeta: {
                phase: 'single_transfer_done',
                aEmail: emailA,
                bEmail: emailB
            }
        });
        }

        // If finalize completed during the race, stop here.
        if (finalizedToCResult) {
            try {
                runStore.upsert(runId, { status: 'completed', result: finalizedToCResult });
            } catch {}
            return res.json(finalizedToCResult);
        }

        setStep('B.clickContinue.start');
        await clickContinueInsidePage(pageB);
        await delay(getCfg().DELAYS.AFTER_CONTINUE);
        setStep('B.clickContinue.done', { snap: await snapshotPage(pageB, 'B.afterContinue') });
        await parkHolderOnBasket(pageB, basketTimer, {
            email: emailB,
            password: passwordB,
            reloginIfRedirected,
            label: 'B.afterContinue'
        });

        // Optional: Basket loop (A<->B) to extend holding time by transferring before expiry.
        if (getCfg()?.BASKET?.LOOP_ENABLED) {
            try {
                const loopThreshold = Number.isFinite(extendWhenRemainingSecondsBelow)
                    ? extendWhenRemainingSecondsBelow
                    : 90;
                const maxHops = Number.isFinite(getCfg()?.BASKET?.LOOP_MAX_HOPS) ? getCfg().BASKET.LOOP_MAX_HOPS : 12;
                const safeMaxHops = Math.max(1, maxHops);
                let hopCount = 1; // initial A->B transfer already happened
                let loopSeatInfo = seatInfoB || seatInfoA;

                audit('basket_loop_enabled', {
                    aEmail: emailA,
                    bEmail: emailB,
                    seatId: loopSeatInfo?.seatId || null,
                    loopThreshold,
                    maxHops: safeMaxHops
                });
                logger.warn('Basket loop enabled', { loopThreshold, maxHops: safeMaxHops });

                // Reset timer for current holder holding period
                try { basketTimer.start(); } catch {}

                while (hopCount < safeMaxHops) {
                    const finPause = await pauseForFinalizeIfRequested(`basket_loop_hop_${hopCount + 1}`);
                    if (finPause === 'done') {
                        try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                        return res.json(finalizedToCResult);
                    }
                    if (finPause === 'error') {
                        try { audit('basket_loop_finalize_failed_continue', { hop: hopCount + 1 }); } catch {}
                    }

                    const fromRole = currentHolder || 'B';
                    const toRole = (fromRole === 'A') ? 'B' : 'A';
                    const fromPage = (fromRole === 'A') ? pageA : pageB;
                    const toPage = (toRole === 'A') ? pageA : pageB;
                    const fromEmail = (fromRole === 'A') ? emailA : emailB;
                    const fromPass = (fromRole === 'A') ? passwordA : passwordB;
                    const toEmail = (toRole === 'A') ? emailA : emailB;
                    const toPass = (toRole === 'A') ? passwordA : passwordB;

                    audit('basket_loop_hop_plan', { hop: hopCount + 1, from: fromRole, to: toRole, fromEmail, toEmail, seatId: loopSeatInfo?.seatId || null });

                    const prepareReceiverForExactPick = async (ctxLabel) => {
                        const maxAttempts = 3;
                        let lastErr = null;
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            try {
                                const fp = await pauseForFinalizeIfRequested(`basket_recv_${ctxLabel}_${attempt}`);
                                if (fp === 'done') {
                                    const ex = new Error('FINALIZE_COMPLETED');
                                    ex.code = 'FINALIZE_COMPLETED';
                                    throw ex;
                                }

                                try { await reloginIfRedirected(toPage, toEmail, toPass); } catch {}

                                setStep(`${toRole}.loop.${ctxLabel}.gotoEvent.start`, { attempt });
                                await gotoWithRetry(toPage, String(eventAddress), {
                                    retries: 2,
                                    waitUntil: 'networkidle2',
                                    expectedUrlIncludes: eventPathIncludes,
                                    rejectIfHome: true,
                                    backoffMs: 450
                                });
                                setStep(`${toRole}.loop.${ctxLabel}.gotoEvent.done`, { attempt, snap: await snapshotPage(toPage, `${toRole}.loop.${ctxLabel}.afterEventGoto`) });

                                setStep(`${toRole}.loop.${ctxLabel}.clickBuy.start`, { attempt });
                                await clickBuy(toPage, eventAddress);
                                setStep(`${toRole}.loop.${ctxLabel}.clickBuy.done`, { attempt });

                                const toIdentity = (toRole === 'A') ? (idProfileA?.identity ?? identity) : (idProfileB?.identity ?? identity);
                                const toFan = (toRole === 'A') ? (idProfileA?.fanCardCode ?? fanCardCode) : (idProfileB?.fanCardCode ?? fanCardCode);
                                const toSicil = (toRole === 'A') ? (idProfileA?.sicilNo ?? sicilNo) : (idProfileB?.sicilNo ?? sicilNo);
                                const toPriorityTicket = (toRole === 'A') ? (idProfileA?.priorityTicketCode ?? priorityTicketCode) : (idProfileB?.priorityTicketCode ?? priorityTicketCode);
                                const toPhone = (toRole === 'A') ? (idProfileA?.phone ?? priorityPhone) : (idProfileB?.phone ?? priorityPhone);
                                await handlePrioritySaleModal(toPage, { prioritySale, fanCardCode: toFan, identity: toIdentity, sicilNo: toSicil, priorityTicketCode: toPriorityTicket, priorityPhone: toPhone, priorityTckn });

                                await ensureUrlContains(toPage, '/koltuk-secim', { retries: 2, waitMs: 9000, backoffMs: 450 });
                                const u = (() => { try { return String(toPage.url()); } catch { return ''; } })();
                                if (!u.includes('/koltuk-secim')) {
                                    throw new Error(`RECEIVER_NOT_IN_SEAT_SELECTION:${u || 'unknown'}`);
                                }

                                await toPage.waitForSelector('.custom-select-box, .ticket-type-title, #custom_seat_button', { timeout: 12000 }).catch(() => {});
                                audit('basket_loop_receiver_ready', { hop: hopCount + 1, from: fromRole, to: toRole, attempt, url: u, seatId: loopSeatInfo?.seatId || null });
                                return true;
                            } catch (e) {
                                if (e && e.code === 'FINALIZE_COMPLETED') throw e;
                                lastErr = e;
                                audit('basket_loop_receiver_prepare_failed', {
                                    hop: hopCount + 1,
                                    from: fromRole,
                                    to: toRole,
                                    attempt,
                                    error: e?.message || String(e),
                                    url: (() => { try { return toPage.url(); } catch { return null; } })(),
                                    seatId: loopSeatInfo?.seatId || null
                                }, 'warn');
                                try { await delay(800 + (attempt * 600)); } catch {}
                            }
                        }
                        throw lastErr || new Error('RECEIVER_PREPARE_FAILED');
                    };

                    // Prepare receiver BEFORE release
                    // If receiver can't reach /koltuk-secim, do NOT release from holder.
                    try {
                        await prepareReceiverForExactPick('prepare');
                    } catch (prepErr) {
                        if (prepErr && prepErr.code === 'FINALIZE_COMPLETED' && finalizedToCResult) {
                            try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                            return res.json(finalizedToCResult);
                        }
                        throw prepErr;
                    }

                    let releasedResolve;
                    const releasedPromise = new Promise((resolve) => { releasedResolve = resolve; });

                    const waitPickTo = (async () => {
                        audit('basket_loop_receiver_waiting_release', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null });
                        await releasedPromise;

                        // After release, receiver may get redirected to home/login; ensure we are back on /koltuk-secim.
                        await prepareReceiverForExactPick('postRelease');

                        try { await applyCategoryBlockSelection(toPage, categorySelectionMode, (currentCatBlock || catBlockA), loopSeatInfo); } catch {}
                        try { await openSeatMapStrict(toPage); } catch {}
                        const seatSelectionUrl = (() => { try { return toPage.url(); } catch { return null; } })();
                        const loopTargets = normalizeHeldSeats(loopSeatInfo);
                        const exactMaxMs = Math.max(30000, Math.min((getCfg().TIMEOUTS.SEAT_PICK_EXACT_MAX || 0) * Math.max(1, loopTargets.length || 1), 180000));
                        audit('basket_loop_exact_pick_start', {
                            hop: hopCount + 1,
                            from: fromRole,
                            to: toRole,
                            seatId: loopSeatInfo?.seatId || null,
                            heldSeatCount: loopTargets.length || 1,
                            maxMs: exactMaxMs,
                            seatSelectionUrl
                        });
                        // Fix misleading error messages: context must reflect the receiver role.
                        try {
                            const prev = loopSeatInfo.__recoveryOptions || {};
                            loopSeatInfo.__recoveryOptions = { ...prev, context: String(toRole) };
                        } catch {}
                        const got = await pickExactSeatBundleReleaseAware(toPage, loopSeatInfo, exactMaxMs, {
                            audit: (phase, payload) => audit(`basket_loop_${phase}`, { hop: hopCount + 1, from: fromRole, to: toRole, ...payload })
                        });
                        audit('basket_loop_exact_pick_done', {
                            hop: hopCount + 1,
                            from: fromRole,
                            to: toRole,
                            seatId: loopSeatInfo?.seatId || null,
                            pickedSeatId: got?.seatId || null,
                            row: got?.row || null,
                            seat: got?.seat || null,
                            heldSeatCount: Array.isArray(got?.heldSeats) ? got.heldSeats.length : (got?.itemCount || null)
                        });
                        return got;
                    })();

                    // Wait threshold on current holder — alıcı (toRole) koltuk sayfasında beklerken oturum düşmesin
                    const loopStartMs = Date.now();
                    let triggered = false;
                    const passiveRecvUrl = (() => {
                        try {
                            const u = String(toPage.url() || '');
                            if (u.includes('/koltuk-secim')) return u;
                        } catch {}
                        return String(eventAddress || '');
                    })();
                    startPassiveSeatWatch({
                        page: toPage,
                        email: toEmail,
                        password: toPass,
                        recoveryUrl: passiveRecvUrl,
                        label: `loop_recv_${toRole}_wait_release`
                    });
                    try {
                        await parkHolderOnBasket(fromPage, basketTimer, {
                            email: fromEmail,
                            password: fromPass,
                            reloginIfRedirected,
                            label: `${fromRole}.loop.waitingHolder`
                        });
                        while (Date.now() - loopStartMs < (getCfg().BASKET.HOLDING_TIME_SECONDS * 1000)) {
                            if (finalizeInFlight) {
                                try { await finalizeInFlight; } catch {}
                                if (finalizedToCResult) {
                                    try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                                    return res.json(finalizedToCResult);
                                }
                            }
                            const uiStatus = await checkBasketTimeoutFromPage(fromPage).catch(() => null);
                            const uiRemaining = Number(uiStatus?.remainingSeconds);
                            if (Number.isFinite(uiRemaining) && uiRemaining >= 0) {
                                try { basketTimer.syncFromRemainingSeconds(uiRemaining); } catch {}
                            }
                            const st = basketTimer.getStatus();
                            const rem = st.remainingSeconds;
                            if (Number.isFinite(rem) && rem <= loopThreshold) {
                                triggered = true;
                                audit('basket_loop_hop_triggered', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null, remainingSeconds: rem, threshold: loopThreshold });
                                break;
                            }
                            await delay(1500);
                        }
                    } finally {
                        clearPassiveSessionWatch();
                    }

                    if (!triggered) {
                        audit('basket_loop_stop_no_trigger', { hop: hopCount + 1, from: fromRole, to: toRole, seatId: loopSeatInfo?.seatId || null }, 'warn');
                        break;
                    }

                    // Release from holder
                    audit('basket_loop_release_start', { hop: hopCount + 1, from: fromRole, to: toRole, fromEmail, seatId: loopSeatInfo?.seatId || null });
                    try { await reloginIfRedirected(fromPage, fromEmail, fromPass); } catch {}
                    try {
                        await gotoWithRetry(fromPage, 'https://www.passo.com.tr/tr/sepet', {
                            retries: 2,
                            waitUntil: 'networkidle2',
                            expectedUrlIncludes: '/sepet',
                            rejectIfHome: false,
                            backoffMs: 450
                        });
                        await fromPage.waitForSelector(BASKET_ROOT_SELECTOR, { timeout: 8000 }).catch(() => {});
                    } catch {}

                    let removed = false;
                    let removeDiag = null;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        if (removed) break;
                        removeDiag = await clearBasketFully(fromPage, { timeoutMs: getCfg().TIMEOUTS.REMOVE_FROM_CART_TIMEOUT });
                        removed = removeDiag?.ok === true;
                        if (removed) break;
                        try {
                            await gotoWithRetry(fromPage, 'https://www.passo.com.tr/tr/sepet', {
                                retries: 0,
                                waitUntil: 'networkidle2',
                                expectedUrlIncludes: '/sepet',
                                rejectIfHome: false,
                                backoffMs: 0
                            });
                            await delay(2500);
                        } catch {}
                    }
                    if (!removed) throw new Error(formatError('REMOVE_FROM_CART_FAILED_LOOP'));
                    audit('basket_loop_release_done', {
                        hop: hopCount + 1,
                        from: fromRole,
                        to: toRole,
                        fromEmail,
                        seatId: loopSeatInfo?.seatId || null,
                        initialItemCount: removeDiag?.initialCount ?? null,
                        remainingItemCount: removeDiag?.remainingCount ?? null,
                        removedClicks: removeDiag?.removedClicks ?? null
                    });
                    try { releasedResolve?.(); } catch {}

                    // Receiver should pick now
                    try {
                        loopSeatInfo = await waitPickTo;
                    } catch (wpErr) {
                        if (wpErr && wpErr.code === 'FINALIZE_COMPLETED' && finalizedToCResult) {
                            try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                            return res.json(finalizedToCResult);
                        }
                        throw wpErr;
                    }
                    setStep(`${toRole}.loop.clickContinue.start`);
                    await clickContinueInsidePage(toPage);
                    await delay(getCfg().DELAYS.AFTER_CONTINUE);
                    setStep(`${toRole}.loop.clickContinue.done`, { snap: await snapshotPage(toPage, `${toRole}.loop.afterContinue`) });

                    setHolder(toRole, loopSeatInfo, (currentCatBlock || catBlockA));
                    hopCount += 1;
                    audit('basket_loop_hop_done', { hop: hopCount, holder: toRole, seatId: loopSeatInfo?.seatId || null });

                    // Reset timer for the new holder holding period
                    try { basketTimer.start(); } catch {}
                    await parkHolderOnBasket(toPage, basketTimer, {
                        email: toEmail,
                        password: toPass,
                        reloginIfRedirected,
                        label: `${toRole}.loop.afterHop`
                    });
                }

                // For backward compatible response: put the latest seatInfo into seatInfoB variable
                seatInfoB = loopSeatInfo;
            } catch (e) {
                if (e && e.code === 'FINALIZE_COMPLETED' && finalizedToCResult) {
                    try { runStore.upsert(runId, { status: 'completed', result: finalizedToCResult }); } catch {}
                    return res.json(finalizedToCResult);
                }
                logger.warn('Basket loop failed, continuing without loop', { error: e?.message || String(e) });
                audit('basket_loop_failed', { aEmail: emailA, bEmail: emailB, seatId: seatInfoB?.seatId || seatInfoA?.seatId || null, error: e?.message || String(e) }, 'warn');
            }
        }

        // Optional external log
        if (getCfg().ORDER_LOG_URL) {
            try {
                const finalBasketStatus = basketTimer.getStatus();
                const activePaymentEntry = paymentQueueState.find((item) => Number(item?.pairIndex) === Number(paymentQueueActivePairIndex || 0)) || null;
                const paymentOwnerRole = activePaymentEntry?.paymentOwnerRole || (currentHolder === 'A' ? 'A' : 'C');
                logger.debug('Harici log servisine istek gönderiliyor', { orderLogUrl: getCfg().ORDER_LOG_URL });
                await axios.post(getCfg().ORDER_LOG_URL, {
                    link: eventAddress,
                    seat: seatInfoB.combined,
                    name: cardHolder,
                    email: email2,
                    total_basket_time: finalBasketStatus.holdingTimeSeconds,
                    current_basket_time: finalBasketStatus.elapsedSeconds,
                    remaining_basket_time: finalBasketStatus.remainingSeconds,
                    basket_start_time: finalBasketStatus.startTime,
                    basket_status: {
                        elapsedSeconds: finalBasketStatus.elapsedSeconds,
                        remainingSeconds: finalBasketStatus.remainingSeconds,
                        remainingFormatted: finalBasketStatus.remainingFormatted,
                        isExpired: finalBasketStatus.isExpired,
                        isNearExpiry: finalBasketStatus.isNearExpiry
                    },
                    status: paymentOwnerRole === 'A' ? 'Wait For Payment (A)' : 'Wait For Finalize (C)'
                }, {headers: {'Content-Type': 'application/json'}, timeout: getCfg().TIMEOUTS.ORDER_LOG_TIMEOUT});
                logger.info('Harici log servisine istek gönderildi', {
                    basketStatus: finalBasketStatus
                });
            } catch (logError) {
                logger.warn('Harici log servisine istek gönderilemedi', { error: logError.message });
            }
        }

        const finalBasketStatus = basketTimer.getStatus();
        const activePaymentEntry = paymentQueueState.find((item) => Number(item?.pairIndex) === Number(paymentQueueActivePairIndex || 0)) || null;
        const paymentOwnerRole = activePaymentEntry?.paymentOwnerRole || (currentHolder === 'A' ? 'A' : 'C');
        const paymentState = activePaymentEntry?.paymentState || null;
        logger.infoSafe('Bot başarıyla tamamlandı', {
            grabbedBy: currentHolder === 'A' ? emailA : emailB,
            seatA: seatInfoA,
            seatB: seatInfoB,
            catBlockA,
            basketStatus: finalBasketStatus,
            paymentOwnerRole,
            paymentState
        });
        try {
            runStore.upsert(runId, { status: 'completed', result: { success: true, grabbedBy: currentHolder === 'A' ? emailA : emailB, seatA: seatInfoA, seatB: seatInfoB, catBlockA, paymentOwnerRole, paymentState } });
        } catch {}
        return res.json({success: true, grabbedBy: currentHolder === 'A' ? emailA : emailB, seatA: seatInfoA, seatB: seatInfoB, catBlockA, paymentOwnerRole, paymentState});
    } catch (err) {
        if (err && err.code === 'RUN_KILLED') {
            try {
                if (basketTimer) basketTimer.reset();
            } catch {}
            try {
                runStore.upsert(runId, { status: 'killed', error: 'Panelden oturumlar kapatıldı', result: null });
            } catch {}
            logger.infoSafe('Bot durduruldu (kill-sessions)', { runId, lastStep });
            if (!res.headersSent) {
                return res.status(200).json({ success: false, killed: true, message: 'Oturum panelden sonlandırıldı' });
            }
            return;
        }
        // Sepette tutma süresi bilgisini hata mesajına ekle (eğer timer başlatıldıysa)
        let basketStatus = null;
        try {
            if (basketTimer) {
                basketStatus = basketTimer.getStatus();
                basketTimer.reset();
            }
        } catch {}
        
        let snapA, snapB;
        try { snapA = await snapshotPage(pageA, 'A.onError'); } catch (e) {
            snapA = { label: 'A.onError', error: /detached|Target closed/i.test(String(e?.message)) ? 'Sayfa oturumu sonlandı' : (e?.message || String(e)) };
        }
        try { snapB = await snapshotPage(pageB, 'B.onError'); } catch (e) {
            snapB = { label: 'B.onError', error: /detached|Target closed/i.test(String(e?.message)) ? 'Sayfa oturumu sonlandı' : (e?.message || String(e)) };
        }
        const errMsg = /detached|Target closed/i.test(String(err?.message)) ? 'Sayfa oturumu sonlandı (uzun süreli işlem sırasında sayfa değişti). Lütfen tekrar deneyin.' : String(err?.message || err);
        logger.errorSafe('Bot hatası', err, {
            team,
            ticketType,
            eventAddress,
            email,
            email2,
            basketStatus: basketStatus,
            lastStep,
            snapA,
            snapB
        });
        try {
            runStore.upsert(runId, { status: 'error', error: errMsg, result: null });
        } catch {}
        try {
            const failPairIndex = Math.max(1, Math.floor(Number(dashboardMeta.activePairIndex || dashboardMeta.cTargetPairIndex || 1)));
            await persistFailureForPair(failPairIndex, {
                paymentState: 'failed',
                finalizeState: 'failed',
                recordStatus: 'failed',
                auditMeta: {
                    phase: 'bot_error',
                    error: errMsg,
                    lastStep
                }
            });
        } catch {}
        return res.status(500).json({
            error: errMsg,
            basketStatus: basketStatus,
            lastStep,
            urlA: (() => { try { return pageA?.url?.(); } catch { return null; } })(),
            urlB: (() => { try { return pageB?.url?.(); } catch { return null; } })()
        });
    } finally {
        try { categoryLoadRegistry.removeRun(runId); } catch {}
        try { if (basketMonitor) clearInterval(basketMonitor); } catch {}
        try { if (basketHeartbeatWatch) clearInterval(basketHeartbeatWatch); } catch {}
        try { clearPassiveSessionWatch(); } catch {}
        try { if (dynamicTimingCheck) clearInterval(dynamicTimingCheck); } catch {}
        try { if (finalizeWatch) clearInterval(finalizeWatch); } catch {}
        try { if (paymentQueueWatch) clearInterval(paymentQueueWatch); } catch {}
        try { if (deferredPayableTransferWatch) clearInterval(deferredPayableTransferWatch); } catch {}
        try { if (hotAccountIngestTimer) clearInterval(hotAccountIngestTimer); } catch {}
        hotAccountIngestTimer = null;
        // Cleanup: Tarayıcıları kapat (KEEP_BROWSERS_OPEN=true ise açık bırak)
        const shouldKeepOpen = getCfg().FLAGS.KEEP_BROWSERS_OPEN === true;
        
        if (!shouldKeepOpen) {
            const cleanupDelay = getCfg().DELAYS.CLEANUP_DELAY;
            
            setTimeout(async () => {
                // Multi browsers cleanup
                try {
                    if (Array.isArray(multiBrowsers) && multiBrowsers.length) {
                        const uniq = Array.from(new Set(multiBrowsers.filter(Boolean)));
                        for (const br of uniq) {
                            try { unregisterPassobotBrowser(br); } catch {}
                            try {
                                const pages = await br.pages();
                                await Promise.all((pages || []).map(p => p.close().catch(() => {})));
                            } catch {}
                            try { await br.close(); } catch {}
                        }
                    }
                } catch {}

                try {
                    if (browserA) {
                        try { unregisterPassobotBrowser(browserA); } catch {}
                        logger.debug('BrowserA kapatılıyor');
                        const pages = await browserA.pages();
                        await Promise.all(pages.map(p => p.close().catch(() => {})));
                        await browserA.close();
                        logger.debug('BrowserA kapatıldı');
                    }
                } catch (err) {
                    logger.warn('BrowserA kapatılırken hata oluştu', { error: err.message });
                }
                
                try {
                    if (browserB) {
                        try { unregisterPassobotBrowser(browserB); } catch {}
                        logger.debug('BrowserB kapatılıyor');
                        const pages = await browserB.pages();
                        await Promise.all(pages.map(p => p.close().catch(() => {})));
                        await browserB.close();
                        logger.debug('BrowserB kapatıldı');
                    }
                } catch (err) {
                    logger.warn('BrowserB kapatılırken hata oluştu', { error: err.message });
                }
            }, cleanupDelay);
        } else {
            logger.info('Tarayıcılar açık bırakıldı (KEEP_BROWSERS_OPEN=true)');
        }
    }
}

// ─── Snipe Mode ───────────────────────────────────────────────────────────────

async function startSnipe(req, res) {
    const { SeatCoordinator } = require('../helpers/coordinator');
    const { fetchBlockMap } = require('../helpers/seat');

    let validatedData;
    try {
        validatedData = snipeRequestSchema.parse(req.body);
    } catch (error) {
        if (error.issues && Array.isArray(error.issues)) {
            return res.status(400).json({
                error: 'Doğrulama hatası',
                details: error.issues.map(e => ({ path: e.path.join('.'), message: e.message }))
            });
        }
        return res.status(400).json({ error: 'Geçersiz istek' });
    }

    const runCfg = configRoot.createRunConfigFromOverrides(validatedData.panelSettings);
    return withRunCfg(runCfg, async () => {
        const {
            eventAddress,
            serieId = '',
            targets,
            selectedBlockIds: snipeBlockIds,
            accounts: rawAccounts,
            aCredentialIds,
            teamId,
            intervalMs = 1400,
            timeoutMs = 1_800_000,
            pollConcurrency = 4,
            categorySelectionMode = 'scan',
            proxyHost, proxyPort, proxyUsername, proxyPassword,
        } = validatedData;

        const runId = (() => {
            try {
                const h = typeof req?.get === 'function' ? req.get('x-run-id') : null;
                const s = runStore.safeRunId(h);
                if (s) return s;
            } catch {}
            try { return randomUUID(); } catch { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }
        })();

        // Extract eventId from URL: .../etkinlik/slug/11352322
        const eventId = String(eventAddress || '').split('/').filter(Boolean).pop() || '';
        if (!eventId || !/^\d+$/.test(eventId)) {
            return res.status(400).json({ error: 'eventAddress\'den geçerli eventId çıkarılamadı' });
        }

        // Resolve accounts list (credentialIds or inline)
        let accountList = Array.isArray(rawAccounts) && rawAccounts.length ? rawAccounts : [];
        if (!accountList.length && Array.isArray(aCredentialIds) && aCredentialIds.length) {
            try {
                const creds = await credentialRepo.getCredentialsByIds(teamId, aCredentialIds);
                accountList = (creds || []).map(c => ({
                    email:               c.email,
                    password:            decryptSecret(c.encryptedPassword),
                    identity:            c.identity   || null,
                    phone:               c.phone      || null,
                    fanCardCode:         c.fanCardCode || null,
                    sicilNo:             c.sicilNo    || null,
                    priorityTicketCode:  c.priorityTicketCode || null,
                }));
                logger.info('startSnipe:credentials_resolved', {
                    count: accountList.length,
                    emails: accountList.map(a => a.email),
                });
            } catch (e) {
                logger.warn('startSnipe:credential_resolve_failed', { error: e?.message });
            }
        }
        if (!accountList.length) {
            return res.status(400).json({ error: 'En az 1 hesap zorunludur' });
        }

        runStore.upsert(runId, {
            status: 'running',
            runMode: 'snipe',
            eventAddress: String(eventAddress || '').slice(0, 800),
            snipeState: {
                accountCount: accountList.length,
                seatsAcquired: 0,
                activeAccounts: [],
                coordinatorRunning: false,
            }
        });

        res.json({ ok: true, runId, message: `Snipe modu başlatıldı — ${accountList.length} hesap, eventId: ${eventId}` });

        // Async snipe execution
        (async () => {
            const browsers = [];
            const accountCtxList = [];
            const runProfileStamp = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            const runProfileKey = String(runId || '').replace(/[^a-zA-Z0-9._-]/g, '_');

            try {
                // Hesapları staggered paralel başlat — her tarayıcı 2 sn arayla açılır
                // ama hepsi eş zamanlı login sürecini yürütür (sırayla bitmesini beklemez)
                logger.info('startSnipe:launching_accounts', { runId, count: accountList.length, mode: 'staggered_parallel' });

                const launchPromises = accountList.map((acc, idx) => new Promise(resolve => {
                    setTimeout(async () => {
                        const label = `snipe-${runProfileKey}-${runProfileStamp}-${idx}`;
                        const userDataDir = getCfg().USER_DATA_DIR_A
                            ? `${String(getCfg().USER_DATA_DIR_A).replace(/[\\\/]$/, '')}/${label}`
                            : undefined;
                        try {
                            const ctx = await launchAndLogin({
                                email: acc.email,
                                password: acc.password,
                                userDataDir,
                                proxyHost, proxyPort, proxyUsername, proxyPassword,
                                runId,
                            });
                            ctx.accountProfile = acc;
                            ctx.email = acc.email;
                            ctx.password = acc.password;
                            logger.info('startSnipe:account_ready', { email: acc.email, idx, total: accountList.length });
                            resolve({ ok: true, ctx });
                        } catch (e) {
                            logger.warn('startSnipe:account_launch_failed', {
                                email: acc.email, idx,
                                error: e?.message || String(e),
                            });
                            resolve({ ok: false });
                        }
                    }, idx * 2000); // 2 sn stagger — aynı anda flood yapmaz
                }));

                const launchResults = await Promise.all(launchPromises);
                for (const r of launchResults) {
                    if (r.ok && r.ctx?.page) {
                        browsers.push(r.ctx.browser);
                        accountCtxList.push(r.ctx);
                    }
                }

                if (!accountCtxList.length) {
                    logger.error('startSnipe:no_accounts_launched', { runId });
                    runStore.upsert(runId, { status: 'error', error: 'Hiçbir hesap giriş yapamadı' });
                    return;
                }

                // Poll için koltuk-secim'e GİTME — Passo SPA orada frame detach yapar.
                // Polling: sayfa içi fetch same-origin olmalı → önce ticketingweb seed URL.
                const seatSelectionUrl = String(eventAddress).replace(/\/+$/, '') + '/koltuk-secim';
                const ticketingSeedUrl = seedTicketingWebUrlForSnipePoll(eventAddress);
                await Promise.allSettled(accountCtxList.map(async (ctx) => {
                    try {
                        // Şu anki URL etkinlik sayfasıysa yeniden navigate etmeye gerek yok
                        let currentUrl = '';
                        try { currentUrl = ctx.page.url(); } catch {}
                        if (!currentUrl.includes('/etkinlik/')) {
                            await gotoWithRetry(ctx.page, String(eventAddress), {
                                retries: 2, waitUntil: 'domcontentloaded',
                                rejectIfHome: false, backoffMs: 600,
                            });
                        }
                        ctx.seatSelectionUrl = seatSelectionUrl;
                        logger.info('startSnipe:account_at_event_page', { email: ctx.email, url: eventAddress });
                        try {
                            await gotoWithRetry(ctx.page, ticketingSeedUrl, {
                                retries: 2,
                                waitUntil: 'domcontentloaded',
                                rejectIfHome: false,
                                backoffMs: 500,
                            });
                            logger.info('startSnipe:account_at_ticketingweb_for_poll', {
                                email: ctx.email,
                                url: ticketingSeedUrl,
                            });
                        } catch (e) {
                            logger.warn('startSnipe:ticketingweb_seed_nav_failed', {
                                email: ctx.email,
                                error: e?.message,
                            });
                        }
                    } catch (e) {
                        logger.warn('startSnipe:account_navigate_failed', { email: ctx.email, error: e?.message });
                    }

                    // Cookie'leri www + ticketingweb için topla (yalnızca aktif sayfa domain'i yetmez).
                    try {
                        ctx.cookieString = await buildPassoApiCookieHeader(ctx.page);
                        const pairs = (ctx.cookieString || '').split(';').filter(Boolean).length;
                        logger.info('startSnipe:cookies_extracted', { email: ctx.email, cookiePairs: pairs });
                    } catch (e) {
                        ctx.cookieString = '';
                        logger.warn('startSnipe:cookie_extract_failed', { email: ctx.email, error: e?.message });
                    }
                }));

                // ticketingweb SPA token/localStorage dolsun — getseatstatus 401 InComingToken azaltır
                await delay(1000);
                logger.info('startSnipe:ticketingweb_bootstrap_wait', { ms: 1000 });

                // Collect categoryIds from targets
                const allCategoryIds = targets.flatMap(t => Array.isArray(t.seatCategoryIds) ? t.seatCategoryIds : []);

                // Use the first available page to fetch block map
                const monitorCtx = accountCtxList[0];

                // Resolve block map
                // Öncelik sırası:
                //   1. selectedBlockIds → team_blocks DB'den resolve et (apiBlockId + svgBlockId)
                //   2. targets[].blockIds → explicit Passo block ID'leri
                //   3. targets[].seatCategoryIds → API'dan getcategories + getavailableblocklist
                let blockMap = new Map();

                const teamBlocksResolved = [];
                if (Array.isArray(snipeBlockIds) && snipeBlockIds.length && teamId) {
                    try {
                        const dbBlocks = await blockRepo.getBlocksByIds(teamId, snipeBlockIds);
                        for (const b of (dbBlocks || [])) {
                            const apiId = b.apiBlockId ? Number(b.apiBlockId) : null;
                            if (!apiId) continue;
                            teamBlocksResolved.push({
                                apiBlockId: apiId,
                                svgBlockId: b.svgBlockId || null,
                                label: b.label || String(apiId),
                                categoryId: b.categoryId || null,
                            });
                            blockMap.set(apiId, {
                                categoryId: b.categoryId ? String(b.categoryId) : null,
                                categoryName: b.label || '',
                                blockName: b.label || String(apiId),
                                svgBlockId: b.svgBlockId || null,
                            });
                        }
                        logger.info('startSnipe:team_blocks_resolved', { requested: snipeBlockIds.length, resolved: blockMap.size });
                    } catch (e) {
                        logger.warn('startSnipe:team_blocks_resolve_failed', { error: e?.message });
                    }
                }

                if (!blockMap.size) {
                    const explicitBlockIds = (targets || []).flatMap(t => Array.isArray(t.blockIds) ? t.blockIds : []);
                    if (explicitBlockIds.length) {
                        for (const blkId of explicitBlockIds) {
                            blockMap.set(Number(blkId), {
                                categoryId: null,
                                categoryName: '',
                                blockName: String(blkId),
                                svgBlockId: null,
                            });
                        }
                        logger.info('startSnipe:using_explicit_blockIds', { count: blockMap.size });
                    } else {
                        logger.info('startSnipe:fetching_block_map', { eventId, categoryCount: allCategoryIds.length });
                        try {
                            const fetched = await fetchBlockMap(monitorCtx.page, {
                                eventId,
                                serieId,
                                categoryIds: allCategoryIds.length ? allCategoryIds : null,
                            });
                            for (const [k, v] of fetched) blockMap.set(k, { ...v, svgBlockId: null });
                            logger.info('startSnipe:block_map_fetched', { blockCount: blockMap.size });
                        } catch (e) {
                            logger.warn('startSnipe:block_map_fetch_failed', { error: e?.message });
                        }
                    }
                }

                if (!blockMap.size) {
                    logger.error('startSnipe:no_blocks_to_watch', { runId });
                    runStore.upsert(runId, { status: 'error', error: 'İzlenecek blok bulunamadı' });
                    return;
                }

                // Merge per-target filters (use first target's filter as default)
                const mergedFilter = targets[0]?.filter || {};

                const coordinator = new SeatCoordinator({
                    eventId, serieId, blockMap,
                    filter: mergedFilter,
                    intervalMs, timeoutMs, pollConcurrency,
                });

                // Register all accounts as idle
                for (const ctx of accountCtxList) {
                    coordinator.addAccount(ctx);
                }

                // Update run store
                runStore.upsert(runId, {
                    snipeState: {
                        accountCount: accountCtxList.length,
                        seatsAcquired: 0,
                        activeAccounts: [],
                        coordinatorRunning: true,
                        blockCount: blockMap.size,
                    }
                });

                let seatsAcquired = 0;

                // Handle seat found → pick seat → return to idle
                coordinator.on('seat_found', async ({ seatId, blockId, categoryId, categoryName, blockName, assignedCtx, markDone }) => {
                    logger.info('startSnipe:seat_found', {
                        runId, seatId, blockId, categoryId,
                        email: assignedCtx.email,
                    });

                    // Update run store — mark account active
                    try {
                        const prev = runStore.get(runId) || {};
                        const activeAccounts = [...(prev.snipeState?.activeAccounts || []), assignedCtx.email];
                        runStore.upsert(runId, {
                            snipeState: {
                                ...(prev.snipeState || {}),
                                activeAccounts,
                            }
                        });
                    } catch {}

                    let pickFailed = false;
                    try {
                        // Hesap zaten koltuk-secim'deyse gezinme atla (gecikmeyi minimuma indir)
                        const currentUrl = assignedCtx.page.url?.() || '';
                        const alreadyOnSeatPage = currentUrl.includes('/koltuk-secim');
                        if (!alreadyOnSeatPage) {
                            try {
                                await gotoWithRetry(assignedCtx.page, seatSelectionUrl, {
                                    retries: 1, waitUntil: 'networkidle2',
                                    expectedUrlIncludes: '/koltuk-secim',
                                    rejectIfHome: false, backoffMs: 500,
                                });
                            } catch {}
                        } else {
                            logger.info('startSnipe:seat_page_already_active', { email: assignedCtx.email });
                        }

                        // SVG modda svgBlockId varsa doğrudan SVG bloğuna git, kategori seçim adımını atla
                        const blockSvgId = svgBlockId || (blockId ? `block${blockId}` : null);
                        const isSvgMode = String(categorySelectionMode || 'scan').toLowerCase() !== 'legacy';

                        if (isSvgMode && blockSvgId) {
                            logger.info('startSnipe:svg_direct_block', { email: assignedCtx.email, svgBlockId: blockSvgId, blockId });
                            try {
                                const ok = await selectSvgBlockById(assignedCtx.page, blockSvgId, {
                                    categoryId: categoryId || null,
                                    categoryLabel: categoryName || null,
                                    categoryType: null,
                                });
                                if (!ok) {
                                    logger.warn('startSnipe:svg_block_select_failed', { email: assignedCtx.email, svgBlockId: blockSvgId });
                                }
                            } catch (e) {
                                logger.warn('startSnipe:svg_block_select_error', { email: assignedCtx.email, error: e?.message });
                            }
                        } else {
                            // Legacy mod: kategori + blok seçimi
                            const catBlock = {
                                categoryText: categoryName || String(categoryId || ''),
                                blockText: blockName,
                                blockVal: String(blockId),
                            };
                            try {
                                await applyCategoryBlockSelection(
                                    assignedCtx.page,
                                    categorySelectionMode,
                                    catBlock,
                                    { svgBlockId: blockSvgId, blockId: String(blockId), seatId }
                                );
                            } catch (e) {
                                logger.warn('startSnipe:catblock_apply_failed', { email: assignedCtx.email, error: e?.message });
                            }
                        }

                        // Pick the exact seat
                        const seatInfo = { seatId, blockId: String(blockId), svgBlockId: `block${blockId}` };
                        const pickedSeat = await pickExactSeatWithVerify_ReleaseAware(
                            assignedCtx.page, seatInfo, 30_000
                        );

                        logger.info('startSnipe:seat_picked', {
                            runId, email: assignedCtx.email,
                            seatId: pickedSeat?.seatId || seatId, blockId,
                        });

                        seatsAcquired++;
                        try {
                            const prev = runStore.get(runId) || {};
                            runStore.upsert(runId, {
                                snipeState: {
                                    ...(prev.snipeState || {}),
                                    seatsAcquired,
                                    activeAccounts: (prev.snipeState?.activeAccounts || []).filter(e => e !== assignedCtx.email),
                                }
                            });
                        } catch {}

                    } catch (e) {
                        pickFailed = true;
                        logger.warn('startSnipe:seat_pick_failed', {
                            runId, seatId, blockId,
                            email: assignedCtx.email,
                            error: e?.message,
                        });
                        // Update store — remove from active accounts
                        try {
                            const prev = runStore.get(runId) || {};
                            runStore.upsert(runId, {
                                snipeState: {
                                    ...(prev.snipeState || {}),
                                    activeAccounts: (prev.snipeState?.activeAccounts || []).filter(e => e !== assignedCtx.email),
                                }
                            });
                        } catch {}
                    } finally {
                        // Return account to idle — navigate back to koltuk-secim first
                        try {
                            await gotoWithRetry(assignedCtx.page, seatSelectionUrl, {
                                retries: 1, waitUntil: 'networkidle2',
                                expectedUrlIncludes: '/koltuk-secim',
                                rejectIfHome: false, backoffMs: 500,
                            });
                        } catch {}
                        // failed=true → seatId exclusive kilidini kaldır (başka hesap deneyebilir)
                        markDone(pickFailed);
                    }
                });

                coordinator.on('stopped', () => {
                    logger.info('startSnipe:coordinator_stopped', { runId, seatsAcquired });
                    try {
                        const prev = runStore.get(runId) || {};
                        runStore.upsert(runId, {
                            status: seatsAcquired > 0 ? 'completed' : 'error',
                            snipeState: {
                                ...(prev.snipeState || {}),
                                coordinatorRunning: false,
                                seatsAcquired,
                            }
                        });
                    } catch {}
                });

                coordinator.on('timeout', () => {
                    logger.warn('startSnipe:coordinator_timeout', { runId });
                    try {
                        const prev = runStore.get(runId) || {};
                        runStore.upsert(runId, {
                            status: 'error',
                            error: 'Snipe modu zaman aşımına uğradı',
                            snipeState: { ...(prev.snipeState || {}), coordinatorRunning: false, seatsAcquired },
                        });
                    } catch {}
                });

                coordinator.on('tick_stats', (tickStats) => {
                    try {
                        const prev = runStore.get(runId) || {};
                        runStore.upsert(runId, {
                            snipeState: {
                                ...(prev.snipeState || {}),
                                lastTick: tickStats,
                            },
                        });
                    } catch {}
                    try {
                        logger.info('SeatCoordinator:tick', { runId, ...tickStats });
                    } catch {}
                });

                await coordinator.start();

                // start() hemen döner (setInterval); try bloğu bitince finally tarayıcıları kapatıyordu.
                // Snipe bitene / kill / timeout olana kadar bekleyelim — aksi halde birkaç saniye sonra tarayıcı kapanır.
                await new Promise((resolve) => {
                    let settled = false;
                    const finish = (reason) => {
                        if (settled) return;
                        settled = true;
                        try { clearInterval(poll); } catch {}
                        try { coordinator.off('stopped', onStopped); } catch {}
                        try { coordinator.off('timeout', onTimeout); } catch {}
                        logger.info('startSnipe:wait_shutdown_done', { runId, reason });
                        resolve();
                    };
                    const onStopped = () => finish('coordinator_stopped');
                    const onTimeout = () => finish('coordinator_timeout');
                    coordinator.on('stopped', onStopped);
                    coordinator.on('timeout', onTimeout);
                    const poll = setInterval(() => {
                        try {
                            const run = runStore.get(runId);
                            if (run && run.status !== 'running') {
                                try { coordinator.stop(); } catch {}
                                finish(`run_status_${String(run.status)}`);
                            }
                        } catch {}
                    }, 400);
                });

            } catch (topErr) {
                logger.errorSafe('startSnipe:top_level_error', topErr, { runId });
                try { runStore.upsert(runId, { status: 'error', error: topErr?.message || String(topErr) }); } catch {}
            } finally {
                // Cleanup browsers if KEEP_BROWSERS_OPEN not set
                if (!getCfg().KEEP_BROWSERS_OPEN) {
                    const cleanupDelay = Number(getCfg().CLEANUP_DELAY_MS) || 3000;
                    setTimeout(async () => {
                        for (const browser of browsers) {
                            try {
                                unregisterPassobotBrowser(browser);
                                const pages = await browser.pages().catch(() => []);
                                await Promise.all(pages.map(p => p.close().catch(() => {})));
                                await browser.close();
                            } catch {}
                        }
                    }, cleanupDelay);
                }
            }
        })();
    });
}

module.exports.handlePrioritySaleModal = handlePrioritySaleModal;
