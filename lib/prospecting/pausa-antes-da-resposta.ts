/**
 * A FALA DO VENDEDOR PELO CELULAR NÃO PAUSA A IA ANTES DE O LEAD RESPONDER (#5179).
 *
 * ═══ O defeito ═══
 *
 * A mensagem que uma pessoa manda do WhatsApp do próprio celular entra pelo ramo
 * `fromMe` da ingestão e, desde o #521, chama `pausarIaPorAtendimentoManual` —
 * porque um humano assumiu a conversa (ver `lib/escalacao/atendimento-manual.ts`).
 *
 * Na PROSPECÇÃO isso vira o oposto do que se quer. O vendedor acompanha o disparo
 * da campanha e complementa a abordagem à mão ("vi que vocês atendem até 19h,
 * consigo encaixar você amanhã") antes de o lead dizer qualquer coisa. Cada uma
 * dessas falas calava a IA por 60 minutos. O lead respondia "quero sim, me conta
 * mais" e ficava sem resposta automática: a conversa parecia morta do lado de
 * dentro, e o relato do #5179 descreve o contorno usado hoje — um script que
 * apaga `bot_silenced_until` na mão.
 *
 * ═══ O que esta opção faz, e o que ela NÃO faz ═══
 *
 * Com `organizations.settings.prospeccao.nao_pausar_antes_da_primeira_resposta`
 * ligada, a pausa é PULADA só quando as três coisas valem ao mesmo tempo:
 *
 *   1. a conversa é de PROSPECÇÃO — tem `metadata.prospecting_campaign_id`
 *      (a régua única de `campanhaDeProspeccaoDaConversa`, a mesma da recusa e do
 *      follow-up);
 *   2. o lead AINDA NÃO respondeu — `last_inbound_at` nulo, que é a mesma coluna
 *      que as guardas da prospecção usam para dizer "a pessoa respondeu";
 *   3. a opção está LIGADA na organização.
 *
 * Fora disso nada muda: conversa de atendimento comum continua pausando, e a
 * conversa de campanha volta a pausar no instante em que o lead responde — depois
 * da primeira resposta, quem está falando pelo celular merece o mesmo silêncio de
 * antes, porque a IA não pode responder por cima de quem está negociando.
 *
 * ═══ Padrão DESLIGADO, e falha também é desligado ═══
 *
 * Nada muda para quem não optar. Qualquer leitura que falhe (conversa sumida,
 * organização ilegível, exceção) devolve `null` e a pausa acontece como hoje:
 * calar a IA por engano é o defeito que o #534 pagou caro para consertar, e uma
 * configuração nova não pode reintroduzi-lo em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { campanhaDeProspeccaoDaConversa } from "@/lib/lgpd/sem-interesse";

import { lerNaoPausarAntesDaPrimeiraResposta } from "./personalizar";

/**
 * O motivo que vai no `audit` (`pausa_pulada`) quando a pausa é dispensada.
 * Nomeado no mesmo espírito dos motivos do #534: quem lê a trilha precisa saber
 * POR QUE a IA continuou ligada, sem abrir a conversa.
 */
export const MOTIVO_PAUSA_PULADA_PROSPECCAO_SEM_RESPOSTA = "prospeccao_sem_resposta_do_lead";

/**
 * Devo deixar de pausar a IA nesta fala? Devolve o MOTIVO quando pula, `null`
 * quando a pausa tem de acontecer (o comportamento de sempre).
 *
 * Nunca lança: a mensagem já está gravada e a ingestão não pode cair por causa
 * de uma checagem de configuração.
 */
export async function pularPausaDaProspeccaoSemResposta(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("metadata, last_inbound_at")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) {
      logger.warn("[prospeccao] leitura da conversa falhou — a pausa da IA vale como antes", {
        organization_id: organizationId,
        conversation_id: conversationId,
        detail: error.message.slice(0, 160),
      });
      return null;
    }
    const conversa = data as { metadata?: unknown; last_inbound_at?: string | null } | null;
    if (!conversa) return null;

    // 1. É conversa de campanha de prospecção?
    if (!campanhaDeProspeccaoDaConversa(conversa.metadata)) return null;

    // 2. O lead já respondeu? Então a pausa é a de sempre, mesmo com a opção ligada.
    if (conversa.last_inbound_at) return null;

    // 3. A organização optou por não pausar antes da primeira resposta?
    const { data: organizacao, error: erroDaOrg } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (erroDaOrg) {
      logger.warn("[prospeccao] leitura do ajuste da pausa falhou — a pausa da IA vale como antes", {
        organization_id: organizationId,
        conversation_id: conversationId,
        detail: erroDaOrg.message.slice(0, 160),
      });
      return null;
    }
    if (!lerNaoPausarAntesDaPrimeiraResposta((organizacao as { settings?: unknown } | null)?.settings)) {
      return null;
    }

    logger.info("[prospeccao] pausa da IA dispensada — campanha ainda sem resposta do lead", {
      organization_id: organizationId,
      conversation_id: conversationId,
      motivo: MOTIVO_PAUSA_PULADA_PROSPECCAO_SEM_RESPOSTA,
    });
    return MOTIVO_PAUSA_PULADA_PROSPECCAO_SEM_RESPOSTA;
  } catch (err) {
    logger.warn("[prospeccao] checagem da pausa lançou — a pausa da IA vale como antes", {
      organization_id: organizationId,
      conversation_id: conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return null;
  }
}
