/**
 * GET /api/v1/ai/cases/:id — detalhe do caso + timeline (spec 15 §7, Wave 5).
 * Read-only via PostgREST, org-scoped, 404 honesto.
 *
 * A consulta vive em `lib/escalacao/chamados.ts` — a capacidade "ler um chamado e
 * o que a pessoa decidiu" do agente lê o mesmo detalhe e a mesma linha do tempo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerChamado } from "@/lib/escalacao/chamados";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;

  let chamado;
  try {
    chamado = await lerChamado(createAdminClient(), org.orgId, id);
  } catch {
    return fail("internal_error", t("Falha ao carregar o caso."), 500, { requestId });
  }
  if (!chamado) return fail("not_found", t("Caso não encontrado."), 404, { requestId });

  return ok(chamado, { requestId });
}
