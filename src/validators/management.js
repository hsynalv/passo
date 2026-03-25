const { z } = require('zod');

const objectIdLike = z.string().min(1);

const teamPayloadSchema = z.object({
  name: z.string().min(1, 'Takım adı zorunludur'),
  isActive: z.boolean().optional().default(true),
});

const categoryPayloadSchema = z.object({
  label: z.string().optional(),
  categoryTypeValue: z.string().min(1, 'Kategori zorunludur'),
  isActive: z.boolean().optional().default(true),
}).transform((data) => {
  const value = String(data.categoryTypeValue || '').trim();
  const label = String(data.label || '').trim() || value;
  return {
    ...data,
    label,
    categoryTypeValue: value,
  };
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
