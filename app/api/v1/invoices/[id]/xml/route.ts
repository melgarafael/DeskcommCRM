/**
 * GET /api/v1/invoices/[id]/xml — baixa o XML autorizado.
 *
 * Só com XML armazenado (nota autorizada pelo sidecar). O XML é a fonte
 * fiscal principal — nunca o PDF.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data } = await supabase
    .from("invoices")
    .select("numero, serie, chave_acesso, xml")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const nota = data as unknown as { numero: number | null; serie: string; chave_acesso: string | null; xml: string | null } | null;
  if (!nota) return fail("not_found", "Nota não encontrada.", 404, { requestId });
  if (!nota.xml) {
    return fail("validation_failed", "Nota ainda sem XML autorizado.", 422, { requestId });
  }
  const nome = `nfe-${nota.serie}-${nota.numero ?? "s-numero"}.xml`;
  return new NextResponse(nota.xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${nome}"`,
      "x-request-id": requestId,
    },
  });
}
