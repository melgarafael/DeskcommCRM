/**
 * Fire-and-forget insert into `ai_invocations`.
 *
 * Caller should NOT await. We use `queueMicrotask` so the parent handler can
 * return without waiting for the audit insert; failures bubble to logger only.
 */

import { normalizarErro } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { OrigemDaEscolha } from "@/lib/ai/pontos/resolver";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Espelha o CHECK de `ai_invocations.invocation_kind` (ver o invariante). */
export type InvocationKind =
  | "bot_respond"
  | "sentiment_classify"
  | "triage_classify"
  | "embedding_generate";

export interface LogInvocationInput {
  organization_id: string;
  /**
   * NULL quando a invocação não pertence a agente nenhum — é o caso do
   * classificador de sentimento numa org que ainda não publicou agente (issue
   * #160). Antes isto era `string` e o chamador mandava `""` para preencher,
   * que o Postgres recusa como uuid. Como o insert é fire-and-forget, o custo
   * era pago e sumia: a tabela ficava vazia e as telas de consumo mostravam
   * zero. Tipo que aceita `null` é o que descreve a realidade.
   */
  agent_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  /**
   * O vocabulário é o do CHECK de `ai_invocations.invocation_kind` — nem um
   * valor a mais.
   *
   * Achado junto com a #160: este tipo listava `sentiment_check`,
   * `embed_chunk`, `embed_query` e `intent_classify`, que o banco NÃO aceita, e
   * omitia `triage_classify` e `embedding_generate`, que aceita. Nenhum dos
   * quatro estava em uso, então não havia sintoma — era armadilha carregada:
   * quem escolhesse um deles pelo autocomplete teria um `23514` num INSERT
   * fire-and-forget, ou seja, silêncio. O par entra em
   * `tests/invariants/vocabulario-banco-x-typescript.test.ts`, que é o único
   * gate que enxerga o banco.
   */
  invocation_kind: InvocationKind;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  /**
   * Gravado como veio — sem arredondar. Quem cota em fração (o Jev) chega aqui em
   * fração. `null` = preço desconhecido, que a coluna aceita e é mais honesto que 0.
   */
  cost_cents: number | null;
  /**
   * Quando quem chama SABE o provedor — o EFETIVO do endereço da chamada (o
   * provedor do binding, na pilha do gateway). Sem ele, vale
   * `providerDoModelo(model)`, que é palpite.
   *
   * `string` e não `ProvedorComChave`, como no irmão `registrarChamadaDeIa`
   * (`lib/ai/usage/registrar-chamada.ts`): o valor vem de
   * `ai_purpose_bindings.provider`, coluna de texto livre desde a 0127 (o CHECK
   * saiu para a OpenRouter e o provedor personalizado caberem). Estreitar o tipo
   * aqui só obrigaria um `as` em cada chamador — a garantia de que a tela não
   * oferece provedor inválido mora em `lib/ai/pontos/provedores.ts`.
   */
  provider?: string;
  /** Quem decidiu usar este modelo — a coluna "por que este modelo" da tela de Execuções. */
  origem_da_escolha?: OrigemDaEscolha;
  finish_reason?: string | null;
  /**
   * Quando quem chama já tem o código canônico da falha (o Jev devolve o seu).
   * Sem ele, o código sai de `error_payload` pela régua do motor.
   */
  error_code?: string;
  citations?: Array<Record<string, unknown>>;
  error_payload?: Record<string, unknown> | null;
}

export function logInvocation(row: LogInvocationInput): void {
  queueMicrotask(() => {
    void (async () => {
      try {
        const admin = createAdminClient();
        // ─── Escreve em llm_calls, não mais em ai_invocations (migration 0130) ──
        //
        // As duas tabelas contavam a mesma coisa em lugares diferentes, e toda
        // leitura nova de telemetria precisava lembrar das duas — a que
        // esquecesse mentia. Foi o que aconteceu com a tela de uso: mostrava
        // ZERO custo enquanto o dinheiro saía.
        //
        // O mapa de nomes é o mesmo eixo com rótulos diferentes:
        // invocation_kind → purpose, prompt/completion → input/output.
        const { error } = await admin.from("llm_calls").insert({
          organization_id: row.organization_id,
          // NORMALIZA AQUI, e não no chamador (issue #160). O tipo já diz
          // `string | null`, mas `string` aceita `""` — e foi exatamente `?? ""`
          // que fez a tabela ficar vazia numa VPS com tráfego real, porque o
          // Postgres recusa string vazia como uuid e o insert é
          // fire-and-forget. A rede embaixo continua sendo esta função.
          agent_id:
            row.agent_id === null || row.agent_id.trim() === "" ? null : row.agent_id,
          purpose: row.invocation_kind,
          // `provider` não existia no shape antigo; deriva-se do id do modelo, e
          // vira 'desconhecido' quando não dá para saber — chute viraria
          // estatística, e estatística errada é pior que lacuna declarada.
          //
          // A ordem importa (issue #3098): quem sabe o provedor EFETIVO — quem
          // chama pelo gateway entrega `resolvido.provider` — vence o palpite.
          // O palpite por barra só decide quando ninguém informou nada.
          provider: provedorDaChamada(row.provider, row.model),
          model: row.model,
          origem_da_escolha: row.origem_da_escolha ?? null,
          input_tokens: row.prompt_tokens,
          output_tokens: row.completion_tokens,
          cost_cents: row.cost_cents,
          latency_ms: row.latency_ms,
          status: row.error_payload ? "erro" : "ok",
          // MESMA RÉGUA do motor (`normalizarErro`), e não um rótulo de balde.
          //
          // Aqui era `"erro_legado"` fixo para QUALQUER falha — o que apagava a
          // causa justamente na tabela que a tela `/app/ai/runs` lê para dizer
          // "o que aconteceu e o que fazer". Medido numa instalação real
          // (2026-08-18): a chave da OpenRouter sem saldo devolvia
          // `Insufficient credits`, a tela mostrava três vezes `erro_legado`
          // sem uma linha de conserto, e o dono passou horas procurando bug de
          // código num problema de fatura. `normalizarErro` já reconhece esse
          // texto como `limite_ou_saldo`, que é a linha que resolve.
          error_code: row.error_payload ? (row.error_code ?? codigoDoErro(row.error_payload)) : null,
          error_message: row.error_payload
            ? String(JSON.stringify(row.error_payload)).slice(0, 500)
            : null,
        });
        if (error) {
          logger.warn("[llm-calls] insert failed", {
            error: error.message,
            organization_id: row.organization_id,
            invocation_kind: row.invocation_kind,
          });
        }
      } catch (err) {
        logger.warn("[llm-calls] insert threw", {
          error: err instanceof Error ? err.message : String(err),
          organization_id: row.organization_id,
        });
      }
    })();
  });
}

/**
 * Classifica o payload de erro do caminho legado com a régua do motor.
 *
 * O payload é `{ message }` (ver `workers/ai-sentiment-worker.ts` e
 * `ai-response-worker.ts`), às vezes com `status`/`statusCode` quando o
 * chamador os repassou. `normalizarErro` lê exatamente esses campos, então o
 * objeto é entregue como veio — sem inventar um `Error` que perderia o status.
 *
 * Exportada para o teste: é a única parte desta função com decisão, e o resto
 * é um insert fire-and-forget que nenhum unit alcança.
 */
export function codigoDoErro(payload: Record<string, unknown>): string {
  const mensagem =
    typeof payload.message === "string" && payload.message.trim() !== ""
      ? payload.message
      : JSON.stringify(payload);
  // `Error` de verdade, e não o objeto cru: `normalizarErro` lê a mensagem por
  // `err instanceof Error ? err.message : String(err)` — um objeto simples
  // viraria a string "[object Object]" e NENHUM padrão casaria, trocando um
  // balde errado (`erro_legado`) por outro (`erro_desconhecido`).
  const erro = Object.assign(new Error(mensagem), {
    ...(typeof payload.status === "number" ? { status: payload.status } : {}),
    ...(typeof payload.statusCode === "number" ? { statusCode: payload.statusCode } : {}),
  });
  return normalizarErro(erro).error_code;
}

/**
 * O provedor que VAI PARA A LINHA, na ordem certa — issue #3098.
 *
 * Quem sabe o provedor efetivo da chamada (o `row.provider` do gateway: o
 * provedor do binding, ou o da credencial da organização) vence sempre. Sem
 * ele — chamador que não sabe, coluna vazia — vale o palpite por barra de
 * `providerDoModelo`, que continua existindo como ÚLTIMO recurso para não
 * quebrar quem de fato usa OpenRouter.
 *
 * Existe porque os escritores da tabela (`logInvocation`, o irmão
 * `registrarChamadaDeIa` e a mídia, `registrarChamadaDeMidia`) tinham cópias do
 * mesmo `??` — e a cópia era justamente o defeito: com `provider` ausente, um id
 * de modelo com barra mas de provedor personalizado (`qwen/qwen3.8-27b` no Groq)
 * saía gravado como `openrouter`, e a divisão de custo por provedor mentia. Uma
 * régua só, num lugar só, para os caminhos não voltarem a divergir.
 *
 * `""` e espaço contam como NÃO informado: a coluna do binding é texto e uma
 * linha vazia carimbada de vazio é pior que o palpite declarado — a tela de Uso
 * de IA passaria a mostrar um provedor em branco.
 */
export function provedorDaChamada(
  informado: string | null | undefined,
  model: string,
): string {
  const dito = typeof informado === "string" ? informado.trim() : "";
  return dito === "" ? providerDoModelo(model) : dito;
}

/**
 * Deriva o provedor do id do modelo.
 *
 * O shape antigo (`ai_invocations`) não guardava provedor, e a coluna existe em
 * `llm_calls`. Quando o id não diz, o valor é `'desconhecido'` — nunca um
 * palpite: a coluna alimenta a divisão de custo por provedor, e um chute vira
 * estatística que alguém vai usar para decidir onde cortar gasto.
 *
 * ⚠️ ESTE É O ÚLTIMO RECURSO (#3098). Quem SABE o provedor efetivo tem de
 * informá-lo — o palpite por barra erra sempre que um provedor personalizado
 * serve um id de agregador (`qwen/qwen3.8-27b` no Groq virava "openrouter").
 * A precedência mora em `provedorDaChamada`; ninguém chama esta função
 * diretamente para gravar linha.
 */
export function providerDoModelo(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("anthropic/") || m.startsWith("claude")) return "anthropic";
  if (m.startsWith("openai/") || m.startsWith("gpt") || m.startsWith("text-embedding")) return "openai";
  if (m.startsWith("google/") || m.startsWith("gemini")) return "google";
  // ANTES do ramo da barra: `typesafe/jev-1.13.0` tem barra e seria atribuído à
  // OpenRouter, jogando o custo do Jev na conta de outro provedor.
  if (m.startsWith("typesafe/") || m.startsWith("jev")) return "typesafe";
  if (m.includes("/")) return "openrouter";
  return "desconhecido";
}
