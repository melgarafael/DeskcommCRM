/**
 * Aplica o texto inbound aos follow-ups vivos do contato e manda o
 * próximo passo neste mesmo request. O gatilho é a resposta do lead,
 * não o relógio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";
import {
  aplicarRespostaInbound,
  avancarEnrollmentAtivo,
  createSupabaseAdminClient,
  type TickDeps,
} from "./engine";
import type { EnrollmentRow } from "./node-handlers";

export type SinalDeInboundFollowup = {
  organizationId: string;
  contactId: string;
  texto?: string | null;
};

export function textoDoPayloadInbound(payload: Record<string, unknown> | null | undefined): string {
  const preview = payload?.body_preview;
  if (typeof preview === "string" && preview.trim()) return preview.trim();
  const body = payload?.body;
  if (typeof body === "string" && body.trim()) return body.trim();
  return "";
}

function tickDepsDe(admin: SupabaseClient): TickDeps {
  return {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob: async (job) => {
      const { error } = await admin.from("job_queue").insert({
        organization_id: job.organization_id,
        contact_id: job.contact_id,
        kind: "followup_turn",
        payload: job.payload,
      });
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Uma mensagem do lead vale para UM `match_reply`. Reaplicar o mesmo texto
 * no passo seguinte (endereço, motivo…) pula a pergunta.
 *
 * `esperaDesde` = `enrollment.updated_at` no momento em que o nó estacionou
 * em `waiting_reply` (confirmação de nome, pergunta de endereço, etc.).
 */
export function inboundEhDestaPergunta(enviadaEm: string, esperaDesde: string): boolean {
  return enviadaEm >= esperaDesde;
}

type InboundResolvido = { texto: string; enviadaEm: string | null };

async function ultimoInboundDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactIds: string[],
): Promise<InboundResolvido> {
  const { data, error } = await admin
    .from("messages")
    .select("body, sent_at")
    .eq("organization_id", orgId)
    .in("contact_id", contactIds)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const texto = typeof data?.body === "string" ? data.body.trim() : "";
  const enviadaEm = typeof data?.sent_at === "string" ? data.sent_at : null;
  return { texto, enviadaEm };
}

async function aplicarTextoAosEnrollmentsEmEspera(
  admin: SupabaseClient,
  orgId: string,
  contactIds: string[],
  texto: string,
  enviadaEm: string | null,
  deps: TickDeps,
): Promise<number> {
  const { data, error } = await admin
    .from("followup_enrollments")
    .select("*")
    .eq("organization_id", orgId)
    .in("contact_id", contactIds)
    .eq("status", "waiting_reply");
  if (error) throw new Error(error.message);
  let aplicados = 0;
  for (const row of data ?? []) {
    const enrollment = row as EnrollmentRow;
    // Sem sent_at não dá pra saber se a mensagem é desta pergunta — fail-closed
    // (igual ao relógio): não avança com texto velho.
    if (!enviadaEm || !inboundEhDestaPergunta(enviadaEm, enrollment.updated_at)) continue;
    await aplicarRespostaInbound(deps, enrollment, texto);
    aplicados++;
  }
  return aplicados;
}

/**
 * Avança enrollments `active` já vencidos deste contato e manda o texto fixo
 * neste request. O gatilho de retorno usa isto porque o cron de 1 minuto
 * chega tarde demais para quem ACABOU de escrever.
 */
export async function avancarFollowupsAtivosDoContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<void> {
  const contactIds = await idsDoContatoEGemeos(admin, organizationId, contactId);
  const deps = tickDepsDe(admin);
  for (let i = 0; i < 6; i++) {
    const agora = new Date().toISOString();
    const { data: vivos, error: vivosErr } = await admin
      .from("followup_enrollments")
      .select("*")
      .eq("organization_id", organizationId)
      .in("contact_id", contactIds)
      .eq("status", "active")
      .lte("next_eval_at", agora)
      .limit(8);
    if (vivosErr) throw new Error(vivosErr.message);
    for (const row of vivos ?? []) {
      await avancarEnrollmentAtivo(deps, row as EnrollmentRow);
    }
    const enviados = await enviarTextoFixoPendente(admin, contactIds);
    if (!(vivos?.length) && !enviados) break;
  }
}

export async function aplicarTextoNosFollowups(
  admin: SupabaseClient,
  sinal: SinalDeInboundFollowup,
): Promise<void> {
  const contactIds = await idsDoContatoEGemeos(admin, sinal.organizationId, sinal.contactId);
  const ultimo = await ultimoInboundDoContato(admin, sinal.organizationId, contactIds);
  const texto = (sinal.texto?.trim() || ultimo.texto).trim();
  if (!texto) return;
  const enviadaEm = ultimo.enviadaEm;
  const deps = tickDepsDe(admin);

  // Apply dentro do loop (não numa 2ª passada cega): a mensagem que ENFILEIROU
  // a confirmação de nome não pode responder a essa confirmação no mesmo request.
  // `inboundEhDestaPergunta` exige sent_at >= updated_at do waiting_reply.
  for (let i = 0; i < 6; i++) {
    const aplicados = await aplicarTextoAosEnrollmentsEmEspera(
      admin,
      sinal.organizationId,
      contactIds,
      texto,
      enviadaEm,
      deps,
    );
    const agora = new Date().toISOString();
    const { data: vivos, error: vivosErr } = await admin
      .from("followup_enrollments")
      .select("*")
      .eq("organization_id", sinal.organizationId)
      .in("contact_id", contactIds)
      .eq("status", "active")
      .lte("next_eval_at", agora)
      .limit(8);
    if (vivosErr) throw new Error(vivosErr.message);
    for (const row of vivos ?? []) {
      await avancarEnrollmentAtivo(deps, row as EnrollmentRow);
    }
    const enviados = await enviarTextoFixoPendente(admin, contactIds);
    if (!aplicados && !(vivos?.length) && !enviados) break;
  }
}
