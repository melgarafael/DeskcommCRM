/**
 * Uma linha em `llm_calls` para chamada de IA que NÃO passa pelo seam do engine
 * e cujo `purpose` não cabe em `InvocationKind`.
 *
 * ═══ POR QUE NÃO `logInvocation` ═══
 *
 * O formato é o mesmo — mesmas colunas, mesma régua de provedor
 * (`providerDoModelo`) e de código de erro (`codigoDoErro`), as duas
 * importadas de lá, nunca copiadas. O que muda é o tipo do `purpose`:
 * `InvocationKind` espelha o CHECK de `ai_invocations.invocation_kind` e é
 * vigiado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`, então
 * acrescentar `voz_ao_vivo` ali reprovaria o invariante por um valor que
 * aquela tabela nunca recebe. `llm_calls.purpose` é texto livre; o vocabulário
 * dele é o registro de pontos (`lib/ai/pontos/registro.ts`), cobrado por
 * `tests/unit/pontos-de-ia-completude.test.ts`.
 *
 * ═══ POR QUE EXISTE ═══
 *
 * A sessão de voz (`workers/voice-agent/`) chamava provedor pago sem deixar
 * linha nenhuma: a tela de Uso de IA somava zero para ela — gasto que existe e
 * não aparece. A mídia (transcrição e visão) grava pelo próprio caminho, em
 * `workers/media-derive-worker.ts`, porque passa também pelo teto
 * (`aplicarOrcamento`); a voz ainda não tem tarifa no catálogo para entrar nele.
 *
 * Awaitable, mas NUNCA LANÇA: telemetria que falha não pode derrubar uma
 * ligação em curso. A falha vai para o log.
 */
import { codigoDoErro, providerDoModelo } from "@/lib/ai/log-invocation";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface ChamadaDeIa {
  organization_id: string;
  agent_id?: string | null;
  contact_id?: string | null;
  /** Id do ponto em `lib/ai/pontos/registro.ts` (ex.: `visao_de_imagem`). */
  purpose: string;
  /** Quando quem chama SABE o provedor. Sem ele, vale `providerDoModelo(model)`. */
  provider?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /**
   * Centavos de dólar, fracionados. `null` = preço desconhecido (a régua do
   * teto soma como zero e a tela acusa "medição incompleta"). Quem chama
   * decide e documenta — ver os dois emissores.
   */
  cost_cents: number | null;
  latency_ms: number;
  /** Presente = a chamada falhou. `status` HTTP opcional, lido por `codigoDoErro`. */
  erro?: { message: string; status?: number } | null;
}

export async function registrarChamadaDeIa(admin: Admin, chamada: ChamadaDeIa): Promise<void> {
  try {
    const erro = chamada.erro ?? null;
    const { error } = await admin.from("llm_calls").insert({
      organization_id: chamada.organization_id,
      // Mesma rede de `logInvocation` (issue #160): `""` numa coluna uuid faz o
      // insert falhar em silêncio.
      agent_id: chamada.agent_id && chamada.agent_id.trim() !== "" ? chamada.agent_id : null,
      contact_id:
        chamada.contact_id && chamada.contact_id.trim() !== "" ? chamada.contact_id : null,
      purpose: chamada.purpose,
      provider: chamada.provider ?? providerDoModelo(chamada.model),
      model: chamada.model,
      input_tokens: Math.max(0, Math.round(chamada.input_tokens)),
      output_tokens: Math.max(0, Math.round(chamada.output_tokens)),
      cost_cents: chamada.cost_cents,
      latency_ms: Math.max(0, Math.round(chamada.latency_ms)),
      status: erro ? "erro" : "ok",
      error_code: erro ? codigoDoErro({ ...erro }) : null,
      error_message: erro ? erro.message.slice(0, 500) : null,
    });
    if (error) {
      logger.warn("[llm-calls] insert failed", {
        error: error.message,
        organization_id: chamada.organization_id,
        purpose: chamada.purpose,
      });
    }
  } catch (err) {
    logger.warn("[llm-calls] insert threw", {
      error: err instanceof Error ? err.message : String(err),
      organization_id: chamada.organization_id,
      purpose: chamada.purpose,
    });
  }
}
