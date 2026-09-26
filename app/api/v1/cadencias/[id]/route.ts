/**
 * GET    /api/v1/cadencias/:id — a cadência, com passos e configuração.
 * PATCH  /api/v1/cadencias/:id — edita nome/configuração/passos, OU muda o
 *        status (rascunho → ativa → pausada → ativa...). As duas coisas nunca
 *        vêm juntas: mudar passos enquanto ativa faria o worker (quando
 *        existir) ler uma árvore diferente da que a inscrição em andamento
 *        viu — por isso conteúdo só edita fora de `ativa` (a tela já avisa:
 *        "pause primeiro").
 * DELETE /api/v1/cadencias/:id — só fora de `ativa`, mesmo motivo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validarPassos } from "@/lib/cadencias/arvore";
import { editarCadenciaSchema, mudarStatusDaCadenciaSchema } from "@/lib/cadencias/schemas";
import type { Passo } from "@/lib/cadencias/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, status, configuracao, passos, versao, created_at, updated_at, created_by, updated_by";

async function carregar(supabase: ReturnType<typeof createAdminClient>, orgId: string, id: string) {
  const { data } = await supabase
    .from("email_cadences")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; status: "rascunho" | "ativa" | "pausada"; versao: number } | null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("email_cadences")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return fail("cadencia_nao_encontrada", t("Cadência não encontrada."), 404, { requestId });

  return ok(data, { requestId });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await ctx.params;

  const corpo = await req.json().catch(() => null);
  const ehStatus = corpo && typeof corpo === "object" && "status" in corpo;

  const supabase = createAdminClient();
  const atual = await carregar(supabase, org.orgId, id);
  if (!atual) return fail("cadencia_nao_encontrada", t("Cadência não encontrada."), 404, { requestId });

  if (ehStatus) {
    const parsed = mudarStatusDaCadenciaSchema.safeParse(corpo);
    if (!parsed.success) {
      return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: parsed.error.flatten() });
    }
    const novoStatus = parsed.data.status;

    const transicoesValidas: Record<string, string[]> = {
      rascunho: ["ativa"],
      ativa: ["pausada"],
      pausada: ["ativa", "rascunho"],
    };
    if (!transicoesValidas[atual.status]?.includes(novoStatus)) {
      return fail(
        "cadencia_estado_invalido",
        t("Não é possível mudar de {{de}} para {{para}}.")
          .replace("{{de}}", atual.status)
          .replace("{{para}}", novoStatus),
        409,
        { requestId },
      );
    }

    if (novoStatus === "ativa") {
      const { data: comPassos } = await supabase
        .from("email_cadences")
        .select("passos")
        .eq("id", id)
        .single();
      const passos = ((comPassos as { passos: Passo[] } | null)?.passos ?? []) as Passo[];
      if (passos.length === 0) {
        return fail("cadencia_sem_passos", t("A cadência precisa de pelo menos um e-mail."), 422, { requestId });
      }
      if (validarPassos(passos).size > 0) {
        return fail("cadencia_sem_passos", t("Há passos com problema — eles estão marcados em vermelho."), 422, {
          requestId,
        });
      }
    }

    const { data, error } = await supabase
      .from("email_cadences")
      .update({ status: novoStatus, updated_by: user.id })
      .eq("organization_id", org.orgId)
      .eq("id", id)
      .eq("status", atual.status)
      .select(COLUNAS)
      .maybeSingle();
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (!data) {
      return fail("cadencia_estado_invalido", t("O estado da cadência mudou. Recarregue a tela."), 409, { requestId });
    }

    if (novoStatus === "ativa" || novoStatus === "pausada") {
      void audit({
        action: novoStatus === "ativa" ? "cadencia.activated" : "cadencia.paused",
        actorUserId: user.id,
        organizationId: org.orgId,
        resourceType: "email_cadence",
        resourceId: id,
        requestId,
      });
    }

    return ok(data, { requestId });
  }

  // ═══ Edição de conteúdo (nome/configuração/passos) ═══
  if (atual.status === "ativa") {
    return fail(
      "cadencia_nao_editavel",
      t("A cadência está no ar. Para editar os passos ou as configurações, pause primeiro."),
      409,
      { requestId },
    );
  }

  const parsed = editarCadenciaSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  const mudanca: Record<string, unknown> = { updated_by: user.id };
  if (entrada.name !== undefined) mudanca.name = entrada.name;
  if (entrada.configuracao !== undefined) mudanca.configuracao = entrada.configuracao;
  if (entrada.passos !== undefined) {
    mudanca.passos = entrada.passos;
    // Sobe a versão: a inscrição guarda o passo por id e o worker (quando
    // existir) confere que o id ainda existe na versão atual — comentário da
    // migration 0428.
    mudanca.versao = atual.versao + 1;
  }

  const { data, error } = await supabase
    .from("email_cadences")
    .update(mudanca)
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .select(COLUNAS)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("cadencia_nao_encontrada", t("Cadência não encontrada."), 404, { requestId });

  // Editar rascunho/pausada NÃO audita — nada saiu dela, mesmo critério de
  // `campaign.*` (edição de rascunho não audita).
  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const atual = await carregar(supabase, org.orgId, id);
  if (!atual) return fail("cadencia_nao_encontrada", t("Cadência não encontrada."), 404, { requestId });
  if (atual.status === "ativa") {
    return fail("cadencia_nao_editavel", t("A cadência está no ar. Pause antes de excluir."), 409, { requestId });
  }

  const { error } = await supabase
    .from("email_cadences")
    .delete()
    .eq("organization_id", org.orgId)
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "cadencia.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "email_cadence",
    resourceId: id,
    requestId,
  });

  return ok({ id, deleted: true }, { requestId });
}
