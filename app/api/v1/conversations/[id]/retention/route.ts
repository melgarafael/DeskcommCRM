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
import type { TipoDeEnvio } from "@/lib/agent-engine/guardrails/before-send";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
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
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
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
    .select("id, created_at, vetoed_gate, vetoed_code, tipo_envio")
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
      .select(
        "window_start_hour, window_end_hour, resposta_start_hour, resposta_end_hour, allow_sunday, timezone",
      )
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
  //
  // AGORA o par de horas depende do TIPO do envio retido (#2112): `before_send_traces`
  // grava `tipo_envio` (`resposta` × `disparo`, migration 0535) e cada veto é
  // julgado pela janela que o MOTOR usaria para aquele tipo — `resposta_*` para
  // resposta (#1984, herança coluna a coluna de `effectiveKnobs`), `window_*`
  // para disparo/follow-up. Antes TODO veto era tratado como resposta, e um
  // disparo retido às 3h era "resolvido" ou "segurado" pela janela errada.
  const respostaStartHour =
    knobs?.resposta_start_hour ?? knobs?.window_start_hour ?? PACING_DEFAULTS.respostaStartHour;
  const respostaEndHour =
    knobs?.resposta_end_hour ?? knobs?.window_end_hour ?? PACING_DEFAULTS.respostaEndHour;
  const disparoStartHour = knobs?.window_start_hour ?? PACING_DEFAULTS.windowStartHour;
  const disparoEndHour = knobs?.window_end_hour ?? PACING_DEFAULTS.windowEndHour;
  const timezone = fusoDaJanela(knobs?.timezone, (orgRow as { timezone?: string | null } | null)?.timezone);
  const allowSunday = knobs?.allow_sunday ?? PACING_DEFAULTS.allowSunday;

  // Os knobs EFETIVOS do motor para os dois pares: `janelaDeEnvioAberta` lê
  // `window*` quando `resposta=false` e `resposta*` quando `true`, então os dois
  // pares vão preenchidos e o terceiro argumento escolhe qual vale.
  const knobsEfetivos = {
    ...PACING_DEFAULTS,
    windowStartHour: disparoStartHour,
    windowEndHour: disparoEndHour,
    respostaStartHour,
    respostaEndHour,
    allowSunday,
    timezone,
  };

  /** O tipo do veto — `null` no banco é linha anterior à 0535: era resposta. */
  const tipoDoTrace = (tr: { tipo_envio?: string | null }): TipoDeEnvio =>
    tr.tipo_envio === "disparo" ? "disparo" : "resposta";

  // O aviso diz o estado de AGORA, não o histórico:
  //   - retenção seguida de uma resposta que saiu já foi resolvida;
  //   - "fora da janela" com a janela ABERTA agora é mentira — o próximo turno
  //     reavalia com a janela aberta.
  // Cada trace é comparado com a janela do SEU tipo: a resposta aberta não
  // resolve um disparo retido, nem o contrário.
  const agora = new Date();
  const saiuDepoisEm = (ultimaSaida as { created_at?: string } | null)?.created_at ?? null;
  const janelaAbertaAgora = (tipo: TipoDeEnvio): boolean =>
    janelaDeEnvioAberta(agora, knobsEfetivos, tipo === "resposta");
  const vigentes = (traces ?? []).filter((tr) => {
    if (saiuDepoisEm !== null && Date.parse(tr.created_at) <= Date.parse(saiuDepoisEm)) return false;
    return !(tr.vetoed_code === "outside_window" && janelaAbertaAgora(tipoDoTrace(tr)));
  });

  // O contexto que a tela usa para compor a copy nomeia a janela do envio que
  // ela está explicando — a do TIPO do veto mais recente, não sempre a de
  // resposta. Sem retenção vigente o contexto é o de resposta (o da tela não é
  // renderizado nesse caso).
  const tipoDoAviso = vigentes[0] !== undefined ? tipoDoTrace(vigentes[0]) : "resposta";
  const context = {
    window_start_hour: tipoDoAviso === "disparo" ? disparoStartHour : respostaStartHour,
    window_end_hour: tipoDoAviso === "disparo" ? disparoEndHour : respostaEndHour,
    allow_sunday: allowSunday,
    timezone,
  };

  return ok({ retentions: vigentes, context }, { requestId });
}
