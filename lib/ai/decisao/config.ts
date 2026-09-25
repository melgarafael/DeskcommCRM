/**
 * O INTERRUPTOR DO JEV — `organizations.settings.jev`.
 *
 * Mora em `settings`, e não em `ai_purpose_bindings`, por uma razão medida:
 * aquela tabela é única por (organização, ponto). Uma linha do Jev no ponto do
 * clima APAGARIA a escolha de modelo de linguagem daquele ponto, que é
 * justamente a reserva que assume quando o Jev falha. Aqui não há migration: o
 * Zod abaixo é o schema central do caminho.
 *
 * ═══ LEITURA NUNCA LANÇA, E FALHA DESLIGADA ═══
 *
 * Quem lê é o worker de clima, a cada mensagem. Qualquer coisa fora do schema
 * vira "desligado": ligar o Jev manda a mensagem do cliente para fora do país,
 * e um JSON torto não pode fazer isso por acidente. Pelo mesmo motivo, ligado
 * SEM o aceite do administrador também vale como desligado (LGPD).
 */
import { z } from "zod";

import type { createAdminClient } from "@/lib/supabase/admin";

export const configDoJevSchema = z
  .object({
    ligado: z.boolean().default(false),
    /** `observacao`: o Jev mede, a IA de sempre decide. `decide`: o Jev decide. */
    modo: z.enum(["observacao", "decide"]).default("observacao"),
    /** Quem aceitou mandar a mensagem ao fornecedor estrangeiro, e quando. */
    aceite: z
      .object({ em: z.string().datetime(), por: z.string().uuid() })
      .nullable()
      .default(null),
    alterado_em: z.string().datetime().optional(),
    alterado_por: z.string().uuid().optional(),
  })
  .refine((c) => !c.ligado || c.aceite !== null, {
    message: "ligar o Jev exige o aceite do administrador",
  });

export type ConfigDoJev = z.infer<typeof configDoJevSchema>;

const DESLIGADO: ConfigDoJev = { ligado: false, modo: "observacao", aceite: null };

export function lerConfigDoJev(settings: unknown): ConfigDoJev {
  const jev =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>).jev
      : undefined;
  const lido = configDoJevSchema.safeParse(jev ?? {});
  return lido.success ? lido.data : { ...DESLIGADO };
}

export type ResultadoDeGravarConfig =
  | { ok: true; config: ConfigDoJev }
  | { ok: false; motivo: "leitura_falhou" | "config_invalida" | "escrita_recusada" };

export interface PedidoDeGravarConfig {
  admin: ReturnType<typeof createAdminClient>;
  /** Resolvido da SESSÃO por quem chama — nunca do corpo da requisição. */
  orgId: string;
  actorUserId: string;
  mudanca: Partial<Pick<ConfigDoJev, "ligado" | "modo" | "aceite">>;
  agora?: Date;
}

/**
 * Lê, mescla e grava. `settings` é jsonb COMPARTILHADO (marca, MFA, IA padrão,
 * onboarding): gravar `{ jev }` sozinho apagaria o resto em silêncio. O service
 * role passa por cima da RLS, então o `.eq("id", orgId)` é a única cerca entre
 * esta empresa e a instalação inteira. Auditar é de quem chama (a rota).
 */
export async function gravarConfigDoJev(p: PedidoDeGravarConfig): Promise<ResultadoDeGravarConfig> {
  const { data: org, error: leituraErr } = await p.admin
    .from("organizations")
    .select("settings")
    .eq("id", p.orgId)
    .maybeSingle();
  if (leituraErr || !org) return { ok: false, motivo: "leitura_falhou" };

  const settingsAtuais = (org.settings ?? {}) as Record<string, unknown>;
  const proxima = configDoJevSchema.safeParse({
    ...lerConfigDoJev(settingsAtuais),
    ...p.mudanca,
    alterado_em: (p.agora ?? new Date()).toISOString(),
    alterado_por: p.actorUserId,
  });
  if (!proxima.success) return { ok: false, motivo: "config_invalida" };

  const { data: gravado, error: escritaErr } = await p.admin
    .from("organizations")
    .update({ settings: { ...settingsAtuais, jev: proxima.data } })
    .eq("id", p.orgId)
    .select("settings")
    .maybeSingle();
  // Zero linhas volta como SUCESSO no PostgREST: sem esta conferência, a tela
  // diria "ligado" para uma escrita que não aconteceu.
  if (escritaErr || !gravado) return { ok: false, motivo: "escrita_recusada" };

  return { ok: true, config: proxima.data };
}
