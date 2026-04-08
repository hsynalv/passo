const { z } = require('zod');

const objectIdLike = z.string().min(1);

const teamPayloadSchema = z.object({
  name: z.string().min(1, 'Takım adı zorunludur'),
  isActive: z.boolean().optional().default(true),
});

const categorySelectionModeHintSchema = z.enum(['legacy', 'scan', 'svg', 'scan_map']).optional().nullable();

const categoryPayloadSchema = z.object({
  label: z.string().optional(),
  categoryTypeValue: z.string().min(1, 'Kategori zorunludur'),
  selectionModeHint: categorySelectionModeHintSchema,
  svgBlockId: z.string().optional().nullable().transform((v) => (v == null ? '' : String(v).trim())),
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
      if (val === true || val === 'true' || val === '1') return true;
      return false;
    }),
}).transform((data) => {
  const value = String(data.categoryTypeValue || '').trim();
  const label = String(data.label || '').trim() || value;
  const svg = String(data.svgBlockId || '').trim();
  return {
    ...data,
    label,
    categoryTypeValue: value,
    svgBlockId: svg || undefined,
  };
});

const credentialBaseSchema = z.object({
  email: z.string().email('Gecerli bir email giriniz'),
  password: z.string().optional(),
  identity: z.string().optional().nullable(),
  fanCardCode: z.string().optional().nullable(),
  sicilNo: z.string().optional().nullable(),
  priorityTicketCode: z.string().optional().nullable(),
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
};
