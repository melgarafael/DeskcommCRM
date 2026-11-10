import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/voz/preview — sintetiza uma frase curta com a voz escolhida
 * e devolve o áudio inline (base64), para a tela tocar antes de salvar.
 *
 * Fase 7 do plano de voz. Não persiste o áudio (nem Storage), mas a síntese
 * é paga ao ElevenLabs do mesmo jeito que a do agente — então passa pelo MESMO
 * teto (`aplicarOrcamento`, como `resolverVozDoTurno`) antes de sair, e grava o
 * MESMO custo (`registrarCustoDeVoz`, como `sendTurnMessage`) depois. Uma
 * prévia fora do orçamento seria gasto de IA da organização que a tela de Uso
 * de IA não mostra e o teto não para.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { loadEnv } from "@/lib/agent-engine/env";
import { LlmNotConfiguredError, resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import {
  aplicarOrcamento,
  LlmBudgetExceededError,
  llmEdgeConfigFromEnv,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { registrarCustoDeVoz } from "@/lib/agent-engine/edge/crm/send-voice";
import { chaveDeOrcamentoDaInstalacao } from "@/lib/instalacao/comportamento";
import { sintetizarVoz } from "@/lib/ai/voz/sintetizar";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const FRASE_PADRAO =
  "Olá! Esta é uma prévia de como o seu agente vai soar ao responder em áudio.";
const MODELO_PADRAO = "eleven_multilingual_v2";

// O orçamento limita o GASTO do mês; o rate limit limita o RITMO. Generoso o
// bastante para "ouvir três ou quatro vozes decidindo", curto o bastante para
// não virar torneira: a mesma ordem de grandeza do rate limit de troca de logo
// (`app/api/v1/marca/logo/route.ts`).
const TETO_POR_ORGANIZACAO = 10;
const JANELA_SEGUNDOS = 60;

const corpo = z.object({
  voice_id: z.string().trim().min(1).max(200),
  model_id: z.string().trim().min(1).max(200).optional(),
  texto: z.string().trim().min(1).max(280).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { requestId, details: parsed.error.issues });
  }

  const limite = await checkRateLimit(`voz-preview:${org.orgId}`, TETO_POR_ORGANIZACAO, JANELA_SEGUNDOS);
  if (!limite.allowed) {
    return fail(
      "rate_limited",
      t("Muitas prévias em sequência. Espere um minuto e tente de novo."),
      429,
      { requestId, headers: { "Retry-After": String(JANELA_SEGUNDOS) } },
    );
  }

  const modelId = parsed.data.model_id ?? MODELO_PADRAO;

  // A MESMA resolução e o MESMO teto da voz do agente (`resolverVozDoTurno`):
  // credencial ativa e validada da organização da SESSÃO, e o gate do seam.
  let apiKey: string;
  try {
    const cfg = llmEdgeConfigFromEnv(loadEnv());
    const pool = getRequestPool();
    const elevenlabs = await resolveOrgLlmConfig(pool, cfg, org.orgId, { provider: "elevenlabs" });
    await aplicarOrcamento({
      db: pool,
      organizationId: org.orgId,
      orcamentoDaConfig: elevenlabs.orcamento,
      orcamentoIndisponivelPorque: elevenlabs.orcamentoIndisponivelPorque,
      chave: chaveDeOrcamentoDaInstalacao(cfg.budgetEnforcement ?? "on"),
      origemDaChave: elevenlabs.origemDaChave,
      purpose: "sintese_de_voz",
      provider: "elevenlabs",
      model: modelId,
      origem: "fixo_do_produto",
      input: { tenantId: org.orgId, leadId: null, jobId: null, agentId: null },
    });
    apiKey = elevenlabs.apiKey;
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return fail(
        "credential_required",
        t("Cadastre e valide uma chave do ElevenLabs em Agente de IA → Credenciais antes de ouvir a prévia."),
        422,
        { requestId },
      );
    }
    if (err instanceof LlmBudgetExceededError) {
      return fail(
        "budget_exceeded",
        t("O orçamento de IA deste mês acabou, então a prévia não foi gerada. Ajuste o limite em Uso de IA › Orçamento."),
        402,
        { requestId },
      );
    }
    return fail("internal_error", t("Falha ao ler a credencial do ElevenLabs."), 500, { requestId });
  }

  try {
    const { audio, mimeType, caracteres } = await sintetizarVoz({
      apiKey,
      voiceId: parsed.data.voice_id,
      modelId,
      texto: parsed.data.texto ?? FRASE_PADRAO,
    });
    registrarCustoDeVoz({
      supabase: createAdminClient(),
      organizationId: org.orgId,
      jobId: null,
      caracteres,
      modelId,
    });
    return ok(
      { audioBase64: audio.toString("base64"), mimeType },
      { requestId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `synthesis_401` = chave/voz inválida; qualquer outro = provedor fora —
    // nos dois casos a tela mostra "não consegui gerar a prévia", nunca um
    // áudio quebrado.
    return fail("synthesis_failed", t("Não consegui gerar a prévia agora. Tente de novo."), 502, {
      requestId,
      details: { error: msg.slice(0, 200) },
    });
  }
}
