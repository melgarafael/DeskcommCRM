/**
 * O uso de uma empresa contra os limites de um plano (spec da cobrança §5, D-4).
 *
 * `lerUsoDaOrganizacao` conta como os gatilhos `trg_trava_assentos_do_plano` e
 * `trg_trava_canais_do_plano` contam: membro ativo (`revoked_at` nulo) e não
 * provisório; canal de mensagem não arquivado QUE OCUPA UMA VAGA. Se a régua de
 * um mudar, a do outro muda junto — `uso.test.ts` confere os dois lados.
 *
 * ⚠️ "Não arquivado e não `wacalls`" não bastava (#3416). A sessão que nasceu de
 * um QR que ninguém leu fica `FAILED` SEM `phone_number`, e contava como o
 * número ocupado da empresa: a contagem da tela e a trava do banco diziam que a
 * única vaga estava em uso por uma conexão que nunca existiu. A linha só ocupa
 * vaga quando tem número pareado (a queda do transporte não devolve o slot) ou
 * quando é conexão em curso/`WORKING` sem número gravado ainda — `WORKING` sem
 * número é atraso do espelho, não ausência de conexão. Fora da conta fica só a
 * linha MORTA (`FAILED`/`STOPPED`) sem número do canal pareado por QR
 * (`PROVIDER_EM_QUE_O_NUMERO_E_A_CONEXAO`): nos outros provedores o número não
 * identifica a conexão, e a linha sem ele segue ocupando a vaga.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVIDER_EM_QUE_O_NUMERO_E_A_CONEXAO } from "@/lib/channels/capabilities";

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
      .neq("provider", "wacalls")
      // #3416: a linha morta SEM número não é número nenhum. `.or` e não dois
      // filtros em sequência: o PostgREST encadeia com AND, e "tem número E não
      // está morta" zeraria a contagem de TODO canal pareado.
      .or(`provider.neq.${PROVIDER_EM_QUE_O_NUMERO_E_A_CONEXAO},phone_number.not.is.null,status.not.in.(FAILED,STOPPED)`),
  ]);
  if (membros.error || canais.error) return null;
  return { assentos: membros.count ?? 0, canais: canais.count ?? 0 };
}
