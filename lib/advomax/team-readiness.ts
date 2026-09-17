import { z } from "zod";

const membroAdvomaxSchema = z.object({
  codigo: z.number().int().positive(),
  nome: z.string().max(255),
  email: z.string().email().max(254).transform((email) => email.toLowerCase()),
  perfilCodigo: z.number().int().positive().nullable(),
  perfilNome: z.string().max(120).nullable(),
}).strict();

export type MembroAdvomax = z.infer<typeof membroAdvomaxSchema>;
export type MembroCrm = { userId: string; email: string; role: string; revoked: boolean };

export function parseEquipeAdvomax(body: unknown): MembroAdvomax[] | null {
  const parsed = z.array(membroAdvomaxSchema).safeParse(body);
  if (!parsed.success) return null;
  const emails = parsed.data.map((membro) => membro.email);
  return new Set(emails).size === emails.length ? parsed.data : null;
}

export function compararEquipes(advomax: MembroAdvomax[], crm: MembroCrm[]) {
  const porEmailAdvomax = new Map(advomax.map((membro) => [membro.email, membro]));
  const porEmailCrm = new Map(crm.map((membro) => [membro.email.toLowerCase(), membro]));
  return {
    prontos: advomax.filter((membro) => {
      const local = porEmailCrm.get(membro.email);
      return !!local && !local.revoked && !(membro.perfilCodigo === 1 && local.role !== "admin");
    }).length,
    sem_membership_crm: advomax.filter((membro) => !porEmailCrm.has(membro.email) || porEmailCrm.get(membro.email)?.revoked).map((membro) => membro.email),
    ausente_na_gestao: crm.filter((membro) => !membro.revoked && !porEmailAdvomax.has(membro.email.toLowerCase())).map((membro) => membro.email),
    perfil_divergente: advomax.filter((membro) => membro.perfilCodigo === 1 && porEmailCrm.has(membro.email) && porEmailCrm.get(membro.email)?.role !== "admin").map((membro) => membro.email),
  };
}
