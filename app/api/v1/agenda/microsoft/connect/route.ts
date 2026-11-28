/**
 * GET /api/v1/agenda/microsoft/connect — começa a conexão da conta Microsoft DE
 * QUEM CLICOU. Aberto pelo navegador: todo desfecho volta para a Agenda com
 * `?outlook=<código>`.
 */
import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { emitirEstado } from "@/lib/agenda/google/estado";
import { origemLocalDosCabecalhos } from "@/lib/agenda/google/config";
import { assinarVinculo, NOME_DO_VINCULO, VALIDADE_DO_VINCULO_S } from "@/lib/agenda/google/vinculo";
import { CAMINHO_DO_CALLBACK_DA_MICROSOFT, configuracaoDaMicrosoft } from "@/lib/agenda/microsoft/config";
import { urlDeConsentimento } from "@/lib/agenda/microsoft/oauth";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

function voltarCom(codigo: string, req: NextRequest): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return comIdDaRequisicao(NextResponse.redirect(new URL(`/app/agenda?outlook=${codigo}`, base)), req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const autorizado = await requireRole("agent", { requestId, resource: "calendar_connections" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  const app = await configuracaoDaMicrosoft(origemLocalDosCabecalhos(req.headers) ?? undefined);
  if (!app) return voltarCom("nao_configurado", req);

  const nonce = randomBytes(16).toString("base64url");
  let state: string;
  try {
    state = emitirEstado(
      { organizationId: org.orgId, userId: user.id, authSessionId: await authenticatedSessionId() },
      { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
    );
  } catch {
    await audit({
      action: "agenda.microsoft.conexao_falhou",
      organizationId: org.orgId,
      metadata: { reason: "segredo_de_state_indisponivel" },
    });
    return voltarCom("segredo_indisponivel", req);
  }

  await audit({
    action: "agenda.microsoft.conexao_iniciada",
    organizationId: org.orgId,
    metadata: { user_id: user.id },
  });

  const resposta = comIdDaRequisicao(
    NextResponse.redirect(urlDeConsentimento(app, { state, contaSugerida: user.email })),
    req,
  );
  // `lax` de propósito: é o que viaja na volta do consentimento (ver `vinculo.ts`).
  resposta.cookies.set(NOME_DO_VINCULO, assinarVinculo(nonce, env.INTERNAL_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_DA_MICROSOFT,
    maxAge: VALIDADE_DO_VINCULO_S,
  });
  return resposta;
}
