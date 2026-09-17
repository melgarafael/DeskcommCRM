import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/message-templates — lista os templates visíveis (pessoais + compartilhados
 *      da org ativa; a RLS `message_templates_select` já filtra).
 * POST /api/v1/message-templates — cria um template. `shared=true` grava owner_user_id
 *      null (compartilhado) e exige role manager+; `shared=false` (default) grava
 *      owner_user_id = user.id (pessoal, role agent+ já garantido pelo requireRole).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { createTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, created_by_user_id, created_at, updated_at";
/** Tag do endpoint no recibo de idempotência. Muda de rota muda de recibo. */
const ENDPOINT = "/api/v1/message-templates";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  // RLS já limita a compartilhados + próprios da org ativa.
  const { data, error } = await supabase
    .from("message_templates")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("updated_at", { ascending: false });
  if (error) return fail("internal_error", "Erro ao listar templates.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const raw = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { title, body, shortcut, shared } = parsed.data;
  // Compartilhado exige manager+. requireRole já resolveu o role efetivo do
  // banco em org.role — reusar em vez de uma 2ª chamada/RPC. A RLS with_check
  // barra de qualquer forma; isto só dá um erro claro antes do insert.
  if (shared && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", t("Só manager+ cria template compartilhado."), 403, { requestId });
  }
  // Idempotency-Key, quando vem, tem de ser UUID — mesma régua de
  // `admin/tenants` e do contrato (spec 01 §7.3). Chave malformada não vira
  // recibo: recusar cedo é mais honesto que gravar lixo e devolver 201.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const supabase = await createClient();

  /**
   * O efeito. Lança em falha de propósito: assim o helper propaga sem gravar
   * recibo. Recibo de operação que falhou seria pior que não ter idempotência
   * — o cliente retentaria e receberia o replay de uma criação inexistente.
   */
  async function criar() {
    const { data, error } = await supabase
      .from("message_templates")
      .insert({
        organization_id: org.orgId,
        owner_user_id: shared ? null : user.id,
        title,
        body,
        shortcut: shortcut ?? null,
        created_by_user_id: user.id,
      })
      .select(COLS)
      .single();
    if (error || !data) throw new Error("Erro ao criar template.");

    void audit({
      action: "template.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message_template",
      resourceId: data.id,
      requestId,
      metadata: { shared, title },
    });
    return data;
  }

  // Sem a chave, o caminho é o de sempre: uma chave só existe quando quem
  // chama quer retentativa segura.
  if (chave === null) {
    try {
      return ok(await criar(), { requestId, status: 201 });
    } catch {
      return fail("internal_error", "Erro ao criar template.", 500, { requestId });
    }
  }

  try {
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: org.orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: parsed.data,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });

    if (desfecho.tipo === "conflito")
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );

    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", "Erro ao criar template.", 500, { requestId });
  }
}
