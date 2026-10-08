/**
 * O uso de uma empresa contra os limites de um plano (spec da cobrança §5, D-4).
 *
 * `lerUsoDaOrganizacao` conta como os gatilhos `trg_trava_assentos_do_plano` e
 * `trg_trava_canais_do_plano` contam: membro ativo (`revoked_at` nulo) e não
 * provisório; canal não arquivado que não é `wacalls` (voz não é número de
 * mensagem). Se a régua de um mudar, a do outro muda junto — `uso.test.ts`
 * confere os dois lados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface UsoDaOrganizacao {
  assentos: number;
  canais: number;
}
export interface LimitesDoPlano {
  max_assentos: number | null;
  max_canais: number | null;
}
export type Excedente = Partial<Record<"assentos" | "canais", number>>;

/** Quanto o uso passa do plano; só as chaves com excesso. Vazio = cabe. `null` no plano = sem limite. */
export function excedenteDoPlano(uso: UsoDaOrganizacao, plano: LimitesDoPlano): Excedente {
  const excedente: Excedente = {};
  if (plano.max_assentos !== null && uso.assentos > plano.max_assentos) excedente.assentos = uso.assentos - plano.max_assentos;
  if (plano.max_canais !== null && uso.canais > plano.max_canais) excedente.canais = uso.canais - plano.max_canais;
  return excedente;
}

/** `null` = uma das leituras falhou. */
export async function lerUsoDaOrganizacao(db: SupabaseClient, orgId: string): Promise<UsoDaOrganizacao | null> {
  const [membros, canais] = await Promise.all([
    db
      .from("user_organizations")
      .select("user_id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("revoked_at", null)
      .eq("provisional_until_handover", false),
    db
      .from("channel_sessions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .neq("provider", "wacalls"),
  ]);
  if (membros.error || canais.error) return null;
  return { assentos: membros.count ?? 0, canais: canais.count ?? 0 };
}
