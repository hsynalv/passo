const { z } = require('zod');

const accountSchema = z.object({
  email: z.string().email('Geçerli bir email adresi giriniz'),
  password: z.string().min(1, 'Şifre zorunludur'),
  identity: z.string().nullable().optional(),
  fanCardCode: z.string().nullable().optional()
});

const botRequestSchema = z.object({
  team: z.string().min(1, 'Team zorunludur'),
  ticketType: z.enum(['combined', 'regular'], {
    errorMap: () => ({ message: 'ticketType "combined" veya "regular" olmalıdır' })
  }),
  eventAddress: z.string().url('Geçerli bir URL giriniz'),
  categorySelectionMode: z.enum(['legacy', 'scan', 'svg']).optional().default('scan'),
  categoryType: z.string().optional(),
  alternativeCategory: z.string().optional(),
  transferTargetEmail: z.string().email('Geçerli bir transfer email adresi giriniz').optional(),
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

  cardHolder: z.string().min(1, 'Kart sahibi adı zorunludur').optional(),
  cardNumber: z.string().regex(/^[\d\s]{13,19}$/, 'Geçerli bir kart numarası giriniz (13-19 haneli)').optional(),
  expiryMonth: z.string().regex(/^(0[1-9]|1[0-2])$/, 'Geçerli bir ay giriniz (01-12)').optional(),
  expiryYear: z.string().regex(/^\d{2}$/, 'Geçerli bir yıl giriniz (YY formatında)').optional(),
  cvv: z.string().regex(/^\d{3,4}$/, 'CVV 3 veya 4 haneli olmalıdır').optional(),
  proxyHost: z.string().nullable().optional(),
  proxyPort: z.string().nullable().optional(),
  proxyUsername: z.string().nullable().optional(),
  proxyPassword: z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  const mode = String(data.categorySelectionMode || 'scan');
  if (mode === 'legacy') {
    if (!data.categoryType || String(data.categoryType).trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryType'],
        message: 'Kategori tipi zorunludur'
      });
    }
  }

  const aList = Array.isArray(data.aAccounts) ? data.aAccounts : [];
  const bList = Array.isArray(data.bAccounts) ? data.bAccounts : [];
  const hasLegacyA = !!(data.email && data.password);
  const hasLegacyB = !!(data.email2 && data.password2);

  if (!aList.length && !hasLegacyA) {
    ctx.addIssue({
      code: 'custom',
      path: ['aAccounts'],
      message: 'En az 1 A hesabı zorunludur (aAccounts veya email/password)'
    });
  }
  if (!bList.length && !hasLegacyB) {
    ctx.addIssue({
      code: 'custom',
      path: ['bAccounts'],
      message: 'En az 1 B hesabı zorunludur (bAccounts veya email2/password2)'
    });
  }
});

module.exports = { botRequestSchema };
