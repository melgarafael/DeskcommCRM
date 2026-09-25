/**
 * POST /api/v1/calls
 *
 * Cria a linha em voice_calls (provider='sip') como 'ringing' e origina via
 * ARI. O worker voice-agent (StasisStart, args[0] === "outbound") acha essa
 * linha pelo asterisk_channel_id e segue o fluxo dele.
 *
 * `voice_calls` é compartilhada com o canal de chamada por WhatsApp (WaCalls,
 * #628/#697) — ver migration 0348. `provider` discrimina as duas origens;
 * o vocabulário de `status` (starting/ringing/connected/ended) é do binário
 * WaCalls upstream, reaproveitado aqui em vez de estender o CHECK. A rota GET
 * traduz isso pra um `status` mais rico na resposta (ver mapStatusParaApi).
 *
 * O endpoint do trunk vem de `voip_trunk_settings` (Configurações > Trunk
 * SIP, migration 0349) — um trunk por organização, cadastrado numa tela em
 * vez de fixo em env. `VOIP_TRUNK_ENDPOINT` continua como fallback pra quem
 * ainda não migrou pra tela (compatibilidade, não fica pra sempre).
 *
 * "mode: human" fica pra quando o atendente quer discar direto (a IA não
 * entra na ponte de áudio) — mesmo endpoint, o worker decide com base nesse
 * campo. A ponte WebRTC pro navegador do atendente não está implementada
 * neste esqueleto.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createCallSchema, listCallsQuerySchema } from "@/lib/schemas/calls";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";
import { originateCall } from "@/lib/voip/ariClient";

export const dynamic = "force-dynamic";

const LIST_COLS =
  "id, direction, status, end_reason, peer_phone, handled_by, started_at, answered_at, ended_at, duration_ms, transcript";

/**
 * Traduz o vocabulário compartilhado (status do binário WaCalls upstream +
 * end_reason livre) pro vocabulário rico que a tela de chamadas SIP sempre
 * teve (`ringing`/`in_progress`/`completed`/`no_answer`/`busy`/`failed`/`canceled`)
 * — feito aqui, não no banco, porque o CHECK de `status` em `voice_calls` é
 * vocabulário de terceiro (não é nosso pra estender).
 */
function mapStatusParaApi(status: string, endReason: string | null): string {
  if (status === "connected") return "in_progress";
  if (status !== "ended") return "ringing"; // starting|ringing
  switch (endReason) {
    case "timeout":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "cancelled":
      return "canceled";
    default:
      return "completed";
  }
}

/**
 * GET /api/v1/calls — lista chamadas SIP da org ativa, mais recente primeiro.
 * `provider=eq.sip` sempre: chamada de WhatsApp (WaCalls) tem tela própria
 * (app/api/v1/voice/calls/*), não entra aqui.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listCallsQuerySchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, { requestId, details: parsed.error.flatten() });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("voice_calls")
    .select(LIST_COLS)
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "sip")
    .order("started_at", { ascending: false })
    .limit(q.limit);

  if (q.direction) query = query.eq("direction", q.direction);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = (data ?? []).map((row) => {
    const apiStatus = mapStatusParaApi(row.status, row.end_reason);
    return {
      id: row.id,
      direction: row.direction,
      status: apiStatus,
      // peer_phone é sempre o número do cliente — a UI só lê o campo que
      // bate com a direção (counterpartNumber em app/app/calls/_client.tsx),
      // então os dois recebem o mesmo valor.
      from_number: row.peer_phone,
      to_number: row.peer_phone,
      handled_by: row.handled_by,
      started_at: row.started_at,
      answered_at: row.answered_at,
      ended_at: row.ended_at,
      duration_seconds: row.duration_ms != null ? Math.round(row.duration_ms / 1000) : null,
      transcript: row.transcript,
    };
  });

  // Filtro de status é pós-mapeamento (o vocabulário rico não existe no
  // banco) — aplicado aqui em vez de no query builder acima.
  const filtered = q.status ? rows.filter((r) => r.status === q.status) : rows;

  return ok(filtered, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO do acompanhamento administrativo, ANTES do RBAC e do
  // client de service role: quem está só ACOMPANHANDO a organização de outra
  // pessoa não escreve por ela. Sem esta linha, um acompanhamento somente
  // leitura originava ligação, cadastrava número e trocava a credencial do
  // tronco — em nome do cliente, com a trilha apontando para ele.
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createCallSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  // Trunk da organização (Configurações > Trunk SIP) — fallback pro env pra
  // quem ainda não cadastrou nada na tela.
  const { data: trunkConfig } = await supabase
    .from("voip_trunk_settings")
    .select("endpoint_name, is_active")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  const trunkEndpoint =
    trunkConfig && trunkConfig.is_active ? trunkConfig.endpoint_name : process.env.VOIP_TRUNK_ENDPOINT;
  if (!trunkEndpoint) {
    return fail(
      "trunk_not_configured",
      "Nenhum trunk SIP configurado para esta organização (Configurações > Trunk SIP).",
      422,
      { requestId },
    );
  }

  // Gerado ANTES do insert e passado como `channelId` pro ARI (originateCall):
  // fecha a race entre o worker recebendo StasisStart (via WebSocket, processo
  // separado) e este handler gravando asterisk_channel_id DEPOIS que o ARI
  // responde — se o Stasis chegar primeiro, a linha já existe com o id certo,
  // nunca precisa de um update() separado torcendo pra chegar a tempo.
  const channelId = randomUUID();

  const { data: callRow, error: insertError } = await supabase
    .from("voice_calls")
    .insert({
      organization_id: activeOrg.orgId,
      provider: "sip",
      direction: "outbound",
      status: "ringing",
      peer_phone: input.toNumber,
      lead_id: input.leadId ?? null,
      contact_id: input.contactId ?? null,
      owner_user_id: input.mode === "human" ? authUser.id : null,
      handled_by: input.mode === "human" ? "human" : "ai",
      started_at: new Date().toISOString(),
      asterisk_channel_id: channelId,
    })
    .select()
    .single();

  if (insertError || !callRow) {
    return fail("internal_error", insertError?.message ?? "failed_to_create_call", 500, { requestId });
  }

  try {
    const channel = await originateCall({
      toNumber: input.toNumber,
      fromNumber: process.env.VOIP_DEFAULT_CALLER_ID,
      trunkEndpoint,
      callerLabel: input.mode,
      channelId,
    });

    await audit({
      action: "call.created",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "voice_calls",
      resourceId: callRow.id,
      requestId,
      metadata: { direction: "outbound", mode: input.mode, to_number: input.toNumber },
    });

    return ok({ callId: callRow.id, channelId: channel.id }, { status: 201, requestId });
  } catch (err) {
    await supabase.from("voice_calls").update({ status: "ended", end_reason: "failed" }).eq("id", callRow.id);
    return fail("originate_failed", err instanceof Error ? err.message : "originate_failed", 502, { requestId });
  }
}
