const { z } = require('zod');
const { PANEL_ENV_KEYS } = require('../config');

const accountSchema = z.object({
  email: z.string().email('Geçerli bir email adresi giriniz'),
  password: z.string().min(1, 'Şifre zorunludur'),
  identity: z.string().nullable().optional(),
  fanCardCode: z.string().nullable().optional(),
  sicilNo: z.string().nullable().optional(),
  priorityTicketCode: z.string().nullable().optional(),
  canPay: z.boolean().optional(),
  transferPurpose: z.boolean().optional(),
});

const selectedCategorySchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1, 'Kategori etiketi zorunludur').optional(),
  categoryType: z.string().min(1, 'Kategori değeri zorunludur'),
  alternativeCategory: z.string().optional().nullable(),
  selectionModeHint: z.enum(['legacy', 'scan', 'svg', 'scan_map']).optional().nullable(),
  svgBlockId: z.string().optional().nullable(),
  sortOrder: z.union([z.number(), z.string()]).optional(),
});

const botRequestSchema = z.object({
  team: z.string().optional(),
  teamId: z.string().optional(),
  ticketType: z.enum(['combined', 'regular'], {
    errorMap: () => ({ message: 'ticketType "combined" veya "regular" olmalıdır' })
  }),
  eventAddress: z.string().url('Geçerli bir URL giriniz'),
  categorySelectionMode: z.enum(['legacy', 'scan', 'svg', 'scan_map']).optional().default('scan'),
  seatSelectionMode: z
    .enum(['random', 'deterministic'])
    .optional()
    .default('random'),
  categoryType: z.string().optional(),
  alternativeCategory: z.string().optional(),
  ticketCount: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 1;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(Math.floor(n), 10);
    }),
  transferTargetEmail: z.string().email('Geçerli bir transfer email adresi giriniz').optional(),
  useProxyPool: z.union([z.boolean(), z.string()]).optional().transform((val) => {
    if (val === undefined || val === null || val === '') return true;
    if (val === true || val === 'true' || val === 1 || val === '1' || val === 'on') return true;
    if (val === false || val === 'false' || val === 0 || val === '0' || val === 'off') return false;
    return true;
  }),
  /** Çoklu A/B eşleşmelerinde C finalize hangi çifti kullansın (1 = A1↔B1, 2 = A2↔B2, …). */
  cTransferPairIndex: z
    .union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 1;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    }),
  extendWhenRemainingSecondsBelow: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 90;
      const n = typeof val === 'number' ? val : parseInt(String(val), 10);
      return Number.isFinite(n) ? n : 90;
    }),
  prioritySale: z.union([z.boolean(), z.string(), z.literal('off'), z.literal('on')]).optional().transform(val => {
    if (val === 'off' || val === false || val === 'false') return false;
    if (val === 'on' || val === true || val === 'true') return true;
    return val;
  }),
  fanCardCode: z.string().nullable().optional(),
  identity: z.string().nullable().optional(),
  sicilNo: z.string().nullable().optional(),
  priorityTicketCode: z.string().nullable().optional(),
  /** GS PLUS Premium öncelik modalı için cep telefonu (form yedeği). */
  priorityPhone: z.string().nullable().optional(),
  /** GSPara Öncelik modalı için TCKN (form; üyelikten bağımsız). */
  priorityTckn: z.string().nullable().optional(),
  // Legacy single-account fields (backward compatible)
  email: z.string().email('Geçerli bir email adresi giriniz').optional(),
  password: z.string().min(1, 'Şifre zorunludur').optional(),
  email2: z.string().email('Geçerli bir email adresi giriniz (2. hesap)').optional(),
  password2: z.string().min(1, 'Şifre zorunludur (2. hesap)').optional(),

  // New multi-account fields
  aAccounts: z.array(accountSchema).optional(),
  bAccounts: z.array(accountSchema).optional(),
  aCredentialIds: z.array(z.string().min(1)).optional(),
  bCredentialIds: z.array(z.string().min(1)).optional(),
  payerACredentialIds: z.array(z.string().min(1)).optional(),
  transferACredentialIds: z.array(z.string().min(1)).optional(),
  selectedCategoryIds: z.array(z.string().min(1)).optional(),
  selectedCategories: z.array(selectedCategorySchema).optional(),
  selectedBlockIds: z.array(z.string().min(1)).optional(),

  cardHolder: z.string().min(1, 'Kart sahibi adı zorunludur').optional(),
  cardNumber: z.string().regex(/^[\d\s]{13,19}$/, 'Geçerli bir kart numarası giriniz (13-19 haneli)').optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/, 'Geçerli bir ay giriniz (01-12)').optional(),
  expiryYear: z.string().regex(/^\d{2}$/, 'Geçerli bir yıl giriniz (YY formatında)').optional(),
  cvv: z.string().regex(/^\d{3,4}$/, 'CVV 3 veya 4 haneli olmalıdır').optional(),
  proxyHost: z.string().nullable().optional(),
  proxyPort: z.string().nullable().optional(),
  proxyUsername: z.string().nullable().optional(),
  proxyPassword: z.string().nullable().optional(),

  /** Arayüzden gelen env üzerine yazılan değerler (sadece whitelist anahtarlar). */
  panelSettings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .transform((obj) => {
      if (!obj || typeof obj !== 'object') return undefined;
      const allowed = new Set(PANEL_ENV_KEYS);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!allowed.has(k)) continue;
        if (v === undefined || v === null) continue;
        out[k] = String(v).trim();
      }
      return Object.keys(out).length ? out : undefined;
    }),
}).superRefine((data, ctx) => {
  const hasTeam = !!String(data.team || '').trim();
  const hasTeamId = !!String(data.teamId || '').trim();
  if (!hasTeam && !hasTeamId) {
    ctx.addIssue({
      code: 'custom',
      path: ['team'],
      message: 'Takım seçimi zorunludur'
    });
  }

  const mode = String(data.categorySelectionMode || 'scan');
  const selectedCategories = Array.isArray(data.selectedCategories) ? data.selectedCategories : [];
  const selectedCategoryIds = Array.isArray(data.selectedCategoryIds) ? data.selectedCategoryIds : [];
  if (mode === 'legacy') {
    const hasSelectedCategory = selectedCategories.some((item) => String(item?.categoryType || '').trim());
    if (!hasSelectedCategory && !selectedCategoryIds.length && (!data.categoryType || String(data.categoryType).trim().length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryType'],
        message: 'Kategori tipi zorunludur'
      });
    }
  }

  const aList = Array.isArray(data.aAccounts) ? data.aAccounts : [];
  const bList = Array.isArray(data.bAccounts) ? data.bAccounts : [];
  const aCredentialIds = Array.isArray(data.aCredentialIds) ? data.aCredentialIds : [];
  const bCredentialIds = Array.isArray(data.bCredentialIds) ? data.bCredentialIds : [];
  const payerACredentialIds = Array.isArray(data.payerACredentialIds) ? data.payerACredentialIds : [];
  const transferACredentialIds = Array.isArray(data.transferACredentialIds) ? data.transferACredentialIds : [];
  const hasLegacyA = !!(data.email && data.password);
  const hasLegacyB = !!(data.email2 && data.password2);

  if (!aList.length && !aCredentialIds.length && !hasLegacyA) {
    ctx.addIssue({
      code: 'custom',
      path: ['aAccounts'],
      message: 'En az 1 A hesabı zorunludur (aAccounts, aCredentialIds veya email/password)'
    });
  }
  if (aCredentialIds.length && payerACredentialIds.length) {
    const payerSet = new Set(payerACredentialIds.map(String));
    const hasPayerCredential = aCredentialIds.some((id) => payerSet.has(String(id)));
    if (!hasPayerCredential) {
      ctx.addIssue({
        code: 'custom',
        path: ['payerACredentialIds'],
        message: 'Seçili A üyeliklerinden en az 1 tanesi ödeme yapabilir olmalıdır'
      });
    }
  }
  if (aCredentialIds.length && transferACredentialIds.length) {
    const transferSet = new Set(transferACredentialIds.map(String));
    const hasTransferCredential = aCredentialIds.some((id) => transferSet.has(String(id)));
    if (!hasTransferCredential) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferACredentialIds'],
        message: 'Transfer amaçlı seçimler sadece seçili A üyeliklerinden oluşmalıdır'
      });
    }
  }
  if (payerACredentialIds.length && transferACredentialIds.length) {
    const transferSet = new Set(transferACredentialIds.map(String));
    const overlap = payerACredentialIds.some((id) => transferSet.has(String(id)));
    if (overlap) {
      ctx.addIssue({
        code: 'custom',
        path: ['transferACredentialIds'],
        message: 'Aynı A üyeliği hem ödeme hem transfer amaçlı olamaz'
      });
    }
  }

  const hasPayerAFromAccounts = aList.some((item) => item && item.canPay === true);
  const hasPayerAFromCredentialIds = !!payerACredentialIds.length;
  if (hasPayerAFromAccounts || hasPayerAFromCredentialIds) {
    const missingCardFields = [];
    if (!String(data.cardHolder || '').trim()) missingCardFields.push('cardHolder');
    if (!String(data.cardNumber || '').trim()) missingCardFields.push('cardNumber');
    if (!String(data.expiryMonth || '').trim()) missingCardFields.push('expiryMonth');
    if (!String(data.expiryYear || '').trim()) missingCardFields.push('expiryYear');
    if (!String(data.cvv || '').trim()) missingCardFields.push('cvv');
    if (missingCardFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['cardHolder'],
        message: 'En az 1 A hesabı ödeme yapabilir seçildiyse kart bilgileri zorunludur'
      });
    }
  }
  // B hesabı opsiyonel: yoksa A-only mod çalışır (ödeme veya sepette tutma)

  if (hasTeamId && !selectedCategories.length && !selectedCategoryIds.length && !String(data.categoryType || '').trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['selectedCategoryIds'],
      message: 'Takım seçildiğinde en az 1 kategori seçilmelidir'
    });
  }
});

module.exports = { botRequestSchema };

// ─── Snipe Mode Schema ────────────────────────────────────────────────────────

const snipeTargetFilterSchema = z.object({
  adjacentCount: z.number().int().min(1).optional().default(1),
  maxPrice: z.number().nullable().optional().default(null),
  rows: z.array(z.string()).nullable().optional().default(null),
});

const snipeTargetSchema = z.object({
  seatCategoryIds: z.array(z.union([z.number(), z.string()]))
    .nullable().optional()
    .transform(v => (Array.isArray(v) ? v.map(Number) : null)),
  blockIds: z.array(z.union([z.number(), z.string()]))
    .nullable().optional()
    .transform(v => (Array.isArray(v) ? v.map(Number) : null)),
  filter: snipeTargetFilterSchema.optional().default({}),
});

const snipeRequestSchema = z.object({
  eventAddress: z.string().url('Geçerli bir URL giriniz'),
  serieId: z.string().optional().default(''),
  /** Klasik hedef tanımı (categoryId + blockId listesi). selectedBlockIds ile birlikte kullanılabilir. */
  targets: z.array(snipeTargetSchema).optional().default([]),
  /** team_blocks koleksiyonundan MongoDB ID'leri — apiBlockId ve svgBlockId otomatik resolve edilir. */
  selectedBlockIds: z.array(z.string().min(1)).optional(),
  accounts: z.array(accountSchema).default([]),
  aCredentialIds: z.array(z.string().min(1)).optional(),
  teamId: z.string().optional(),
  /** Çok düşük değer + çok blok → Cloudflare 429. Varsayılan biraz yüksek tutuldu. */
  intervalMs: z.number().int().min(400).max(8000).optional().default(1400),
  /** Tek tick içinde aynı sekmede en fazla kaç getseatstatus paralel (429 önleme). */
  pollConcurrency: z.number().int().min(1).max(12).optional().default(4),
  timeoutMs: z.number().int().min(10000).optional().default(1_800_000),
  categorySelectionMode: z.enum(['legacy', 'scan', 'svg', 'scan_map']).optional().default('scan'),
  useProxyPool: z.union([z.boolean(), z.string()]).optional().transform(val => {
    if (val === undefined || val === null) return true;
    if (val === true || val === 'true') return true;
    if (val === false || val === 'false') return false;
    return true;
  }),
  proxyHost: z.string().nullable().optional(),
  proxyPort: z.string().nullable().optional(),
  proxyUsername: z.string().nullable().optional(),
  proxyPassword: z.string().nullable().optional(),
  panelSettings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .transform((obj) => {
      if (!obj || typeof obj !== 'object') return undefined;
      const allowed = new Set(PANEL_ENV_KEYS);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!allowed.has(k)) continue;
        if (v === undefined || v === null) continue;
        out[k] = String(v).trim();
      }
      return Object.keys(out).length ? out : undefined;
    }),
});

module.exports = { botRequestSchema, snipeRequestSchema };
