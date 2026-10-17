/**
 * Personalização da prospecção por organização (spec 24): vocabulário por
 * nicho e voz do vendedor. Mora em `organizations.settings.prospeccao`
 * (jsonb aberto, sem migration); leitura defensiva — settings malformada cai
 * no default, nunca em exceção no meio do tick.
 */
import { z } from "zod";

export const personalizacaoProspeccaoSchema = z
  .object({
    /** Sobrescrita do mapa base por nicho: chave normalizada → vocabulário. */
    vocabulario: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(120)).optional(),
    vendedor_nome: z.string().trim().max(80).optional(),
    vendedor_apresentacao: z.string().trim().max(300).optional(),
    vendedor_diferencial: z.string().trim().max(300).optional(),
  })
  .strict();

export type PersonalizacaoProspeccao = z.infer<typeof personalizacaoProspeccaoSchema>;

export const PERSONALIZACAO_VAZIA: PersonalizacaoProspeccao = {};

/** Lê `settings.prospeccao` sem nunca lançar (tick não pode cair por config). */
export function lerPersonalizacao(settings: unknown): PersonalizacaoProspeccao {
  if (!settings || typeof settings !== "object") return PERSONALIZACAO_VAZIA;
  const fatia = (settings as Record<string, unknown>)["prospeccao"];
  const parsed = personalizacaoProspeccaoSchema.safeParse(fatia ?? {});
  return parsed.success ? parsed.data : PERSONALIZACAO_VAZIA;
}

/**
 * Bloco de voz para a instrução (lado system): quem envia e como fala.
 * Vazio quando nada configurado — e o prompt segue idêntico ao sem-voz.
 */
export function blocoVozVendedor(p: PersonalizacaoProspeccao): string {
  const linhas: string[] = [];
  if (p.vendedor_nome) linhas.push(`- Nome: ${p.vendedor_nome} (apresente-se pelo nome quando soar natural)`);
  if (p.vendedor_apresentacao) linhas.push(`- O que faz: ${p.vendedor_apresentacao}`);
  if (p.vendedor_diferencial) linhas.push(`- Diferencial a destacar quando couber: ${p.vendedor_diferencial}`);
  if (linhas.length === 0) return "";
  return `Quem envia as mensagens (escreva na voz dessa pessoa):\n${linhas.join("\n")}`;
}

/** Leitor mínimo para `personalizacaoDaOrganizacao` (pg.Pool e PoolClient casam). */
export interface LeitorDeSettings {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ settings: unknown }> }>;
}

/**
 * Lê `settings.prospeccao` da organização. Fail-open: qualquer falha (ou
 * ausência) vira personalização vazia — o tick e a prévia nunca caem por
 * causa de config.
 */
export async function personalizacaoDaOrganizacao(
  db: LeitorDeSettings,
  organizationId: string,
): Promise<PersonalizacaoProspeccao> {
  try {
    const { rows } = await db.query("select settings from organizations where id = $1", [
      organizationId,
    ]);
    return lerPersonalizacao(rows[0]?.settings);
  } catch {
    return PERSONALIZACAO_VAZIA;
  }
}
