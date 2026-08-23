import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import {
  reactivateChannelSession,
  type ChannelReactivationActor,
} from "@/lib/channels/reactivate";
import { getWahaClient } from "@/lib/waha/client";
import { createClient } from "@/lib/supabase/server";

/**
 * Onboarding WhatsApp session orchestration.
 *
 * GET  → returns current session status (status enum from WAHA: STARTING|SCAN_QR_CODE|WORKING|FAILED|STOPPED)
 * POST → starts session if not already running. Idempotent.
 *
 * The actual QR image is served via /api/v1/onboarding/whatsapp/qr (proxy
 * to WAHA so client can <img src="..." /> without exposing the API key).
 */

interface WahaSessionResponse {
  name?: string;
  status?: string;
  config?: Record<string, unknown>;
  me?: { id?: string; pushName?: string };
}

function defaultSessionName(orgId: string): string {
  return `org_${orgId.slice(0, 8)}`;
}

/**
 * A linha de `channel_sessions` deste onboarding — criando, reutilizando ou
 * RESSUSCITANDO.
 *
 * O nome da sessão aqui é derivado do org (`org_<8>`), então a linha do
 * onboarding é sempre a MESMA. Quem excluiu o número e voltou para reconectar
 * cai exatamente nela, arquivada: devolvê-la como está subiria a sessão no
 * transporte e deixaria um canal que recebe e não entrega nada (webhook, ingest
 * e envio filtram `archived_at`) — e recusá-la fecharia o onboarding para sempre,
 * porque o nome nunca muda. Retomar o pareamento é ressuscitar.
 *
 * `phone_number` volta a NULL de propósito: o número só se sabe depois do
 * escaneamento, pode ser outro aparelho, e o health check só preenche o campo
 * quando ele está vazio — manter o antigo o congelaria errado na tela para
 * sempre. De quebra, a linha para de disputar o par (org, número) da trava da
 * 0106 enquanto ninguém escaneou.
 *
 * Retomar o pareamento é uma das duas portas de volta, então carrega o ATOR:
 * `reactivateChannelSession` audita a ressurreição, e sem quem pediu a trilha
 * mostraria um canal excluído voltando a entregar sem dono.
 */
async function ensureChannelSession(
  orgId: string,
  sessionName: string,
  actor: ChannelReactivationActor,
): Promise<string> {
  const supabase = await createClient();
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("waha_session_name", sessionName)
      .maybeSingle();
  const { data: existingRaw } = await queryTolerantToMissingArchived(
    () => buscar(`id, ${ARCHIVED_AT}`),
    () => buscar("id"),
  );
  const existing = existingRaw as { id: string; archived_at?: string | null } | null;
  if (existing?.id) {
    if (!existing.archived_at) return existing.id;
    const { error: reErr } = await reactivateChannelSession(
      supabase,
      {
        organizationId: orgId,
        channelSessionId: existing.id,
        archivedAt: existing.archived_at ?? null,
      },
      {
        status: "STARTING",
        last_status_change_at: new Date().toISOString(),
        consecutive_health_fails: 0,
        phone_number: null,
      },
      actor,
    );
    if (reErr) throw new Error(`channel_session_reactivate_failed: ${reErr.message}`);
    return existing.id;
  }
  const { data: created, error } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: sessionName,
      engine: "NOWEB",
      webhook_path_token: crypto.randomUUID().replace(/-/g, ""),
      webhook_secret_encrypted: Buffer.from([0]),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      metadata: {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`channel_session_insert_failed: ${error.message}`);
  return created.id as string;
}

export async function GET() {
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Sessão expirada", 401);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("tenant_not_found", "Sem organização ativa", 404);
  const waha = getWahaClient();
  if (!waha) return ok({ status: "WAHA_NOT_CONFIGURED", session: null });
  const sessionName = defaultSessionName(activeOrg.orgId);
  try {
    const remote = (await waha.getSessionQr(sessionName)) as WahaSessionResponse;
    return ok({ status: remote.status ?? "UNKNOWN", session: sessionName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("404")) return ok({ status: "NOT_STARTED", session: sessionName });
    return ok({ status: "ERROR", session: sessionName, error: msg });
  }
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  // Inicia/reinicia a sessão oficial de WhatsApp do tenant — `?restart=1`
  // derruba a sessão antes de reabrir. Mesmo piso de "channels/official"
  // (admin): reconectar o canal não é operação de agente.
  const authz = await requireRole("admin", { requestId, resource: "onboarding_whatsapp_session" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;
  const waha = getWahaClient();
  if (!waha) return fail("waha_not_configured", "Suba o Docker (docker compose up -d waha) e tente novamente.", 503);
  const sessionName = defaultSessionName(activeOrg.orgId);

  // 1) Make sure we have a row in channel_sessions.
  const channelSessionId = await ensureChannelSession(activeOrg.orgId, sessionName, {
    userId: user.id,
    requestId,
    metadata: { provider: CHANNEL_PROVIDER_WAHA, origin: "onboarding" },
  });

  // 1b) `?restart=1` = pedido explícito de QR novo. O start sozinho não resolve
  // uma sessão FAILED: o WAHA responde 422 ("already exists") e o usuário fica
  // preso olhando um QR morto. O QR do WhatsApp expira em poucos minutos, então
  // "falhou, gere outro" é fluxo normal do onboarding, não caso de exceção.
  if (new URL(req.url).searchParams.get("restart") === "1") {
    try {
      await waha.stopSession(sessionName);
    } catch {
      // Sessão já parada/inexistente: seguir para o start é o comportamento certo.
    }
  }

  // 2) Start the session in WAHA. Idempotent — WAHA returns 422 if already started; treat as ok.
  try {
    const remote = (await waha.startSession(sessionName)) as WahaSessionResponse;
    // `requestId` também na resposta: é ele que liga o `X-Request-Id` que o
    // operador vê ao evento `channel.reactivated` que a ressurreição gravou.
    return ok(
      { status: remote.status ?? "STARTING", session: sessionName, channel_session_id: channelSessionId },
      { requestId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("422") || msg.includes("409")) {
      // Session already exists — just fetch status.
      const remote = (await waha.getSessionQr(sessionName)) as WahaSessionResponse;
      return ok(
        { status: remote.status ?? "RUNNING", session: sessionName, channel_session_id: channelSessionId },
        { requestId },
      );
    }
    return NextResponse.json(
      { error: { code: "waha_start_failed", message: msg } },
      { status: 502 },
    );
  }
}
