import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/from-model — instala um modelo pronto do
 * catálogo (`lib/followup/modelos/`) como fluxo RASCUNHO da organização ativa.
 *
 * ─── A regra NÃO mora mais aqui ──────────────────────────────────────────────
 *
 * A conferência do modelo e da etapa, a validação do grafo ANTES do insert, o
 * insert como rascunho, o 409 do nome repetido e a auditoria estão em
 * `lib/followup/instalar-modelo.ts` — `instalarFluxoDoModelo`. Motivo: o servidor
 * MCP instala fluxo pelo assistente e precisava da MESMA regra, sem chamar esta
 * API por HTTP nem copiá-la. Ver a issue #4688.
 *
 * Esta rota guarda a BORDA, e só ela: `requireSupportWrite`, `resolveAuthDual`
 * (manager, `mcp:write`), `tetoDeEscritaDoToken`, a leitura do JSON, o
 * `instalarModeloSchema`, a chamada da função e `ok(data, { status: 201 })` ou
 * `fail()` com o `requestId`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { instalarModeloSchema } from "@/lib/followup/api-schemas";
import { instalarFluxoDoModelo } from "@/lib/followup/instalar-modelo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor, apiTokenId, supabase } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = instalarModeloSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const r = await instalarFluxoDoModelo(
    supabase,
    { organizationId, actor, apiTokenId: apiTokenId ?? null, requestId, t },
    parsed.data,
  );
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  return ok(r.data, { requestId, status: 201 });
}
