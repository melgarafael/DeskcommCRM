/**
 * COMANDOS DE CONTROLE ENVIADOS PELO CELULAR DO OPERADOR.
 *
 * ## Por que existe
 *
 * O dono da operação responde o cliente direto no WhatsApp do celular (o mesmo
 * número vinculado ao bot). Ele precisa de um interruptor: `#off` desliga o
 * automático NESTA conversa e `#on` devolve o atendimento à IA. Sem isto, a
 * única forma de ligar/desligar era pela tela do CRM.
 *
 * ## O que é, e o que NÃO é, um comando
 *
 * Só a mensagem INTEIRA conta. `#off` é comando; "vou dar um #off agora" não é —
 * e isso importa, porque o operador digita no chat do cliente e uma mensagem de
 * venda que por acaso contenha o texto não pode calar a IA.
 *
 * A comparação é feita sobre o corpo normalizado (trim + minúsculas). O produto
 * aceita apenas os literais `#on` e `#off` (decisão do dono em 2026-09-24): sem
 * barra, sem sinônimos, sem variação de caixa além do normalizado.
 *
 * ## Nunca reconhece mensagem do CLIENTE
 *
 * Este parser só é chamado no caminho de SAÍDA feita fora do CRM (`fromMe`) —
 * ver `handleOutboundFromUserPhone`. Mensagem de cliente é `inbound` e nunca
 * chega aqui.
 *
 * ## Ligado/desligado pela UI (C-076)
 *
 * A função é CONFIGURÁVEL: `ai_agents.config.aceita_comandos_celular` (default
 * `false`). Desligada, o ingest trata `#on`/`#off` como texto comum — a mensagem
 * do operador apenas pausa a IA com prazo, como qualquer outra. Ligada, além dos
 * comandos, a resposta pelo celular pausa DURÁVEL (só `#on` ou a tela religam).
 * Quem lê a flag é `agenteAceitaComandoDeCelular` (abaixo), FAIL-CLOSED.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverAgenteDaConversa, type CandidatoDeAgente } from "@/lib/ai/agents/agente-da-conversa";
import { logger } from "@/lib/logger";

export type ComandoDeCanal = "on" | "off";

/** Os dois literais aceitos, já normalizados. */
const LIGAR = "#on";
const DESLIGAR = "#off";

/**
 * Lê o comando de controle do corpo de uma mensagem. Devolve `"on"`, `"off"` ou
 * `null` quando o corpo não é um comando. Puro: não toca banco e não depende de
 * relógio.
 *
 * ⚠️ Reconhecer não é aplicar: este parser diz apenas "o corpo parece um
 * comando". Quem decide se o comando VALE é o gate de configuração do agente
 * (`agenteAceitaComandoDeCelular` abaixo, campo `aceita_comandos_celular`).
 */
export function lerComandoDeControle(body: string | null | undefined): ComandoDeCanal | null {
  if (typeof body !== "string") return null;
  const normalizado = body.trim().toLowerCase();
  if (normalizado === LIGAR) return "on";
  if (normalizado === DESLIGAR) return "off";
  return null;
}

/**
 * O agente que atende ESTA conversa aceita comandos de celular (`#on`/`#off`)?
 *
 * Lê `ai_agents.config.aceita_comandos_celular` do agente resolvido por
 * `resolverAgenteDaConversa` — a mesma régua do motor (stickiness da conversa →
 * versão publicada no número → agente único). Com dois agentes, o interruptor
 * de um não vale para as conversas do outro.
 *
 * FAIL-CLOSED: sem agente resolvido, sem a chave, ou se a leitura falhar, a
 * resposta é `false` — e `false` é o comportamento de quem nunca ligou o
 * recurso: o comando não vale e a resposta pelo celular pausa com prazo.
 *
 * Custo: três leituras por mensagem enviada pelo celular que NÃO é eco de um
 * envio nosso — um humano digitando, nunca a IA.
 */
export async function agenteAceitaComandoDeCelular(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data: conversa, error: convErr } = await supabase
      .from("conversations")
      .select("channel_session_id, active_ai_agent_id")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conversa) return false;

    let versoesPublicadasNaSessao: string[] = [];
    if (conversa.channel_session_id) {
      const { data: versoes, error: versErr } = await supabase
        .from("ai_agent_versions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      if (versErr) throw new Error(versErr.message);
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos, error: agErr } = await supabase
      .from("ai_agents")
      .select("id, config, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at")
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (agErr) throw new Error(agErr.message);

    const { agente } = resolverAgenteDaConversa(
      (candidatos ?? []) as Array<CandidatoDeAgente & { config: unknown }>,
      {
        active_ai_agent_id: conversa.active_ai_agent_id as string | null,
        versoesPublicadasNaSessao,
      },
    );
    const cfg = (agente?.config ?? {}) as { aceita_comandos_celular?: unknown };
    return cfg.aceita_comandos_celular === true;
  } catch (err) {
    logger.warn("[comando-de-canal] configuração do agente ilegível — comando não aplicado", {
      organization_id: organizationId,
      conversation_id: conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return false;
  }
}
