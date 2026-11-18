import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/routers/:id/test — classifica uma mensagem de TESTE contra o
 * router (manager+).
 *
 * ─── A regra NÃO mora mais aqui ──────────────────────────────────────────────
 *
 * O carregamento do router, a recusa de inativo, a recusa do roteador por
 * remetente, a consulta ao Jev, o classificador, o `destinoDoVeredito` e o
 * payload de saída estão em `lib/agent-engine/agent/testar-roteador.ts` —
 * `testarRoteador`. Motivo: quem não é rota (servidor MCP, automação) precisa da
 * MESMA regra e só tinha dois caminhos ruins, chamar esta API por HTTP ou
 * copiá-la. Ver a issue #4688.
 *
 * Esta rota guarda a BORDA, e só ela: `requireSupportWrite`, o uuid do path,
 * `resolveAuthDual` (manager, `config:write`, token admin), `tetoDeEscritaDoToken`,
 * o Zod do corpo, a montagem de `deps`, a chamada da função e `ok()`/`fail()`
 * com o `requestId`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { env } from "@/lib/env";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { testarRoteador } from "@/lib/agent-engine/agent/testar-roteador";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const testSchema = z.object({
  message: z.string().min(1).max(4000),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_routers",
    role: "manager",
    // A prévia persiste custo em llm_calls e pode registrar a execução do Jev.
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  const teto = await tetoDeEscritaDoToken(authz, "ai_routers_test", requestId);
  if (teto) return teto;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = testSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const r = await testarRoteador(
    {
      admin: createAdminClient(),
      pool: getSkillsPool(),
      llmCfg: llmEdgeConfigFromEnv(env),
      log: createLogger(),
      t,
    },
    { organizationId: authz.organizationId, routerId: id, mensagem: parsed.data.message },
  );
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  return ok(r.data, { requestId });
}
