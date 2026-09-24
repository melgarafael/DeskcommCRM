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
 * do operador apenas pausa a IA, como qualquer outra. Quem lê a flag é
 * `agenteAceitaComandoDeCelular` (abaixo), FAIL-CLOSED.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

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
 * A ORG/agente aceita comandos de celular (`#on`/`#off`)?
 *
 * Lê `ai_agents.config.aceita_comandos_celular` do agente PUBLICADO para a
 * sessão. FAIL-CLOSED: sem agente publicado, sem a chave, ou se a leitura falhar,
 * a resposta é `false` — o comando NÃO é aplicado. Isso é uma decisão de
 * segurança, não de conveniência: aceitar um comando por não ter conseguido ler
 * a configuração seria agir com base no que não se sabe.
 *
 * Custo: uma consulta por mensagem `fromMe` que TENHA a forma de comando (não
 * roda para mensagem normal). O caminho comum não paga nada.
 */
export async function agenteAceitaComandoDeCelular(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select("config")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("priority", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return false;
    const cfg = (data.config ?? {}) as { aceita_comandos_celular?: unknown };
    return cfg.aceita_comandos_celular === true;
  } catch {
    return false;
  }
}
