/**
 * SÍNTESE DE VOZ, IDEMPOTENTE POR (job_id, seq) — Fase 6a do plano de voz
 * (`docs/superpowers/plans/2026-10-29-voz-elevenlabs.md`).
 *
 * Síntese custa por caractere e tem a MESMA forma de risco que o envio em si
 * (ver o cabeçalho de `send-ledger.ts`): um crash entre chamar o ElevenLabs e
 * subir o MP3 não pode fazer o retry pagar a síntese de novo pela mesma
 * mensagem lógica. Este módulo resolve a identidade da linha do ledger
 * reusando `resolverChaveDoLedger` — a MESMA função que `sendWithLedger`
 * ainda vai chamar depois, para o envio propriamente dito — então as duas
 * chamadas convergem para a MESMA linha sem duplicar a lógica de
 * create/find/rotate em dois lugares que pudessem divergir.
 *
 * ⚠️ QUEM CHAMA `resolverCaminhoDeVoz` PRECISA PASSAR O MESMO `body` (o texto
 * FALADO) que depois vira `Intent.body` da chamada a `sendWithLedger` — os
 * dois hashes (aqui e lá) precisam bater, senão `sendWithLedger` veria um
 * `body_hash` diferente do que esta função gravou e trataria como uma
 * tentativa lógica NOVA (rotacionando a linha, que limpa `media_storage_path`
 * — ver o comentário em `rotate()`), re-sintetizando à toa.
 *
 * Este módulo NÃO decide se o agente deve falar, não registra custo em
 * `llm_calls`, e `sintese_de_voz` NÃO está em `lib/ai/pontos/registro.ts` —
 * essa decisão (Fase 6b) ainda não tem um chamador de produção. Ver a seção
 * "Progresso" do plano.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { bodyHash, resolverChaveDoLedger, type Intent, type LedgerStore } from "./send-ledger";
import { sintetizarVoz, type SintetizarVozInput } from "@/lib/ai/voz/sintetizar";
import { custoDeVozCents } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";

export interface ResolverCaminhoDeVozInput {
  store: LedgerStore;
  /** Identidade do ledger — mesma de `sendWithLedger`. */
  identidade: Omit<Intent, "body">;
  /** O texto FALADO (já passou por `textoFalavel`) — é o que o hash do ledger cobre. */
  textoFalado: string;
  voz: Omit<SintetizarVozInput, "texto">;
  /**
   * Quem sabe gravar no Storage e devolver o path — injetado para este módulo
   * não conhecer Supabase Storage nem a convenção de nome de arquivo além do
   * contrato (recebe os bytes, devolve o path onde ficaram).
   */
  upload: (audio: Buffer, mimeType: string) => Promise<string>;
}

export interface ResolverCaminhoDeVozResultado {
  mediaStoragePath: string;
  mimeType: string;
  /** Caracteres de `textoFalado` — a unidade que `custoDeVozCents` cobra. */
  caracteres: number;
  /** false quando a síntese já tinha acontecido numa tentativa anterior (retry). */
  sintetizouAgora: boolean;
}

export async function resolverCaminhoDeVoz(
  input: ResolverCaminhoDeVozInput,
): Promise<ResolverCaminhoDeVozResultado> {
  const intent: Intent = { ...input.identidade, body: input.textoFalado };
  const hash = bodyHash(input.textoFalado);
  const resolucao = await resolverChaveDoLedger(input.store, intent, hash);

  if (resolucao.kind === "already_sent" || resolucao.kind === "blocked") {
    // O chamador (sendTurnMessage) decide o que fazer com isto — aqui só se
    // recusa a pagar uma síntese para um envio que já terminou ou foi vetado.
    throw new VozLedgerTerminalError(
      resolucao.kind,
      resolucao.key,
      resolucao.kind === "already_sent" ? resolucao.crmMessageId : null,
    );
  }

  const pathExistente = resolucao.row?.media_storage_path ?? null;
  if (pathExistente) {
    return {
      mediaStoragePath: pathExistente,
      mimeType: "audio/mpeg",
      caracteres: input.textoFalado.length,
      sintetizouAgora: false,
    };
  }

  const { audio, mimeType, caracteres } = await sintetizarVoz({
    ...input.voz,
    texto: input.textoFalado,
  });
  // Quem fala com o Storage é o `upload` injetado (`uploadDeVoz`, em
  // inbound-turn.ts) — é lá que a chave do objeto é montada e registrada em
  // tests/unit/identificadores-que-cruzam-fronteira.test.ts.
  const { upload: subirAudio } = input;
  const path = await subirAudio(audio, mimeType);
  const pathGravado = await input.store.setMediaPath(input.identidade.tenantId, resolucao.key, path);
  return {
    // `setMediaPath` devolve o que FICOU gravado — se uma corrida (improvável:
    // ver o comentário no store) resolveu antes, é o path DELA que volta, não
    // o nosso, e é o path dela que o envio precisa usar.
    mediaStoragePath: pathGravado,
    mimeType,
    caracteres,
    sintetizouAgora: pathGravado === path,
  };
}

/**
 * A linha do ledger já tem um desfecho TERMINAL (aceita ou vetada) para esta
 * identidade — sintetizar seria pagar por um áudio que não vai a lugar
 * nenhum. O chamador decide: para `already_sent`, não há nada a fazer (a
 * mensagem já saiu); para `blocked`, idem (opt-out).
 */
/**
 * Registra o CUSTO da síntese em `llm_calls` — é o que faz `voz_enabled` ter
 * teto. `fn_update_budget_consumption` dispara em TODO insert em `llm_calls`
 * e soma `cost_cents`; sem esta linha a síntese gastaria fora do orçamento da
 * organização, o defeito de origem que `lib/agent-engine/edge/llm/
 * credentials.ts` documenta para a camada de chat, repetido no eixo novo.
 *
 * Fire-and-forget pelo MESMO motivo de `lib/ai/log-invocation.ts`: o custo
 * JÁ foi pago (a chamada ao ElevenLabs já aconteceu) quando isto é chamado —
 * atrasar o envio esperando o INSERT não evita gasto nenhum, só soma latência
 * à resposta que o cliente está esperando.
 *
 * `input_tokens`/`output_tokens` ficam em ZERO, de propósito — não em
 * `caracteres`. A tela de execuções soma essas duas colunas como "tokens"
 * (`ExecucoesDeIa.tsx`) e `metrics.ts` as agrega no sistema inteiro
 * (`run_input_tokens`); gravar caracteres ali misturaria DUAS unidades na
 * MESMA coluna, em silêncio — exatamente a classe de defeito que este
 * produto evita em todo outro lugar. `cost_cents` é o sinal real; `purpose`
 * já distingue a linha de uma chamada de chat.
 */
export function registrarCustoDeVoz(params: {
  supabase: SupabaseClient;
  organizationId: string;
  /**
   * Achado na revisão de código, antes da Fase 7: faltava — e sem ele a
   * linha nasce com `job_id` NULL. O orçamento da organização (que soma por
   * `organization_id`) continua vendo o gasto, mas o rollup POR EXECUÇÃO
   * (`WHERE organization_id=$1 AND job_id=$2`, usado pela tela de execuções)
   * nunca encontra essa linha — o custo da voz fica invisível execução a
   * execução, mesmo contando certo no total da organização.
   *
   * `null` só para quem não roda dentro de execução nenhuma — a prévia da
   * tela de voz (`app/api/v1/ai/voz/preview/route.ts`). Explícito, não
   * opcional: o chamador do agente continua obrigado a passar o seu.
   */
  jobId: string | null;
  caracteres: number;
  modelId: string;
}): void {
  queueMicrotask(() => {
    void (async () => {
      try {
        const { error } = await params.supabase.from("llm_calls").insert({
          organization_id: params.organizationId,
          job_id: params.jobId,
          purpose: "sintese_de_voz",
          provider: "elevenlabs",
          model: params.modelId,
          input_tokens: 0,
          output_tokens: 0,
          cost_cents: custoDeVozCents(params.caracteres),
        });
        if (error) {
          logger.warn("[send-voice] custo de síntese não gravado em llm_calls", {
            organization_id: params.organizationId,
            error: error.message,
          });
        }
      } catch (err) {
        logger.warn("[send-voice] insert de custo de síntese lançou", {
          organization_id: params.organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}

export class VozLedgerTerminalError extends Error {
  constructor(
    public readonly kind: "already_sent" | "blocked",
    public readonly key: string,
    public readonly crmMessageId: string | null,
  ) {
    super(`síntese de voz recusada: a linha do ledger já está '${kind}'`);
    this.name = "VozLedgerTerminalError";
  }
}
