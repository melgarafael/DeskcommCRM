import type { DecisaoDeEspacamento } from "@/lib/agent-engine/pacing/ledger-supabase";

/**
 * O FREIO ANTI-BAN DO TEXTO FIXO DO FLUXO.
 *
 * ─── O buraco ──────────────────────────────────────────────────────────────
 *
 * O passo de texto fixo é o atalho "sem cron e sem agent-worker": ele chama
 * `sendMessageHandler` direto e, com isso, passa por fora da cadeia
 * `before_send` (`runBeforeSend`) — onde mora `decidePacing`. O passo de IA, que
 * vai pelo turno do worker, tem espaçamento, jitter, teto de warm-up e teto
 * diário; o de texto fixo não tinha nenhum dos quatro.
 *
 * Duas consequências, e a segunda é a pior:
 *
 *  1. um fluxo que inscrevesse muita gente de uma vez mandava as mensagens em
 *     rajada pelo mesmo número, sem o 1,2 s + jitter que existe justamente para
 *     o envio não ter assinatura de robô;
 *  2. os envios não entravam no `pacing_ledger` — então o AGENTE do próprio CRM
 *     seguia achando o número folgado, e gastava o teto diário que o texto fixo
 *     já havia consumido. O teto protegia metade do número.
 *
 * ─── O que isto NÃO é ──────────────────────────────────────────────────────
 *
 * Não é uma segunda REGRA. A decisão é `criarPacingDoCanal`
 * (`lib/agent-engine/pacing/ledger-supabase.ts`) — a MESMA que o aviso ao
 * suporte e o envio por token já usam, com os MESMOS números de
 * `channel_knobs` e o MESMO teto absoluto de `channel_sessions`. Este arquivo
 * só traduz o veredito dela para o vocabulário de adiamento do follow-up.
 *
 * A janela de horário fica fora daqui de propósito: ela já é aplicada antes,
 * por `decidirAdiamentoPorJanela`, que compõe a janela do canal com a faixa
 * própria do agente. Perguntá-la de novo seria a segunda régua que o
 * precedente de `ritmo-do-envio-por-token.ts` proíbe.
 *
 * ─── Por que ADIAR, e não dormir ───────────────────────────────────────────
 *
 * `segurarEnvioPorToken` dorme até 5 s dentro da requisição e devolve 429
 * acima disso — certo para quem chama pela API e espera a resposta. Aqui é um
 * drain de jobs: segurar a conexão não ajuda ninguém, e o mecanismo de
 * adiamento JÁ EXISTE no caminho da janela (`action_deferred` no enrollment +
 * o mesmo job de volta para `pending` com `hold`, sem gastar tentativa). O
 * envio sai sozinho na liberação.
 */

/** O que o caminho de texto fixo faz com o veredito do ritmo. `null` = pode enviar agora. */
export interface AdiamentoPorRitmo {
  /** Instante da liberação — vira `run_after` do job e `until` do enrollment. */
  until: Date;
  /**
   * `daily_cap` (o teto, de warm-up ou do CRM) ou `pacing_throttle` (o
   * espaçamento entre mensagens do mesmo número).
   *
   * `daily_cap` é o MESMO código que `decidePacing` emite no caminho do worker
   * — o dossiê e qualquer medição de produção têm de ler um vocabulário só.
   * `pacing_throttle` não tem par lá porque, no worker, o espaçamento é
   * resolvido dormindo dentro do turno e nunca chega a virar motivo.
   */
  reason: "daily_cap" | "pacing_throttle";
}

export function adiamentoPorRitmo(decisao: DecisaoDeEspacamento): AdiamentoPorRitmo | null {
  if (decisao.liberado) return null;
  return {
    until: decisao.liberaEm,
    reason: decisao.motivo === "teto_diario" ? "daily_cap" : "pacing_throttle",
  };
}
