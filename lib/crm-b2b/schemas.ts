import { z } from "zod";

export const enrichmentStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export const companyCreateSchema = z.object({
  legal_name: z.string().trim().min(1).max(500).optional().nullable(),
  trade_name: z.string().trim().min(1).max(500).optional().nullable(),
  cnpj: z.string().trim().max(32).optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(40).optional().nullable(),
  street: z.string().max(300).optional().nullable(),
  number: z.string().max(40).optional().nullable(),
  complement: z.string().max(120).optional().nullable(),
  district: z.string().max(120).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(2).optional().nullable(),
  zip_code: z.string().max(16).optional().nullable(),
  enrich: z.boolean().optional().default(true),
});

export const companyPatchSchema = companyCreateSchema.partial().omit({ enrich: true }).extend({
  enrich: z.boolean().optional(),
});

export const personCreateSchema = z.object({
  full_name: z.string().trim().min(1).max(300),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  notes: z.string().max(4000).optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  job_title: z.string().max(200).optional().nullable(),
  department: z.string().max(200).optional().nullable(),
  is_decision_maker: z.boolean().optional(),
  is_primary: z.boolean().optional(),
});

export const personPatchSchema = z.object({
  full_name: z.string().trim().min(1).max(300).optional(),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  notes: z.string().max(4000).optional().nullable(),
});

export const companyPersonCreateSchema = z.object({
  company_id: z.string().uuid(),
  person_id: z.string().uuid(),
  job_title: z.string().max(200).optional().nullable(),
  department: z.string().max(200).optional().nullable(),
  is_decision_maker: z.boolean().optional(),
  is_primary: z.boolean().optional(),
  notes: z.string().max(4000).optional().nullable(),
});

export const companyPersonPatchSchema = companyPersonCreateSchema
  .omit({ company_id: true, person_id: true })
  .partial();

export const importColumnMappingSchema = z.object({
  company_name: z.string().optional(),
  legal_name: z.string().optional(),
  trade_name: z.string().optional(),
  cnpj: z.string().optional(),
  person_name: z.string().optional(),
  job_title: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});

export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type PersonCreate = z.infer<typeof personCreateSchema>;
export type ImportColumnMapping = z.infer<typeof importColumnMappingSchema>;
