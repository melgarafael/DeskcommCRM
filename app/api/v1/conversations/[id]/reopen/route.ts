import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/reopen — reabre uma conversa encerrada.
 *
 * ## Por que existir, se a tela já reabre
 *
 * A tela reabre por `PATCH /api/v1/conversations/[id]` com `status: "open"`, que
 * por baixo chama `fn_service_status`. Isso funciona para uma pessoa e não serve
 * para uma integração: aquele PATCH aceita `status` arbitrário (inclusive
 * `claimed`/`archived`) e devolveria à integração um poder que a issue não pediu.
 *
 * Esta rota é o gesto ESTREITO: reabrir, e só. Ela chama a MESMA transição do
 * banco (`fn_service_status`), com o mesmo CAS de revisão — reabrir escrevendo
 * `status` na mão pularia a revisão, o carimbo de atendimento e a demanda, que
 * são regras do BANCO e não desta rota (`./_handler.ts` tem o detalhe).
 *
 * Auth: sessão agent+ ou Bearer com `conversations:write`. Audit:
 * `conversation.reopened` / `conversation.reopened_by_token`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ESCOPO_CONVERSAS_ESCRITA } from "@/lib/api/escopos-do-token";
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { reabrirConversaHandler } from "./_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let body: unknown = {};
  const text = await req.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return fail("validation_failed", "Corpo inválido.", 422, { requestId });
  }
  const parsed = z
    .object({ expected_revision: z.number().int().positive().optional() })
    .safeParse(body);
  if (!parsed.success) return fail("validation_failed", "Revisão inválida.", 422, { requestId });

  const { id } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: ESCOPO_CONVERSAS_ESCRITA,
    tokenRole: "agent",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  try {
    const { conversation } = await reabrirConversaHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
        ...(authz.apiTokenId !== undefined ? { apiTokenId: authz.apiTokenId } : {}),
      },
      id,
      {
        ...(parsed.data.expected_revision !== undefined
          ? { expectedRevision: parsed.data.expected_revision }
          : {}),
      },
    );
    return ok({ reopened: true, conversation }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, t(err.message), err.status, { requestId });
    throw err;
  }
}
