const { z } = require('zod');

const objectIdLike = z.string().min(1);

const teamPayloadSchema = z.object({
  name: z.string().min(1, 'Takım adı zorunludur'),
  isActive: z.boolean().optional().default(true),
});

const categorySelectionModeHintSchema = z.enum(['legacy', 'scan', 'svg', 'scan_map']).optional().nullable();

function normalizeCategorySelectionHint(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'scan-map') return 'scan_map';
  if (['legacy', 'scan', 'svg', 'scan_map'].includes(v)) return v;
  return undefined;
}

const categoryBaseSchema = z.object({
  label: z.string().optional(),
  // Accept both old/new field names from manual forms and scan-map flows.
  categoryTypeValue: z.string().min(1, 'Kategori zorunludur').optional(),
  categoryType: z.string().optional(),
  selectionModeHint: categorySelectionModeHintSchema,
  selectionMode: z.string().optional().nullable(),
  mode: z.string().optional().nullable(),
  svgBlockId: z.string().optional().nullable().transform((v) => (v == null ? '' : String(v).trim())),
  blockId: z.string().optional().nullable(),
  alternativeCategoryValue: z.string().optional().nullable(),
  alternativeCategory: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  ticketCount: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(Math.floor(n), 10);
    }),
  adjacentSeats: z.union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      if (val === true || val === 'true' || val === '1') return true;
      return false;
    }),
});

const categoryPayloadSchema = categoryBaseSchema.superRefine((data, ctx) => {
  const baseValue = String(data.categoryTypeValue || data.categoryType || '').trim();
  if (!baseValue) {
    ctx.addIssue({ code: 'custom', path: ['categoryTypeValue'], message: 'Kategori zorunludur' });
  }
}).transform((data) => {
  const value = String(data.categoryTypeValue || data.categoryType || '').trim();
  const label = String(data.label || '').trim() || value;
  const svg = String(data.svgBlockId || data.blockId || '').trim();
  const hint =
    normalizeCategorySelectionHint(data.selectionModeHint)
    || normalizeCategorySelectionHint(data.selectionMode)
    || normalizeCategorySelectionHint(data.mode);
  return {
    label,
    categoryTypeValue: value,
    selectionModeHint: hint,
    alternativeCategoryValue: String(data.alternativeCategoryValue || data.alternativeCategory || '').trim(),
    svgBlockId: svg || undefined,
    isActive: data.isActive === undefined ? true : data.isActive,
    ticketCount: data.ticketCount === undefined ? 1 : data.ticketCount,
    adjacentSeats: data.adjacentSeats === undefined ? false : data.adjacentSeats,
  };
});

const categoryUpdatePayloadSchema = categoryBaseSchema.transform((data) => {
  const out = {};

  const valueRaw = (data.categoryTypeValue ?? data.categoryType);
  if (valueRaw !== undefined) {
    const value = String(valueRaw || '').trim();
    out.categoryTypeValue = value;
    if (data.label === undefined) out.label = value;
  }
  if (data.label !== undefined || out.label !== undefined) {
    out.label = String((data.label !== undefined ? data.label : out.label) || '').trim();
  }

  const hintRaw = (data.selectionModeHint ?? data.selectionMode ?? data.mode);
  if (hintRaw !== undefined) {
    out.selectionModeHint = normalizeCategorySelectionHint(hintRaw) || null;
  }

  const altRaw = (data.alternativeCategoryValue ?? data.alternativeCategory);
  if (altRaw !== undefined) {
    out.alternativeCategoryValue = String(altRaw || '').trim();
  }

  const svgRaw = (data.svgBlockId ?? data.blockId);
  if (svgRaw !== undefined) {
    const svg = String(svgRaw || '').trim();
    out.svgBlockId = svg || undefined;
  }
  if (data.isActive !== undefined) out.isActive = data.isActive;
  if (data.ticketCount !== undefined) out.ticketCount = data.ticketCount;
  if (data.adjacentSeats !== undefined) out.adjacentSeats = data.adjacentSeats;
  return out;
});

const credentialNotesSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (val === null) return '';
    const s = String(val);
    return s.length > 4000 ? s.slice(0, 4000) : s;
  });

const credentialPhoneSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((val) => {
    if (val === undefined || val === null) return undefined;
    const digits = String(val).replace(/\D/g, '').slice(0, 15);
    return digits || undefined;
  });

const credentialBaseSchema = z.object({
  email: z.string().email('Gecerli bir email giriniz'),
  password: z.string().optional(),
  identity: z.string().optional().nullable(),
  phone: credentialPhoneSchema,
  fanCardCode: z.string().optional().nullable(),
  sicilNo: z.string().optional().nullable(),
  priorityTicketCode: z.string().optional().nullable(),
  notes: credentialNotesSchema,
  isActive: z.boolean().optional().default(true),
  categoryIds: z.array(z.string().min(1)).optional().default([]),
});

const credentialCreateSchema = credentialBaseSchema.superRefine((data, ctx) => {
  if (!String(data.password || '').trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['password'],
      message: 'Sifre zorunludur',
    });
  }
});

const credentialUpdateSchema = credentialBaseSchema;

const idListSchema = z.array(objectIdLike).optional().default([]);

const proxyProtocolSchema = z.enum(['http', 'https', 'socks4', 'socks5']).optional().default('socks5');

const proxyPortSchema = z.union([z.number(), z.string()]).transform((val) => {
  const n = typeof val === 'number' ? val : parseInt(String(val || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}).refine((n) => n >= 1 && n <= 65535, 'Proxy port gecersiz');

function normalizeProxyPayload(data) {
  return {
    ...data,
    host: data.host === undefined ? undefined : String(data.host || '').trim(),
    username: data.username === undefined || data.username === null ? '' : String(data.username).trim(),
    password: data.password === undefined || data.password === null ? '' : String(data.password).trim(),
  };
}

const proxyCreateSchema = z.object({
  host: z.string().min(3, 'Proxy host zorunludur'),
  port: proxyPortSchema,
  protocol: proxyProtocolSchema,
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
}).transform(normalizeProxyPayload);

const proxyUpdateSchema = z.object({
  host: z.string().min(3, 'Proxy host zorunludur').optional(),
  port: proxyPortSchema.optional(),
  protocol: proxyProtocolSchema.optional(),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
}).transform(normalizeProxyPayload);

const proxyImportSchema = z.object({
  defaultProtocol: proxyProtocolSchema,
  rawText: z.string().optional().default(''),
  items: z.array(proxyCreateSchema).optional().default([]),
});

const scanMapScopeSchema = z.enum(['team_event', 'team']).optional().default('team_event');

const scanMapQuerySchema = z.object({
  teamId: objectIdLike,
  eventAddress: z.string().optional().default(''),
  scopeType: scanMapScopeSchema,
  includeInactive: z.union([z.boolean(), z.string()]).optional().transform((val) => {
    if (val === true || val === 'true' || val === '1') return true;
    return false;
  }),
});

const scanMapScanRequestSchema = z.object({
  teamId: objectIdLike,
  eventAddress: z.string().optional().default(''),
  scopeType: scanMapScopeSchema,
  categoryHints: z.array(z.string().min(1)).optional().default([]),
  useProxy: z.union([z.boolean(), z.string()]).optional().transform((val) => {
    if (val === undefined || val === null || val === '') return true;
    if (val === true || val === 'true' || val === '1' || val === 1) return true;
    return false;
  }),
  maxProbe: z.union([z.number(), z.string()]).optional().transform((val) => {
    const n = typeof val === 'number' ? val : parseInt(String(val || '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 30;
    return Math.min(200, Math.floor(n));
  }),
  /** Ana bot ile aynı: false/kapalı veya Passo öncelik kategori metni. */
  prioritySale: z.union([z.boolean(), z.string()]).optional().transform((val) => {
    if (val === undefined || val === null || val === '') return false;
    if (val === 'off' || val === false || val === 'false') return false;
    if (val === 'on' || val === true || val === 'true') return true;
    const s = String(val).trim();
    return s.length ? s : false;
  }),
  priorityPhone: z.string().optional().default(''),
  priorityTckn: z.string().optional().default(''),
  sicilNo: z.string().optional().default(''),
  priorityTicketCode: z.string().optional().default(''),
  fanCardCode: z.string().optional().default(''),
  identity: z.string().optional().default(''),
}).superRefine((data, ctx) => {
  const raw = String(data.eventAddress || '').trim();
  if (!raw) {
    ctx.addIssue({ code: 'custom', path: ['eventAddress'], message: 'Tarama icin etkinlik URL zorunludur' });
    return;
  }
  try {
    void new URL(raw);
  } catch {
    ctx.addIssue({ code: 'custom', path: ['eventAddress'], message: 'Etkinlik URL gecersiz' });
  }
  if (data.prioritySale === true) {
    ctx.addIssue({ code: 'custom', path: ['prioritySale'], message: 'Oncelik acikken kategori metni gonder (ana bottaki liste ile ayni deger).' });
  }
});

const scanMapItemSchema = z.object({
  categoryLabel: z.string().optional().default(''),
  tooltipText: z.string().optional().default(''),
  legendTitle: z.string().optional().default(''),
  blockId: z.string().min(1, 'blockId zorunludur'),
  confidence: z.union([z.number(), z.string()]).optional().transform((val) => {
    const n = typeof val === 'number' ? val : parseFloat(String(val || '').trim());
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }),
  scoreMeta: z.unknown().optional().transform((val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) return val;
    return {};
  }),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});

const scanMapSaveAsCategoriesSchema = z.object({
  teamId: objectIdLike,
  items: z.array(scanMapItemSchema).min(1, 'En az bir blok gerekli'),
});

// ─── Block Schemas ────────────────────────────────────────────────────────────

const blockCommonFields = {
  label: z.string().min(1, 'Blok etiketi zorunludur'),
  selectionMode: z.enum(['svg', 'legacy'], {
    errorMap: () => ({ message: 'selectionMode "svg" veya "legacy" olmalıdır' }),
  }),
  isActive: z.boolean().optional().default(true),
  ticketCount: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 1;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(Math.floor(n), 10);
    }),
  adjacentSeats: z.union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return false;
      if (val === true || val === 'true' || val === '1') return true;
      return false;
    }),
  sortOrder: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return 0;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      return Number.isFinite(n) ? Math.floor(n) : 0;
    }),
};

const blockPayloadSchema = z.object({
  ...blockCommonFields,
  // Kategoriye bağlama (opsiyonel)
  categoryId: z.string().optional().nullable().transform((v) => (v == null ? null : String(v).trim() || null)),
  // SVG fields
  svgBlockId: z.string().optional().nullable().transform((v) => (v == null ? '' : String(v).trim())),
  apiBlockId: z.union([z.number(), z.string()])
    .optional()
    .nullable()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }),
  // Legacy fields
  categoryType: z.string().optional().nullable().transform((v) => (v == null ? '' : String(v).trim())),
  blockVal: z.string().optional().nullable().transform((v) => (v == null ? '' : String(v).trim())),
}).superRefine((data, ctx) => {
  if (data.selectionMode === 'svg') {
    if (!String(data.svgBlockId || '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['svgBlockId'], message: 'SVG modunda svgBlockId zorunludur (ör. block17363)' });
    }
    // categoryType ve blockVal SVG modunda opsiyonel fallback alanları — hata oluşturmaz
  } else {
    if (!String(data.categoryType || '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['categoryType'], message: 'Legacy modunda categoryType zorunludur' });
    }
  }
});

const blockUpdatePayloadSchema = z.object({
  label: z.string().min(1).optional(),
  selectionMode: z.enum(['svg', 'legacy']).optional(),
  categoryId: z.string().optional().nullable().transform((v) => (v == null ? null : String(v).trim() || null)),
  svgBlockId: z.string().optional().nullable().transform((v) => (v == null ? undefined : String(v).trim() || undefined)),
  apiBlockId: z.union([z.number(), z.string()])
    .optional()
    .nullable()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }),
  categoryType: z.string().optional().nullable().transform((v) => (v == null ? undefined : String(v).trim() || undefined)),
  blockVal: z.string().optional().nullable().transform((v) => (v == null ? undefined : String(v).trim() || undefined)),
  isActive: z.boolean().optional(),
  ticketCount: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(Math.floor(n), 10);
    }),
  adjacentSeats: z.union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      if (val === true || val === 'true' || val === '1') return true;
      return false;
    }),
  sortOrder: z.union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
      return Number.isFinite(n) ? Math.floor(n) : undefined;
    }),
});

const scanMapSaveAsBlocksSchema = z.object({
  teamId: objectIdLike,
  items: z.array(scanMapItemSchema).min(1, 'En az bir blok gerekli'),
});

const scanMapSetDefaultSchema = z.object({
  teamId: objectIdLike,
  eventAddress: z.string().optional().default(''),
  scopeType: scanMapScopeSchema,
  categoryLabel: z.string().optional().default(''),
  mappingId: objectIdLike,
});

const scanMapClearSchema = z.object({
  teamId: objectIdLike,
  eventAddress: z.string().optional().default(''),
  scopeType: scanMapScopeSchema,
});

module.exports = {
  categoryPayloadSchema,
  categoryUpdatePayloadSchema,
  credentialCreateSchema,
  credentialUpdateSchema,
  idListSchema,
  objectIdLike,
  proxyCreateSchema,
  proxyImportSchema,
  proxyUpdateSchema,
  scanMapClearSchema,
  scanMapQuerySchema,
  scanMapScanRequestSchema,
  scanMapSaveAsCategoriesSchema,
  scanMapSetDefaultSchema,
  teamPayloadSchema,
  blockPayloadSchema,
  blockUpdatePayloadSchema,
  scanMapSaveAsBlocksSchema,
};
