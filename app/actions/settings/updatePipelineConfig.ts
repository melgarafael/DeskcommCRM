"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import {
  pipelineConfigPatchSchema,
  type PipelineConfigPatch,
} from "@/lib/schemas/settings";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import {
  mensagemDasRegrasQuePerdemOCampo,
  regrasDeDataQuePerdemOCampo,
} from "@/lib/automation/campo-do-gatilho-de-data";

export type UpdatePipelineConfigResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

export async function updatePipelineConfig(
  pipelineId: string,
  patch: PipelineConfigPatch,
): Promise<UpdatePipelineConfigResult> {
  if (!pipelineId || typeof pipelineId !== "string") {
    return { ok: false, error: "invalid_request" };
  }
  const parsed = pipelineConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  const { data: row, error: readErr } = await supabase
    .from("crm_pipelines")
    .select("vocabulary, settings, organization_id")
    .eq("id", pipelineId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "not_found" };
  if (row.organization_id !== activeOrg.orgId) {
    return { ok: false, error: "forbidden_tenant" };
  }

  const nextVocabulary = parsed.data.vocabulary
    ? { ...((row.vocabulary as Record<string, unknown> | null) ?? {}), ...parsed.data.vocabulary }
    : ((row.vocabulary as Record<string, unknown> | null) ?? {});

  const currentSettings = (row.settings as Record<string, unknown> | null) ?? {};
  const nextSettings: Record<string, unknown> = { ...currentSettings };
  if (parsed.data.fields !== undefined) nextSettings.fields = parsed.data.fields;
  if (parsed.data.lost_reasons !== undefined) nextSettings.lost_reasons = parsed.data.lost_reasons;
  if (parsed.data.won_reasons !== undefined) nextSettings.won_reasons = parsed.data.won_reasons;
  if (parsed.data.won_reason_required !== undefined) {
    nextSettings.won_reason_required = parsed.data.won_reason_required;
  }
  if (parsed.data.comanda_no_ganho !== undefined) {
    nextSettings.comanda_no_ganho = parsed.data.comanda_no_ganho;
  }
  if (parsed.data.reabertura !== undefined) nextSettings.reabertura = parsed.data.reabertura;
  if (parsed.data.reabertura_campos !== undefined) {
    nextSettings.reabertura_campos = parsed.data.reabertura_campos;
  }
  // A entrada do Inbox (issue #3011): a ETAPA em que a conversa nova vira card
  // neste funil. Grava o bloco inteiro, e não campo a campo, porque `ativa` e
  // `stage_id` são uma decisão só — desligar sem perder a etapa escolhida é o
  // que a tela precisa poder fazer.
  if (parsed.data.entrada_do_inbox !== undefined) {
    nextSettings.entrada_do_inbox = parsed.data.entrada_do_inbox;
  }
  // #2995 — o recorte de encerrados antigos do quadro. `0` é um valor com
  // significado ("desliguei") e por isso a chave é gravada como veio: pular o
  // zero deixaria o número antigo no banco e o quadro seguiria escondendo card
  // de quem acabou de desligar a opção.
  if (parsed.data.ocultar_encerrados_dias !== undefined) {
    nextSettings.ocultar_encerrados_dias = parsed.data.ocultar_encerrados_dias;
  }
  // OS ATALHOS DO CARD (#3487). A chave é gravada como veio, inclusive a lista
  // VAZIA: `[]` é o "apaguei todos" que a tela precisa poder dizer, e pular o
  // vazio deixaria os atalhos antigos no banco — a pessoa removeria o botão,
  // salvaria, e ele continuaria no card. Quem já barrou o `javascript:` foi o
  // schema, acima; aqui não há segunda régua a divergir.
  if (parsed.data.atalhos !== undefined) {
    nextSettings.atalhos = parsed.data.atalhos;
  }

  // Campo que passa a ser do Contato e que uma regra ativa do gatilho por data
  // lê (#2791): a regra seguiria ligada e pararia de disparar em silêncio.
  if (parsed.data.fields !== undefined) {
    const perdem = await regrasDeDataQuePerdemOCampo(
      supabase,
      activeOrg.orgId,
      pipelineId,
      currentSettings,
      nextSettings,
    );
    if ("erro" in perdem) return { ok: false, error: perdem.erro };
    if (perdem.nomes.length > 0) {
      return { ok: false, error: mensagemDasRegrasQuePerdemOCampo(perdem.nomes, authUser.idioma) };
    }
  }

  const { error } = await supabase
    .from("crm_pipelines")
    .update({ vocabulary: nextVocabulary, settings: nextSettings })
    .eq("id", pipelineId);
  if (error) return { ok: false, error: error.message };

  await audit({
    action: "pipeline.config_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: {
      vocabulary_changed: !!parsed.data.vocabulary,
      fields_count: parsed.data.fields?.length ?? null,
      lost_reasons_count: parsed.data.lost_reasons?.length ?? null,
      won_reasons_count: parsed.data.won_reasons?.length ?? null,
      won_reason_required: parsed.data.won_reason_required ?? null,
      reabertura: parsed.data.reabertura ?? null,
      entrada_do_inbox_ativa: parsed.data.entrada_do_inbox?.ativa ?? null,
      // #2995: quantos cards o quadro deixa de mostrar é decisão de quem opera
      // — a auditoria registra o número (ou `0`, o desligamento).
      ocultar_encerrados_dias: parsed.data.ocultar_encerrados_dias ?? null,
      // #3487: quantos atalhos o funil passa a oferecer. O CONTEÚDO não entra
      // na auditoria de propósito — o link montado carrega dado do cliente, e a
      // auditoria é lida por quem administra, não necessariamente por quem vê o
      // contato.
      atalhos_count: parsed.data.atalhos?.length ?? null,
    },
  });

  revalidatePath("/app/settings/tenant/pipelines");
  return { ok: true };
}
