/**
 * LIMPEZA DE CONVERSA PEDIDA PELO CLIENTE OU PELO ATENDENTE (C-104).
 *
 * ## Por que existe
 *
 * O dono pediu uma função "parecida" com o liga/desliga do celular (`#on`/`#off`,
 * C-076/C-077), mas cujo efeito é apagar os dados do contato: contato da lista,
 * conversa, mensagens, interesses e tudo o que o `limpar-tudo.sh` apaga por
 * telefone. Duas bocas usam a mesma decisão:
 *
 *   - o CLIENTE manda a sequência configurada no WhatsApp → o ingest apaga e
 *     confirma;
 *   - o ATENDENTE clica o botão na tela da conversa → a rota apaga.
 *
 * A regra de "o que é o comando" mora aqui, num lugar só, para as duas pontas
 * lerem a MESMA configuração (`ai_agents.config`). Duplicar a leitura faria o
 * botão e o comando divergirem na primeira manutenção — o anti-pattern nº 2 do
 * CLAUDE.md.
 *
 * ## O que é, e o que NÃO é, um comando
 *
 * Só a mensagem INTEIRA conta, com a mesma normalização de `comando-de-canal`
 * (trim + lowercase + NFC + variation selectors removidos). `#limpar` sozinho é
 * comando; "vou #limpar agora" não é. É o que impede uma frase de venda de
 * apagar o cadastro.
 *
 * ## FAIL-CLOSED
 *
 * Sem agente publicado, com a flag desligada, ou com leitura falha, a resposta é
 * `aceitaCliente: false` / `permiteAtendente: false`. Apagar dado por engano é
 * irreversível; na dúvida, NÃO apaga.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarComando } from "@/lib/escalacao/comando-de-canal";

/** A sequência padrão que o cliente digita. Configurável na tela do agente. */
export const COMANDO_LIMPAR_PADRAO = "#limpar";

/** O que o gate devolve: as duas permissões e a sequência do cliente. */
export interface ConfigDeLimpeza {
  /** O CLIENTE pode pedir a limpeza pelo WhatsApp? */
  aceitaCliente: boolean;
  /** O ATENDENTE pode limpar pela tela da conversa? */
  permiteAtendente: boolean;
  /** A sequência (mensagem inteira) que dispara a limpeza do cliente. */
  sequencia: string;
}

const CONFIG_FECHADA: ConfigDeLimpeza = {
  aceitaCliente: false,
  permiteAtendente: false,
  sequencia: COMANDO_LIMPAR_PADRAO,
};

/**
 * O corpo da mensagem é o comando de limpeza? Puro: não toca banco.
 *
 * Compara a mensagem INTEIRA normalizada contra a sequência configurada. Vazia
 * nunca é comando.
 */
export function lerComandoDeLimpeza(
  body: string | null | undefined,
  sequencia: string = COMANDO_LIMPAR_PADRAO,
): boolean {
  if (typeof body !== "string") return false;
  const normalizado = normalizarComando(body);
  if (normalizado === "") return false;
  return normalizado === normalizarComando(sequencia);
}

/**
 * O agente PUBLICADO para a org aceita limpeza, por quem, e com qual sequência?
 *
 * Lê `ai_agents.config` num só SELECT. A régua de "ativo" é a do ENGINE
 * (não-arquivado + `published_version_id`), a mesma de `configDeComandosDoAgente`
 * — não o `is_active` do `rag_bot` legado (C-079).
 */
export async function configDeLimpezaDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ConfigDeLimpeza> {
  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select("config")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .not("published_version_id", "is", null)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) return CONFIG_FECHADA;
    const cfg = (data.config ?? {}) as {
      aceita_limpeza_cliente?: unknown;
      permite_limpeza_atendente?: unknown;
      comando_limpar?: unknown;
    };
    const sequencia =
      typeof cfg.comando_limpar === "string" && cfg.comando_limpar.trim() !== ""
        ? cfg.comando_limpar
        : COMANDO_LIMPAR_PADRAO;
    return {
      aceitaCliente: cfg.aceita_limpeza_cliente === true,
      permiteAtendente: cfg.permite_limpeza_atendente === true,
      sequencia,
    };
  } catch {
    return CONFIG_FECHADA;
  }
}
