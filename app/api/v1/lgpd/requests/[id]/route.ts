/**
 * GET /api/v1/lgpd/requests/[id]
 *
 * Detail of a single lgpd_request + audit trail entries for that request.
 * If completed or pending_review and result.pdf_path exists, generates a 72h
 * signed URL — pending_review is the export the worker could not deliver (no
 * e-mail configured, or no titular address), and the operator delivers it by hand.
 *
 * ── O pacote é DOIS arquivos, e o caminho manual entregava um (issue #2341) ──
 *
 * Quando não há transporte de e-mail nem endereço do titular, quem entrega é uma
 * pessoa — e esta rota é a única fonte dela. Ela assinava só o `report.pdf`: o
 * `data.json`, que o worker sobe ao lado e que o e-mail leva por ligação,
 * ficava no Storage sem chegar a ninguém, ainda que o pedido guardasse o
 * `json_path` no `result`. O titular recebia o relatório e não recebia a cópia —
 * o mesmo defeito que a issue descreve, agora no caminho sem e-mail. Por isso as
 * duas assinaturas saem juntas, com o MESMO prazo: o arquivo não pode vencer
 * antes do relatório a que acompanha.
 *
 * Auth: cookie session, role >= admin.
 * organization_id resolved from session — never from body or path.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: "leitura",
    permiteOrgSuspensa: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const { id } = await params;
  const orgId = activeOrg.orgId;
  const admin = createAdminClient();

  // Fetch the lgpd_request (programmatic org filter — admin client bypasses RLS)
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message, result, request_payload, created_at, updated_at",
    )
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    logger.warn("[lgpd-request-detail] request unavailable", {
      code: "request_read_failed", requestId,
    });
    return fail("internal_error", t("Erro interno. Tente de novo em instantes."), 500, { requestId });
  }
  if (!request) {
    return fail("not_found", t("Solicitação não encontrada."), 404, { requestId });
  }

  // Quem recebe e para onde vai: o admin aprova o envio VENDO o nome do
  // titular e o e-mail de destino (doc 134). O destino é o mesmo que o worker
  // usa — o endereço que veio no pedido, senão o e-mail do contato.
  let contato: { display_name: string | null; email: string | null } | null = null;
  if (request.contact_id) {
    const { data: c } = await admin
      .from("contacts")
      .select("display_name, email")
      .eq("organization_id", orgId)
      .eq("id", request.contact_id)
      .maybeSingle();
    contato = c ?? null;
  }
  const pedido = (request.request_payload ?? {}) as {
    customer?: { name?: unknown } | null;
    delivery?: { address?: unknown } | null;
  };
  const textoOuNulo = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const titular = {
    nome: textoOuNulo(contato?.display_name) ?? textoOuNulo(pedido.customer?.name),
    email_destino: textoOuNulo(pedido.delivery?.address) ?? textoOuNulo(contato?.email),
  };

  // Fetch audit trail entries for this request
  const { data: auditRows, error: auditErr } = await admin
    .from("api_audit_log")
    .select("id, action, actor_user_id, resource_type, resource_id, metadata, created_at")
    .eq("organization_id", orgId)
    .or(
      `resource_id.eq.${id},metadata->>request_id.eq.${id}`,
    )
    .order("created_at", { ascending: true })
    .limit(50);

  if (auditErr) {
    // Non-fatal — return empty trail
    logger.warn("[lgpd-request-detail] audit trail unavailable", {
      code: "audit_read_failed", requestId,
    });
  }

  const audit_trail = auditRows ?? [];

  // Signed URLs when the export exists: delivered (completed) or waiting for the
  // operator to deliver it by hand (pending_review). O pacote é DOIS arquivos —
  // ver o cabeçalho: o manual entregava só o PDF.
  let signed_pdf_url: string | null = null;
  let signed_json_url: string | null = null;

  if ((request.status === "completed" || request.status === "pending_review") && request.result) {
    const result = request.result as Record<string, unknown>;
    const pdfPath = typeof result.pdf_path === "string" ? result.pdf_path : null;
    // `json_path` é gravado pelo worker desde o doc 103; resultado anterior a
    // ele (arquivo que nunca subiu) não ganha ligação nenhuma — e não derruba a
    // do PDF.
    const jsonPath = typeof result.json_path === "string" ? result.json_path : null;

    const assinar = async (caminho: string, rotulo: "pdf" | "json"): Promise<string | null> => {
      // A service role ignora a policy do bucket: assina apenas a estrutura
      // literal emitida pelo worker para ESTA organização e ESTE pedido.
      const nome = rotulo === "pdf" ? "report.pdf" : "data.json";
      if (caminho !== `${orgId}/${request.id}/${nome}`) {
        logger.warn("[lgpd-request-detail] artifact unavailable", {
          code: "artifact_path_mismatch", artifact: rotulo, requestId,
        });
        return null;
      }
      try {
        const { data: signedData, error: signErr } = await admin.storage
          .from("lgpd-exports")
          // O atributo HTML download sozinho não cobre Storage cross-origin.
          .createSignedUrl(caminho, 72 * 60 * 60, { download: nome });
        if (!signErr && signedData?.signedUrl) return signedData.signedUrl;
      } catch {
        // Uma exceção neste arquivo não impede a assinatura do outro.
      }
      logger.warn("[lgpd-request-detail] artifact unavailable", {
        code: "artifact_sign_failed", artifact: rotulo, requestId,
      });
      return null;
    };

    if (pdfPath) signed_pdf_url = await assinar(pdfPath, "pdf");
    if (jsonPath) signed_json_url = await assinar(jsonPath, "json");
  }

  return ok(
    { request, audit_trail, signed_pdf_url, signed_json_url, titular },
    { requestId },
  );
}
