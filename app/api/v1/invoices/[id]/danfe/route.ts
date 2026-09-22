/**
 * GET /api/v1/invoices/[id]/danfe — gera o DANFE em PDF via sidecar.
 *
 * O PDF é DERIVADO do XML na hora (nunca armazenado como fonte). Sem o
 * pacote `sped-da` no sidecar, 422 honesto com DANFE_INDISPONIVEL — nunca um
 * PDF inventado.
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
    .select("numero, serie, xml")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const nota = data as unknown as { numero: number | null; serie: string; xml: string | null } | null;
  if (!nota) return fail("not_found", "Nota não encontrada.", 404, { requestId });
  if (!nota.xml) {
    return fail("validation_failed", "Nota ainda sem XML autorizado.", 422, { requestId });
  }

  const base = process.env.FISCAL_SIDECAR_URL?.trim();
  const segredo = process.env.FISCAL_SIDECAR_SECRET?.trim();
  if (!base || !segredo) {
    return fail("validation_failed", "DANFE indisponível: sidecar fiscal não configurado.", 422, { requestId });
  }
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 120000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/danfe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fiscal-Secret": segredo },
      body: JSON.stringify({ xml: nota.xml }),
      signal: controle.signal,
    });
    const corpo = (await res.json().catch(() => null)) as {
      ok: boolean;
      pdf_base64?: string;
      mensagem?: string;
    } | null;
    if (!corpo?.ok || !corpo.pdf_base64) {
      return fail("validation_failed", corpo?.mensagem ?? "DANFE indisponível.", 422, { requestId });
    }
    const pdf = Buffer.from(corpo.pdf_base64, "base64");
    return new NextResponse(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="danfe-${nota.serie}-${nota.numero ?? "s-numero"}.pdf"`,
        "x-request-id": requestId,
      },
    });
  } catch {
    return fail("internal_error", "Sidecar fiscal inalcançável.", 500, { requestId });
  } finally {
    clearTimeout(limite);
  }
}
