/**
 * O NOME DE QUEM FALOU, quando quem falou é uma IA (#3310).
 *
 * ## O defeito
 *
 * `organizations.settings.assinatura_mensagens.nome_ia` é **um nome só para a
 * organização**. Numa conta com mais de um agente no mesmo número (roteador de
 * intenção), a mensagem enviada pela agente B chega ao cliente assinada com o
 * nome da agente A: o cliente lê um nome e a conversa segue com outro.
 *
 * ## O que este módulo faz, e o que NÃO faz
 *
 * Uma leitura, por `id` de agente, escopada pela organização — o `ai_actor_id`
 * da mensagem é a fonte, e o nome do agente é a assinatura. Nada de cache:
 * renomear o agente vale para o próximo envio, que é o que qualquer um espera.
 *
 * Quem decide o que fazer com o resultado é `lib/messaging/assinatura.ts`
 * (`nomeDaAssinaturaDaIA`): o nome do agente é preferido e `nome_ia` continua
 * sendo a RESERVA — para a mensagem sem agente (automação, avisos do sistema) e
 * para quando esta leitura falha. Assinatura ausente é pior que assinatura
 * genérica: a segunda o cliente já conhece.
 *
 * Nunca lança e nunca loga conteúdo: o valor é o `name` do agente, que já é
 * público dentro da própria organização, e um erro aqui não pode derrubar um
 * envio — mesma disciplina de `configAssinatura`, que degrada para o default.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** `ai_agents.id` é uuid: id em outro formato nem chega ao banco (aviso do sistema). */
const FORMATO_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O `ai_agents.name` do agente que enviou, ou `null` quando não há o que
 * resolver (mensagem sem agente, id fora do formato, agente de outra
 * organização, agente apagado, leitura que falhou).
 */
export async function nomeDoAgenteDeIA(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string | null | undefined,
): Promise<string | null> {
  const id = agentId?.trim();
  if (!id || !FORMATO_DE_UUID.test(id)) return null;
  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select("name")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (error) {
      logger.warn("[assinatura] nome do agente não lido — assinatura cai no nome da IA", {
        organization_id: organizationId,
        // Só o código/erro do banco: nome de agente é da organização, mas o
        // motivo da falha é o que interessa aqui.
        error: error.message.slice(0, 200),
      });
      return null;
    }
    const nome = (data as { name?: string | null } | null)?.name?.trim();
    return nome && nome.length > 0 ? nome : null;
  } catch (err) {
    logger.warn("[assinatura] leitura do nome do agente falhou — assinatura cai no nome da IA", {
      organization_id: organizationId,
      error: err instanceof Error ? err.name : "erro desconhecido",
    });
    return null;
  }
}
