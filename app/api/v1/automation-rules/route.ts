import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org ativa.
 * POST /api/v1/automation-rules — cria uma regra. is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import { validarIdsDasAcoes, validarIdsDoGatilho } from "@/lib/automation/validar-ids-das-acoes";
import { createAutomationRuleSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "automation_rules_lista", requestId);
  if (teto) return teto;

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Sessão OU token de integração (Spec 33, R1): `config:write` e papel `admin` na linha do token.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "automation_rules",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "automation_rules", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const orgId = authz.organizationId;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Só o ramo do token: as ações e o gatilho carregam ids sem chave estrangeira (funil, etapa, canal,
  // agente, fluxo, pessoa). A sessão só os recebe da tela, que oferece recurso da própria
  // organização; o token vem de fora e usa a service role. Falha fechada (ver o módulo).
  if (authz.via === "token") {
    const dasAcoes = await validarIdsDasAcoes(authz.supabase, orgId, parsed.data.actions);
    const doGatilho = dasAcoes.ok
      ? await validarIdsDoGatilho(authz.supabase, orgId, parsed.data.trigger_config)
      : dasAcoes;
    if (!doGatilho.ok) {
      return fail(
        "invalid_request",
        `${t("A regra aponta para um recurso que não pertence a esta empresa, ou que não foi possível conferir.")} (${doGatilho.campo})`,
        422,
        { requestId },
      );
    }
  }

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const safeActions = await encryptRuleActionSecrets(createAdminClient(), parsed.data.actions);
  if (safeActions === null) {
    return fail(
      "encryption_unavailable",
      t("Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a ação sem segredo."),
      422,
      { requestId },
    );
  }

  const supabase = authz.supabase;
  const webhookSourceId = parsed.data.trigger_config?.webhook_source_id;
  if (typeof webhookSourceId === "string") {
    const { data: source, error: sourceError } = await supabase
      .from("webhook_sources")
      .select("id")
      .eq("id", webhookSourceId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (sourceError) return fail("internal_error", sourceError.message, 500, { requestId });
    if (!source) {
      return fail("invalid_request", t("A fonte escolhida não pertence a esta empresa."), 422, { requestId });
    }
  }
  const campoDeData = await campoDoGatilhoDeDataEhDoContato(
    supabase,
    orgId,
    parsed.data.trigger_event,
    parsed.data.trigger_config,
  );
  if ("erro" in campoDeData) return fail("internal_error", campoDeData.erro, 500, { requestId });
  if (campoDeData.doContato) {
    return fail("invalid_request", t(MENSAGEM_CAMPO_DE_DATA_DO_CONTATO), 422, { requestId });
  }
  const { data: created, error: insErr } = await supabase
    .from("automation_rules")
    .insert({
      organization_id: orgId,
      created_by_user_id: actorUserId,
      name: parsed.data.name,
      trigger_event: parsed.data.trigger_event,
      conditions: parsed.data.conditions,
      actions: safeActions,
      // O gatilho de data do funil (#989) precisa que a regra guarde o funil, o
      // campo e o N assinado — sem isso a varredura não sabe onde olhar. Os
      // outros gatilhos gravam o objeto vazio do default.
      trigger_config: parsed.data.trigger_config ?? {},
    })
    .select("*")
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "automation_rule_insert_failed", 500, { requestId });
  }

  void audit({
    action: "automation.rule_created",
    actorUserId,
    // Só quando há token: a sessão segue com o objeto de sempre.
    ...(authz.apiTokenId ? { actorApiTokenId: authz.apiTokenId } : {}),
    organizationId: orgId,
    resourceType: "automation_rule",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name, trigger_event: parsed.data.trigger_event },
  });

  return ok(created, { requestId, status: 201 });
}
