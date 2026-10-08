/**
 * "ESTA ORG DEIXOU O PASSO `ai_decide` LIGADO?" — uma pergunta, um lugar (#2367).
 *
 * Mesmo desenho de `lib/ai/agents/org-tem-automatico.ts`: o fato é ORG-WIDE,
 * mora numa coluna que o banco responde sozinho (`organizations.settings`), e o
 * resultado entra na execução da ação. Aqui o leitor é um e o consumidor é um —
 * `lib/automation/actions/ai-decide.ts` —, mas o arquivo existe pelo mesmo
 * motivo: sem ele a chave espalhava leitura de jsonb por mais de um lugar e o
 * default passava a ser opinião de quem escrevesse cada linha.
 *
 * ─── O default ──────────────────────────────────────────────────────────────
 *
 * **LIGADO.** O #2228 publicou o passo e as regras gravadas depois dele decidem
 * sem ninguém precisar ligar nada; desligar a empresa inteira por omissão
 * seria quebrar regra que já existe (o padrão pedido na issue).
 *
 * **`undefined` = não deu para saber.** `aiDecideLigado` só devolve `false`
 * para um `false` gravado — e o chamador NÃO trata o `undefined` como ligado:
 * o `execute` do `ai_decide` não consulta o modelo e grava
 * `ai_decide_interruptor_ilegivel`, um motivo próprio (a tela não pode dizer
 * "a empresa desligou" quando o que houve foi erro de leitura). O interruptor é
 * um "não" explícito do operador, e na dúvida sobre agir, não se age
 * (`docs/doctrine/sistema-vivo/04-fronteira-de-autoridade.md` §4.5). O preço:
 * numa empresa LIGADA, aquele evento perde a decisão — o motor não reexecuta.
 * O mesmo lado da escolha de `lib/ai/elegibilidade/consulta-supabase.ts`;
 * o lado oposto (falhar ABERTO para não calar o agente diante de quem espera)
 * é o do orçamento em `lib/agent-engine/edge/llm/run-model-call.ts`.
 *
 * **Nunca lança.** Mesma regra das leituras de estado de
 * `lib/recursos-opcionais/estado.ts`: uma fonte que falha (cliente sem
 * `from`, rede, permissão) vira `undefined`, não exceção no meio da execução
 * da regra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Chave de `organizations.settings` — um namespace por assunto, como `conversions`. */
export const CHAVE_DAS_AUTOMACOES = "automacoes";

/** O padrão escrito (issue #2367): ligado, para não quebrar regra já gravada. */
export const AI_DECIDE_PADRAO = true;

export async function aiDecideLigado(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean | undefined> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();

    if (error) {
      logger.warn("ai_decide: não deu para ler o interruptor da empresa — o passo não decide agora", {
        organizationId,
        detalhe: error.message,
      });
      return undefined;
    }

    const settings = (data as { settings?: unknown } | null)?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return AI_DECIDE_PADRAO;
    const automacoes = (settings as Record<string, unknown>)[CHAVE_DAS_AUTOMACOES];
    if (!automacoes || typeof automacoes !== "object" || Array.isArray(automacoes)) return AI_DECIDE_PADRAO;
    const bruto = (automacoes as Record<string, unknown>).ai_decide;
    // Ausente, `null` ou lixo vindo de SQL/import: LIGADO. O interruptor desliga
    // quando o operador DESLIGA — nunca por omissão nem por valor ilegível.
    return typeof bruto === "boolean" ? bruto : AI_DECIDE_PADRAO;
  } catch (erro) {
    logger.warn("ai_decide: não deu para ler o interruptor da empresa — o passo não decide agora", {
      organizationId,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return undefined;
  }
}
