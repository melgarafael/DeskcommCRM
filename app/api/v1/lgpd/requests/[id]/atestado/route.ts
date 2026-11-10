/**
 * GET /api/v1/lgpd/requests/[id]/atestado — o atestado do pedido, para o titular.
 *
 * ─── Por que uma rota, e não um link no e-mail ──────────────────────────────
 *
 * O atestado tem de chegar a QUEM PEDIU, e quem decide o canal é quem atende: o
 * pedido entrou por WhatsApp, por e-mail, por telefone. Esta rota entrega o
 * arquivo (URL assinada de vida curta, no bucket que só a instalação alcança) a
 * quem opera, e é o operador que o repassa pelo canal do pedido — o mesmo
 * princípio do aviso do art. 12.º, que sai pelo canal em que o titular falou.
 *
 * A URL é curta de propósito (15 min): quem baixa é a pessoa certa, agora. O
 * documento em si não expira — ele está no Storage e na trilha, e é isto que o
 * torna prova.
 *
 * ─── Quando o pedido não tem atestado ──────────────────────────────────────
 *
 * 404 com `atestado_ausente`: pedido que não foi executado, organização cuja
 * execução ainda não rodou, organização no BRASIL — onde o worker não emite
 * atestado nenhum por decisão de produto de 2026-10-16 (CR do PR #3321, item 3;
 * a guarda do país é `avisaTitular`, em `workers/lgpd-redact-worker.ts`) —, ou
 * emissão que falhou (e então o motivo está em `result.atestado.erro` — a
 * resposta o traz, em vez de dizer só "não existe").
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { BUCKET_DO_ATESTADO } from "@/lib/lgpd/emitir-atestado";
import { createAdminClient } from "@/lib/supabase/admin";

/** Vida da URL assinada: o tempo de um download, não o de um arquivo. */
const EXPIRA_EM_SEGUNDOS = 900;

interface AtestadoGravado {
  path?: unknown;
  codigo?: unknown;
  codigo_curto?: unknown;
  algoritmo?: unknown;
  sha256?: unknown;
  emitido_em?: unknown;
  erro?: unknown;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const requestId = randomUUID();

  // `permiteOrgSuspensa`: LGPD nunca é bloqueada por org suspensa (spec §1.3 —
  // o titular pede o dado dele, e a suspensão é do contrato, não do direito).
  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    permiteOrgSuspensa: true,
  });
  if (!authz.ok) return authz.response;
  const orgId = authz.org?.orgId;
  if (!orgId) return fail("no_active_org", "Nenhuma organização ativa.", 403, { requestId });

  const admin = createAdminClient();
  const { data: pedido, error } = await admin
    .from("lgpd_requests")
    .select("id, status, result")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!pedido) return fail("not_found", "Solicitação não encontrada.", 404, { requestId });

  const resultado =
    typeof pedido.result === "object" && pedido.result !== null
      ? (pedido.result as { atestado?: AtestadoGravado })
      : {};
  const atestado = resultado.atestado;

  if (!atestado || typeof atestado.path !== "string") {
    return fail(
      "atestado_ausente",
      atestado && typeof atestado.erro === "string"
        ? `O atestado não foi emitido: ${atestado.erro}`
        : "Esta solicitação ainda não tem atestado emitido.",
      404,
      { requestId, details: { status: pedido.status } },
    );
  }

  const { data: assinada, error: errAssinatura } = await admin.storage
    .from(BUCKET_DO_ATESTADO)
    .createSignedUrl(atestado.path, EXPIRA_EM_SEGUNDOS);

  if (errAssinatura || !assinada?.signedUrl) {
    return fail("internal_error", errAssinatura?.message ?? "não foi possível assinar a URL", 500, {
      requestId,
    });
  }

  return ok(
    {
      request_id: id,
      url: assinada.signedUrl,
      expira_em_segundos: EXPIRA_EM_SEGUNDOS,
      codigo: typeof atestado.codigo_curto === "string" ? atestado.codigo_curto : null,
      algoritmo: typeof atestado.algoritmo === "string" ? atestado.algoritmo : null,
      sha256: typeof atestado.sha256 === "string" ? atestado.sha256 : null,
      emitido_em: typeof atestado.emitido_em === "string" ? atestado.emitido_em : null,
    },
    { requestId },
  );
}
