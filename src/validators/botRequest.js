const { z } = require('zod');
const { PANEL_ENV_KEYS } = require('../config');

const accountSchema = z.object({
  email: z.string().email('Geçerli bir email adresi giriniz'),
  password: z.string().min(1, 'Şifre zorunludur'),
  identity: z.string().nullable().optional(),
  fanCardCode: z.string().nullable().optional()
});

const selectedCategorySchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1, 'Kategori etiketi zorunludur').optional(),
  categoryType: z.string().min(1, 'Kategori değeri zorunludur'),
  alternativeCategory: z.string().optional().nullable(),
  selectionModeHint: z.enum(['legacy', 'scan', 'svg']).optional().nullable(),
  sortOrder: z.union([z.number(), z.string()]).optional(),
});

const botRequestSchema = z.object({
  team: z.string().optional(),
  teamId: z.string().optional(),
  ticketType: z.enum(['combined', 'regular'], {
    errorMap: () => ({ message: 'ticketType "combined" veya "regular" olmalıdır' })
  }),
  eventAddress: z.string().url('Geçerli bir URL giriniz'),
  categorySelectionMode: z.enum(['legacy', 'scan', 'svg']).optional().default('scan'),
  categoryType: z.string().optional(),
  alternativeCategory: z.string().optional(),
  transferTargetEmail: z.string().email('Geçerli bir transfer email adresi giriniz').optional(),
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
  selectedCategoryIds: z.array(z.string().min(1)).optional(),
  selectedCategories: z.array(selectedCategorySchema).optional(),

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
    if (!hasSelectedCategory && (!data.categoryType || String(data.categoryType).trim().length === 0)) {
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
  const hasLegacyA = !!(data.email && data.password);
  const hasLegacyB = !!(data.email2 && data.password2);

  if (!aList.length && !aCredentialIds.length && !hasLegacyA) {
    ctx.addIssue({
      code: 'custom',
      path: ['aAccounts'],
      message: 'En az 1 A hesabı zorunludur (aAccounts, aCredentialIds veya email/password)'
    });
  }
  if (!bList.length && !bCredentialIds.length && !hasLegacyB) {
    ctx.addIssue({
      code: 'custom',
      path: ['bAccounts'],
      message: 'En az 1 B hesabı zorunludur (bAccounts, bCredentialIds veya email2/password2)'
    });
  }

  if (hasTeamId && !selectedCategories.length && !selectedCategoryIds.length && !String(data.categoryType || '').trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['selectedCategoryIds'],
      message: 'Takım seçildiğinde en az 1 kategori seçilmelidir'
    });
  }
});

module.exports = { botRequestSchema };
