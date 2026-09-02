/**
 * Zod schemas for `/api/v1/contacts/*` endpoints (EPIC-05 waves 1, 2, 8).
 *
 * Contracts:
 *  - contactCreateSchema    → POST /api/v1/contacts
 *  - contactPatchSchema     → PATCH /api/v1/contacts/[id]
 *  - contactListQuerySchema → GET /api/v1/contacts (search/tag/source/cursor)
 *  - lgpdAnonymizeSchema    → POST /api/v1/lgpd/anonymize (irreversible)
 */
import { z } from "zod";

const PHONE_REGEX = /^\+\d{8,15}$/;
const NUIT_DIGITS = /^\d{9}$/;

/**
 * NUIT (Número Único de Identificação Tributária, Moçambique) — validação de
 * formato: 9 dígitos numéricos, rejeitando sequências repetidas
 * (000000000, 111111111, ...). Ao contrário do CPF brasileiro, o NUIT não tem
 * um algoritmo de dígito verificador publicamente documentado e verificável —
 * por isso este validador cobre só formato, não checksum. Inventar um
 * checksum não verificado seria pior do que não ter nenhum: rejeitaria NUITs
 * válidos ou aceitaria inválidos com falsa confiança.
 */
export function isValidNuit(raw: string): boolean {
  const s = raw.replace(/\D/g, "");
  if (!NUIT_DIGITS.test(s) || /^(\d)\1{8}$/.test(s)) return false;
  return true;
}

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone_number: z
    .string()
    .regex(PHONE_REGEX, "Telefone deve estar em formato E.164 (+258841234567)")
    .optional(),
  nuit: z.string().refine(isValidNuit, "NUIT inválido").optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().min(1).default("manual"),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
  consent: z.record(z.string(), z.unknown()).optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

export const contactPatchSchema = contactCreateSchema.partial().extend({
  source: z.string().min(1).optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export const contactListQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const lgpdAnonymizeSchema = z.object({
  contact_id: z.string().uuid(),
  justification: z.string().min(10).max(1000),
});
export type LgpdAnonymizeInput = z.infer<typeof lgpdAnonymizeSchema>;
