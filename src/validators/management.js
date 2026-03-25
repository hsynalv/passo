const { z } = require('zod');

const objectIdLike = z.string().min(1);

const teamPayloadSchema = z.object({
  name: z.string().min(1, 'Takım adı zorunludur'),
  isActive: z.boolean().optional().default(true),
});

const categoryPayloadSchema = z.object({
  label: z.string().min(1, 'Kategori etiketi zorunludur'),
  selectionModeHint: z.enum(['legacy', 'scan', 'svg']).optional().nullable(),
  categoryTypeValue: z.string().min(1, 'Kategori değeri zorunludur'),
  alternativeCategoryValue: z.string().optional().nullable(),
  sortOrder: z.union([z.number(), z.string()]).optional().transform((val) => {
    if (val === undefined || val === null || val === '') return 0;
    const n = typeof val === 'number' ? val : parseInt(String(val).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }),
  isActive: z.boolean().optional().default(true),
});

const credentialBaseSchema = z.object({
  email: z.string().email('Gecerli bir email giriniz'),
  password: z.string().optional(),
  identity: z.string().optional().nullable(),
  fanCardCode: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
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

module.exports = {
  categoryPayloadSchema,
  credentialCreateSchema,
  credentialUpdateSchema,
  idListSchema,
  objectIdLike,
  teamPayloadSchema,
};
