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

/** Os literais padrão (C-077 os torna configuráveis na tela). */
export const COMANDO_LIGAR_PADRAO = "#on";
export const COMANDO_DESLIGAR_PADRAO = "#off";

/** O par de sequências que o agente reconhece, já com defaults aplicados. */
export interface SequenciasDeComando {
  ligar: string;
  desligar: string;
}

export const SEQUENCIAS_PADRAO: SequenciasDeComando = {
  ligar: COMANDO_LIGAR_PADRAO,
  desligar: COMANDO_DESLIGAR_PADRAO,
};

/**
 * Normaliza uma sequência para comparação (C-078).
 *
 * ─── O defeito que a normalização conserta ────────────────────────────────
 *
 * Emoji é uma sequência de code points, e o mesmo desenho tem mais de uma
 * codificação. "🏍️" (o que a tela grava) é `U+1F3CD` + `U+FE0F` (variation
 * selector); "🏍" é só `U+1F3CD`. Dependendo do TECLADO do celular, o WhatsApp
 * entrega uma forma ou a outra — e a comparação exata falhava em silêncio para a
 * forma que ninguém previu.
 *
 * A normalização remove os variation selectors (`U+FE0E`/`U+FE0F`, invisíveis)
 * e aplica NFC, de modo que as duas formas do mesmo emoji casem. Para texto
 * puro (`#on`) é inócuo: nada a normalizar.
 *
 * ⚠️ É conservadora de propósito: NÃO funde emojis diferentes, não troca
 * maiúscula/minúscula "inteligente" — só remove o que é decorativo.
 */
export function normalizarComando(valor: string): string {
  return valor
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\uFE0E\uFE0F]/g, "");
}

function normalizar(valor: string): string {
  return normalizarComando(valor);
}

/**
 * Lê o comando de controle do corpo de uma mensagem. Devolve `"on"`, `"off"` ou
 * `null` quando o corpo não é um comando. Puro: não toca banco e não depende de
 * relógio.
 *
 * C-077: as sequências são CONFIGURÁVEIS por agente (`comando_ligar`/
 * `comando_desligar`). Sem configuração, valem `#on`/`#off`.
 *
 * ⚠️ Reconhecer não é aplicar: este parser diz apenas "o corpo parece um
 * comando". Quem decide se o comando VALE é o gate de configuração do agente
 * (`agenteAceitaComandoDeCelular` abaixo, campo `aceita_comandos_celular`).
 */
export function lerComandoDeControle(
  body: string | null | undefined,
  seq: SequenciasDeComando = SEQUENCIAS_PADRAO,
): ComandoDeCanal | null {
  if (typeof body !== "string") return null;
  const normalizado = normalizar(body);
  if (normalizado === "") return null;
  const ligar = normalizar(seq.ligar);
  const desligar = normalizar(seq.desligar);
  // Se as duas sequências forem iguais, "ligar" vence — a tela impede o conflito,
  // e um valor corrompido no banco precisa ter UMA resposta, não duas.
  if (normalizado === ligar) return "on";
  if (normalizado === desligar) return "off";
  return null;
}

/** O que o gate devolve: aceita? e com quais sequências? (tudo num só SELECT). */
export interface ConfigDeComandos {
  aceita: boolean;
  sequencias: SequenciasDeComando;
}

/**
 * O agente PUBLICADO para a org aceita comandos de celular, e com quais
 * sequências (C-076/C-077)?
 *
 * Lê `ai_agents.config` num só SELECT: a flag de aceitação e os dois comandos.
 * FAIL-CLOSED: sem agente publicado, sem a flag, ou se a leitura falhar, a
 * resposta é `aceita: false` — o comando NÃO é aplicado. Aceitar um comando por
 * não ter conseguido ler a configuração seria agir com base no que não se sabe.
 *
 * Custo: uma consulta por mensagem `fromMe`. Quem chama só consulta quando o
 * corpo PODE ser um comando (contém a sequência), então o caminho comum paga uma
 * comparação de string, não uma ida ao banco.
 */
export async function configDeComandosDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ConfigDeComandos> {
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
    if (error || !data) return { aceita: false, sequencias: SEQUENCIAS_PADRAO };
    const cfg = (data.config ?? {}) as {
      aceita_comandos_celular?: unknown;
      comando_ligar?: unknown;
      comando_desligar?: unknown;
    };
    const ligar =
      typeof cfg.comando_ligar === "string" && cfg.comando_ligar.trim() !== ""
        ? cfg.comando_ligar
        : COMANDO_LIGAR_PADRAO;
    const desligar =
      typeof cfg.comando_desligar === "string" && cfg.comando_desligar.trim() !== ""
        ? cfg.comando_desligar
        : COMANDO_DESLIGAR_PADRAO;
    return {
      aceita: cfg.aceita_comandos_celular === true,
      sequencias: { ligar, desligar },
    };
  } catch {
    return { aceita: false, sequencias: SEQUENCIAS_PADRAO };
  }
}

/**
 * Compatibilidade: atalho booleano sobre `configDeComandosDoAgente`. Mantido
 * porque era o contrato do C-076.
 */
export async function agenteAceitaComandoDeCelular(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  return (await configDeComandosDoAgente(supabase, organizationId)).aceita;
}
