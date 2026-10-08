/**
 * A linha do quadro "Por canal" (issue #2390) — montagem PURA, sem banco.
 *
 * ## O que mora aqui e o que fica no SQL
 *
 * A conta inteira é da RPC `fn_channel_metrics` (migration 0590), que copia a
 * régua da irmã `fn_attendant_metrics` (0037) e só troca o `group by` por
 * `channel_session_id`. Reimplementar a média em TypeScript seria uma SEGUNDA
 * versão da verdade — exatamente o que o critério 4 da issue proíbe. Este
 * módulo faz o que a conta não faz: ordenar, preservar a ausência e dar
 * rótulo.
 *
 * ## Duas regras que a tela não pode furar
 *
 * 1. **`null` ≠ `0` na média.** Conversa sem 1ª resposta humana não entra no
 *    cálculo (o `filter` da RPC é quem garante), e o resultado de "não medido"
 *    chega como `null`. Trocar `null` por `0` transformaria "ninguém respondeu"
 *    em "respondeu na hora zero" — a leitura mais gentil possível do vazamento.
 *    Quem pinta usa `formatDuration`, que devolve `—`.
 * 2. **O vazamento fica VISÍVEL e separado.** `sem_resposta` é coluna própria;
 *    somá-lo nas conversas ou descontá-lo da média mudaria os dois números ao
 *    mesmo tempo.
 *
 * O total é a soma das linhas, nunca um total próprio: com 2 canais e 3
 * conversas a tela mostra 3 — somar de novo no lugar errado é o "total
 * engolido" que o critério 1 mede.
 */

/** O que a RPC devolve por canal (uma linha por `channel_session_id`). */
export interface LinhaCanalBruta {
  channel_session_id: string;
  /** `null` = a sessão não tem número nem nome cadastrado; a tela dá rótulo. */
  channel_name: string | null;
  /** Tipo da conversa: `whatsapp` | `instagram` | `facebook` (check 0368). */
  channel: string | null;
  is_archived: boolean;
  conversations_handled: number;
  /** `null` = não medido na janela — nunca 0 (regra 1). */
  avg_first_response_seconds: number | null;
  sem_resposta: number;
}

/** O que a rota entrega e a tela pinta: a mesma linha, já normalizada. */
export type LinhaCanal = LinhaCanalBruta;

/**
 * Normaliza as linhas da RPC: descarta o que não tem `channel_session_id`
 * (a RPC nunca devolve, mas a rota não é o único leitor), preserva `null` na
 * média, trata nome vazio como ausente e ordena por volume (maior primeiro,
 * desempate pelo id — o mesmo critério da própria RPC).
 *
 * Nenhum campo numérico é recalculado aqui: contar de novo seria a segunda
 * versão da verdade.
 */
export function montarLinhas(brutas: LinhaCanalBruta[] | null | undefined): LinhaCanal[] {
  if (!Array.isArray(brutas)) return [];
  return brutas
    .filter((b) => typeof b.channel_session_id === "string" && b.channel_session_id.length > 0)
    .map((b) => ({
      ...b,
      channel_name:
        typeof b.channel_name === "string" && b.channel_name.trim().length > 0
          ? b.channel_name.trim()
          : null,
      avg_first_response_seconds:
        typeof b.avg_first_response_seconds === "number" ? b.avg_first_response_seconds : null,
      is_archived: b.is_archived === true,
      conversations_handled: Number(b.conversations_handled) || 0,
      sem_resposta: Number(b.sem_resposta) || 0,
    }))
    .sort(
      (a, b) =>
        b.conversations_handled - a.conversations_handled ||
        a.channel_session_id.localeCompare(b.channel_session_id),
    );
}

/**
 * O total do quadro: a SOMA das linhas, e só. Nenhum denominador, nenhum
 * total que a própria tela recalcula — com 2 canais e 3 conversas o quadro
 * mostra 3 (critério 1).
 */
export function totalDeConversas(linhas: LinhaCanal[]): number {
  return linhas.reduce((acc, l) => acc + l.conversations_handled, 0);
}

/**
 * A duração como a tabela por atendente pinta: `—` para "não medido" (o
 * `null` da média), nunca `0s`.
 */
export function formatarDuracao(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}min` : `${m}min ${rest}s`;
}

/**
 * O rótulo da linha. Sem número/nome cadastrado o canal continua aparecendo —
 * sumir com a linha seria o "total engolido" com outra roupa.
 */
export function rotuloCanal(linha: LinhaCanal, t: (texto: string) => string): string {
  if (linha.channel_name) return linha.channel_name;
  return `${t("Canal")} ${linha.channel_session_id.slice(0, 8)}`;
}
