import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/automation-rules/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/automation-rules/[id] — remove a regra.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import {
  CAMPO_DO_MOTIVO_DA_PERDA,
  acoesDePerdaSemMotivo,
  lerEtapasDasAcoes,
  mensagemDaEtapaDePerdaSemMotivo,
} from "@/lib/automation/motivo-da-perda-na-acao";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { updateAutomationRuleSchema } from "@/lib/schemas";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD } from "@/lib/schemas/webhooks";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id, trigger_event, trigger_config, actions")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

  const webhookSourceId = parsed.data.trigger_config?.webhook_source_id;
  if (typeof webhookSourceId === "string") {
    const { data: source, error: sourceError } = await supabase
      .from("webhook_sources")
      .select("id")
      .eq("id", webhookSourceId)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (sourceError) return fail("internal_error", sourceError.message, 500, { requestId });
    if (!source) {
      return fail("invalid_request", t("A fonte escolhida não pertence a esta empresa."), 422, { requestId });
    }
  }

  // O PATCH parcial (só o gatilho, ou só as ações) monta o laço de #1528 pela
  // porta do lado: o schema só o vê quando os dois vêm juntos. Desligar a regra
  // (só `is_active`) nunca é barrado.
  const gravada = existing as { trigger_event: string; actions: { type: string }[] | null };
  if (
    (parsed.data.trigger_event !== undefined || parsed.data.actions !== undefined) &&
    acoesQueFechamLaco(
      parsed.data.trigger_event ?? gravada.trigger_event,
      parsed.data.actions ?? gravada.actions ?? [],
    ).length
  ) {
    return fail("invalid_request", t(MENSAGEM_DO_LACO_DE_LEAD), 400, { requestId });
  }

  // ── A ETAPA DE PERDA EXIGE MOTIVO — RECUSADA NO CADASTRO (#4297) ───────────
  //
  // Mesma régua do POST, e só quando o PATCH TRAZ ações: regra antiga que
  // aponta para a etapa de perda sem motivo continua sendo salva quando o que
  // muda é o nome ou o interruptor — ela é que falha em execução, com o código
  // real no recibo (`lost_reason_required`). Regravar as ações é o momento de
  // exigir o campo.
  //
  // Depois do laço do #1528 de propósito: aquele veto é estrutural e não custa
  // banco, este custa uma leitura de `crm_stages` — e o que fecha a regra antes
  // já respondeu.
  if (parsed.data.actions !== undefined) {
    const etapasDaRegra = await lerEtapasDasAcoes(supabase, activeOrg.orgId, parsed.data.actions);
    if ("erro" in etapasDaRegra) return fail("internal_error", etapasDaRegra.erro, 500, { requestId });
    const semMotivo = acoesDePerdaSemMotivo(parsed.data.actions, etapasDaRegra.etapas);
    if (semMotivo.length > 0) {
      return fail(
        "invalid_request",
        t(mensagemDaEtapaDePerdaSemMotivo(semMotivo.map((achado) => achado.etapa), authz.user.idioma)),
        422,
        { requestId, details: { campo: CAMPO_DO_MOTIVO_DA_PERDA } },
      );
    }
  }

  // Gatilho por data num campo do contato (#2791) nunca dispara: a regra que
  // chega assim — pela API, ou antiga sendo regravada ou religada — é recusada.
  // Desligar e renomear não passam por aqui.
  if (
    parsed.data.trigger_event !== undefined ||
    parsed.data.trigger_config !== undefined ||
    parsed.data.is_active === true
  ) {
    const campoDeData = await campoDoGatilhoDeDataEhDoContato(
      supabase,
      activeOrg.orgId,
      parsed.data.trigger_event ?? gravada.trigger_event,
      parsed.data.trigger_config ?? (existing as { trigger_config: unknown }).trigger_config,
    );
    if ("erro" in campoDeData) return fail("internal_error", campoDeData.erro, 500, { requestId });
    if (campoDeData.doContato) {
      return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
    }
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041);
  // secret_enc existente (round-trip do editor) passa intacto.
  // A autoria vai junto de TODA escrita, pelo mesmo helper que o agente usa: uma
  // regra ligada é o estado mais perigoso do sistema, e a tela precisa dizer
  // quem a ligou (migration 0101).
  const patch: Record<string, unknown> = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca({ type: "user", id: user.id, role: activeOrg.role }),
  };
  if (parsed.data.actions !== undefined) {
    const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
    if (safeActions === null) {
      return fail(
        "encryption_unavailable",
        t("Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave."),
        422,
        { requestId },
      );
    }
    patch.actions = safeActions;
  }

  const { data: updated, error: updErr } = await supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  const { actions: _actionsWithSecrets, ...auditableRule } = parsed.data;
  void audit({
    action: "automation.rule_updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
    // actions fora do audit: config de call_webhook carrega secret plaintext no input.
    metadata: { ...auditableRule, ...(parsed.data.actions !== undefined ? { actions_changed: true } : {}) },
  });

  return ok(updated, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "automation_rules_item", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const activeOrg = { orgId: authz.organizationId };

  const supabase = authz.supabase;
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

  // A organização entra também no delete: no ramo do token o cliente é o admin
  // (sem RLS), e o id da URL não basta para dizer que a regra é desta organização.
  const { error: delErr } = await supabase
    .from("automation_rules")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "automation.rule_deleted",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}