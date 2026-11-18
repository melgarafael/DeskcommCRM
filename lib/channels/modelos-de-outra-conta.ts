/**
 * MODELO DE OUTRA CONTA SAI DA CONEXÃO, E QUEM OPERA FICA SABENDO NA HORA.
 *
 * Modelo aprovado pertence a uma conta de WhatsApp Business ESPECÍFICA, não à
 * linha da conexão: reapontada para outra conta, a linha seguia listando como
 * aprovado o que a plataforma recusa no envio. Conectar e Sincronizar passam
 * por aqui, e `neq(waba_id)` restringe ao que não é da conta atual: o que é
 * dela nunca sai, mesmo que o provedor não o tenha devolvido.
 *
 * ─── Por que a limpeza não pode ser calada ──────────────────────────────────
 *
 * Apagar o modelo zera, pela FK, o escolhido no aviso à equipe e no lembrete da
 * Agenda. O follow-up aponta por id, sem FK, e o plano B dele morre sem lançar
 * (`lib/followup/modelos-citados.ts`): segue para a IA, e com a janela fechada
 * nada sai e ninguém é avisado. Por isso o aviso nasce no momento da troca, e
 * não quando algo tenta sair. O kind leva à aba de modelos do parceiro
 * (`lib/ai/inbox-destino.ts`), onde o operador sincroniza a conta atual.
 *
 * ─── E a limpeza pode falhar por causa de outra tabela ──────────────────────
 *
 * O SET NULL da FK dispara `trg_calendar_service_type_guard`, que recusa o
 * UPDATE de um serviço ativo sem agenda ou sem profissional válido, e um
 * profissional revogado deixa o serviço nesse estado. Um único tipo assim
 * derruba a limpeza INTEIRA, a cada tentativa
 * (`tests/invariants/modelo-de-outra-conta-e-o-servico-da-agenda.test.ts`).
 *
 * Falha aqui nunca desfaz a conexão nem a sincronização: um modelo velho a mais
 * é ruim, uma conexão que não fecha é pior. Mas fica na Central, não só no log,
 * e o aviso se fecha sozinho na primeira limpeza que passar (DoD 13).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { registrarAviso } from "./zernio/avisos";

export const AVISO_MODELOS_SAIRAM = "Os modelos da conta anterior saíram desta conexão";
export const AVISO_MODELOS_FICARAM = "Os modelos da conta anterior seguem nesta conexão";

const KIND = "channel_template_review" as const;

function corpoDosQueSairam(quantos: number): string {
  const oQueSaiu =
    quantos === 1
      ? "1 modelo da conta anterior saiu"
      : `${quantos} modelos da conta anterior saíram`;
  return (
    `Esta conexão passou para outra conta, e ${oQueSaiu}: a plataforma os recusaria no envio. ` +
    "Quem usava um deles ficou sem modelo. Sincronize os modelos da conta atual e escolha de " +
    "novo no aviso à equipe, no lembrete da Agenda e nos passos de follow-up."
  );
}

const CORPO_DOS_QUE_FICARAM =
  "Esta conexão passou para outra conta, mas os modelos da anterior não puderam sair: eles " +
  "seguem na lista e a plataforma os recusa no envio. Se houver serviço da Agenda ativo sem " +
  "horários ou sem profissional válido, corrija-o primeiro: enquanto ele estiver assim, o banco " +
  "recusa a limpeza. Depois clique em Sincronizar. O aviso se fecha quando a limpeza passar.";

async function avisar(admin: SupabaseClient, organizationId: string, title: string, body: string) {
  try {
    await registrarAviso(admin, organizationId, { kind: KIND, severity: "warn", title, body });
  } catch (err) {
    logger.warn("[channels.modelos] aviso na Central não foi aberto", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Tira da conexão os modelos que não são da conta atual e devolve quantos saíram
 * (zero quando a limpeza falhou: quem chama audita só o que de fato apagou).
 * NUNCA lança: quem chama está fechando uma conexão ou uma sincronização.
 */
export async function limparModelosDeOutraConta(
  admin: SupabaseClient,
  alvo: { organizationId: string; sessionId: string; accountId: string },
): Promise<number> {
  let apagados: number;
  try {
    const { error, count } = await admin
      .from("meta_templates")
      .delete({ count: "exact" })
      .eq("organization_id", alvo.organizationId)
      .eq("channel_session_id", alvo.sessionId)
      .neq("waba_id", alvo.accountId);
    if (error) throw new Error(error.message);
    apagados = count ?? 0;
  } catch (err) {
    logger.warn("[channels.modelos] modelos de outra conta não foram limpos", {
      session_id: alvo.sessionId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await avisar(admin, alvo.organizationId, AVISO_MODELOS_FICARAM, CORPO_DOS_QUE_FICARAM);
    return 0;
  }

  try {
    const { error } = await admin
      .from("agent_inbox_items")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("organization_id", alvo.organizationId)
      .eq("kind", KIND)
      .eq("title", AVISO_MODELOS_FICARAM)
      .eq("status", "open");
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn("[channels.modelos] aviso da limpeza não foi fechado", {
      session_id: alvo.sessionId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (apagados > 0) {
    await avisar(admin, alvo.organizationId, AVISO_MODELOS_SAIRAM, corpoDosQueSairam(apagados));
  }
  return apagados;
}
