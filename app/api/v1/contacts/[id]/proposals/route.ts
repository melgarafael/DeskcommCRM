/**
 * GET /api/v1/contacts/[id]/proposals — o que a IA ouviu e ainda espera decisão.
 *
 * Só `pending`. Proposta decidida ou vencida é histórico, e oferecer botão para
 * algo que acabou é simulação de atenção — o mesmo raciocínio da rota de
 * reativação, que este arquivo segue de perto.
 *
 * Devolve o `trecho` junto: sem ele, confirmar é um ato de fé. Quem decide
 * precisa ver o que a pessoa escreveu, não só o valor que a IA extraiu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export interface PropostaViva {
  id: string;
  campo: string;
  valor_proposto: string;
  valor_anterior: string | null;
  trecho: string | null;
  conversation_id: string | null;
  expires_at: string;
  proposed_at: string;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  // `viewer` porque LER o que está pendente é informação, não poder. Quem
  // decide precisa de `agent` — está na rota de decisão, ao lado do efeito.
  //
  // Sessão OU token de integração (Spec 33, R2): `mcp:read` e papel `viewer`. A
  // organização sai da sessão ou da LINHA DO TOKEN.
  const guard = await resolveAuthDual(req, {
    requestId,
    resource: "contacts.proposals",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!guard.ok) return guard.response;
  const teto = await tetoDeEscritaDoToken(guard, "contacts.proposals", requestId);
  if (teto) return teto;

  const { data, error } = await guard.supabase
    .from("contact_field_proposals")
    .select("id, campo, valor_proposto, valor_anterior, trecho, conversation_id, expires_at, proposed_at")
    .eq("organization_id", guard.organizationId)
    .eq("contact_id", contactId)
    .eq("status", "pending")
    .order("proposed_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ items: (data ?? []) as PropostaViva[] }, { requestId });
}
