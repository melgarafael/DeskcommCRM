import { z } from "zod";
export const catalogKinds = ["audiences", "modalities", "teachers", "spaces"] as const;
export const kindSchema = z.enum(catalogKinds);
export type CatalogKind = z.infer<typeof kindSchema>;
export const catalogLabels: Record<CatalogKind, string> = { audiences: "Públicos", modalities: "Modalidades", teachers: "Professores", spaces: "Ambientes" };
const common = {
 name: z.string().trim().min(1).max(120), notes: z.string().trim().max(2000).default(""), active: z.boolean().default(true),
};
const commonSchema = z.object(common).strict();
const audienceSchema = z.object({ ...common, min_age: z.number().int().min(0).max(120).nullable().default(null), max_age: z.number().int().min(0).max(120).nullable().default(null), age_pending: z.boolean().default(true) }).strict().refine(d => d.min_age === null || d.max_age === null || d.min_age <= d.max_age, { message: "A idade mínima deve ser menor ou igual à máxima.", path: ["max_age"] });
const modalitySchema = z.object({ ...common, aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]) }).strict().refine(d => new Set([d.name, ...d.aliases].map(s => s.toLocaleLowerCase("pt-BR"))).size === d.aliases.length + 1, { message: "Use nomes alternativos diferentes entre si e do nome principal.", path: ["aliases"] });
export function catalogSchema(kind: CatalogKind) { return kind === "audiences" ? audienceSchema : kind === "modalities" ? modalitySchema : commonSchema; }
export type CatalogRecord = { id: string; organization_id: string; name: string; notes: string; active: boolean; revision: number; created_at: string; updated_at: string; min_age?: number | null; max_age?: number | null; age_pending?: boolean; aliases?: string[] };
export const catalogColumns = (kind: CatalogKind) => "id,organization_id,name,notes,active,revision,created_at,updated_at" + (kind === "audiences" ? ",min_age,max_age,age_pending" : kind === "modalities" ? ",aliases" : "");
