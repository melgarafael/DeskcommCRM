/**
 * GET /api/v1/conversations/[id]/retention — vetos recentes da cadeia before_send
 * para o contato desta conversa (Operação Visível F2-i). Read-only, RLS-scoped
 * (client de sessão): responde POR QUE a resposta do assistente foi retida, com o
 * contexto dos knobs efetivos do número para a UI compor a copy leiga.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { janelaDeEnvioAberta } from "@/lib/agent-engine/pacing/engine";
import { fusoDaJanela } from "@/lib/agent-engine/pacing/store";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Só vetos recentes interessam à tela — mais velho que isso é histórico, não aviso. */
const RETENTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, contact_id, channel_session_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (convErr) {
    return fail("internal_error", t("Failed to load conversation."), 500, { requestId });
  }
  if (!conv) {
    return fail("not_found", t("Conversation not found."), 404, { requestId });
  }

  const since = new Date(Date.now() - RETENTION_LOOKBACK_MS).toISOString();
  const { data: traces, error: traceErr } = await supabase
    .from("before_send_traces")
    .select("id, created_at, vetoed_gate, vetoed_code")
    .eq("organization_id", activeOrg.orgId)
    .eq("contact_id", conv.contact_id)
    .not("vetoed_gate", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);
  if (traceErr) {
    return fail("internal_error", t("Failed to load retention traces."), 500, { requestId });
  }

  // Knobs do número (coluna NULL = default conservador do engine) — a UI usa o
  // contexto pra dizer QUAL janela segurou o envio, não a genérica.
  const [{ data: knobs }, { data: orgRow }, { data: ultimaSaida }] = await Promise.all([
    supabase
      .from("channel_knobs")
      .select("window_start_hour, window_end_hour, allow_sunday, timezone")
      .eq("organization_id", activeOrg.orgId)
      .eq("channel_session_id", conv.channel_session_id)
      .maybeSingle(),
    // Sem fuso no número, o motor avalia a janela no da organização.
    supabase.from("organizations").select("timezone").eq("id", activeOrg.orgId).maybeSingle(),
    supabase
      .from("messages")
      .select("created_at")
      .eq("organization_id", activeOrg.orgId)
      .eq("conversation_id", id)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // O MESMO fuso que o motor usa para decidir (`fusoDaJanela`): override do
  // canal → fuso da organização → padrão. Antes esta rota caía direto em São
  // Paulo e o aviso dizia "fora da janela" com a hora de outra cidade.
  const context = {
    window_start_hour: knobs?.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
    window_end_hour: knobs?.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
    allow_sunday: knobs?.allow_sunday ?? PACING_DEFAULTS.allowSunday,
    timezone: fusoDaJanela(knobs?.timezone, (orgRow as { timezone?: string | null } | null)?.timezone),
  };

  // O aviso diz o estado de AGORA, não o histórico:
  //   - retenção seguida de uma resposta que saiu já foi resolvida;
  //   - "fora da janela" com a janela ABERTA agora é mentira — o próximo turno
  //     reavalia com a janela aberta.
  const saiuDepoisEm = (ultimaSaida as { created_at?: string } | null)?.created_at ?? null;
  const janelaAbertaAgora = janelaDeEnvioAberta(new Date(), {
    ...PACING_DEFAULTS,
    windowStartHour: context.window_start_hour,
    windowEndHour: context.window_end_hour,
    allowSunday: context.allow_sunday,
    timezone: context.timezone,
  });
  const vigentes = (traces ?? []).filter(
    (tr) =>
      (saiuDepoisEm === null || Date.parse(tr.created_at) > Date.parse(saiuDepoisEm)) &&
      !(tr.vetoed_code === "outside_window" && janelaAbertaAgora),
  );

  return ok({ retentions: vigentes, context }, { requestId });
}
