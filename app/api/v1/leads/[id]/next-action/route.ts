import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/next-action
 *
 * O humano decide sobre a próxima ação que o agente propôs: `approve` ou
 * `dismiss`. Os DOIS geram atividade — a recusa é sinal, não ausência de sinal.
 * "O humano viu e disse não" é o que impede o agente de repropor o mesmo; sem
 * registro, a IA insiste no que já foi negado.
 *
 * A trava de autorização compara o TEXTO, não o `updated_at`. Entre o render e
 * o clique, o agente pode reescrever `next_action`: sem trava, o sistema
 * executaria a proposta NOVA em nome de quem autorizou a ANTIGA. E o texto é o
 * que a pessoa leu — o timestamp é só o que o banco mexeu. Mesmo raciocínio do
 * lastro: vale o que sustenta a afirmação, não o carimbo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  decision: z.enum(["approve", "dismiss"]),
  /**
   * QUAL proposta estava na tela — a identidade dela, não o texto.
   *
   * Texto igual não é proposta igual: o agente pode reescrever "enviar
   * proposta" palavra por palavra significando outra coisa, e se o humano já
   * tivesse ignorado a primeira, a segunda seria indistinguível dela.
   */
  approved_seq: z.number().int().nonnegative(),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // Mesmo piso do move: quem não pode mexer no negócio não decide por ele.
  // `viewer` lê o board e vê a proposta, mas não aprova nem descarta.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user } = authz;

  const supabase = await createClient();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Corpo inválido.", 422, {
      requestId,
      details: { issues: parsed.error.issues },
    });
  }
  const { decision, approved_seq } = parsed.data;

  // O lead vem pela RLS do caller — é ele que prova a org, nunca o body.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id, contact_id, status")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const row = lead as {
    id: string;
    organization_id: string;
    contact_id: string | null;
    status: string;
  };
  if (!row.contact_id) {
    return fail(
      "next_action_absent",
      "Este negócio não tem contato, então não há proposta do agente.",
      409,
      { requestId },
    );
  }

  const { data: estado, error: estadoErr } = await supabase
    .from("lead_state")
    .select("next_action, next_action_seq")
    .eq("organization_id", row.organization_id)
    .eq("contact_id", row.contact_id)
    .maybeSingle();
  if (estadoErr) return fail("internal_error", estadoErr.message, 500, { requestId });

  const linha = estado as { next_action: string | null; next_action_seq: number } | null;
  const atual = linha?.next_action?.trim() ?? null;
  if (!atual) {
    return fail("next_action_absent", "Não há proposta pendente para este negócio.", 409, {
      requestId,
    });
  }

  if (linha!.next_action_seq !== approved_seq) {
    // Autorização vencida: quem clicou autorizou OUTRA proposta. Comparar
    // identidade e não texto é o que pega a reescrita com as mesmas palavras.
    return fail(
      "next_action_changed",
      "A proposta mudou desde que você a leu. Confira a nova antes de decidir.",
      409,
      { requestId, details: { current_text: atual, current_seq: linha!.next_action_seq } },
    );
  }

  const atividade = await emitLeadActivity(supabase, {
    organizationId: row.organization_id,
    leadId: row.id,
    contactId: row.contact_id,
    type: decision === "approve" ? "next_action_approved" : "next_action_dismissed",
    sourceModule: "crm",
    sourceId: row.id,
    actor: { type: "user", id: user.id },
    reason: decision === "approve" ? `Aprovou: ${atual}` : `Descartou: ${atual}`,
    payload: { next_action: atual, decision },
  });
  if (!atividade.ok) {
    return fail("internal_error", atividade.error ?? "activity insert failed", 500, {
      requestId,
    });
  }

  // Decidida é decidida: a proposta sai de cena nos dois casos, senão o card
  // continuaria pedindo a mesma decisão que a pessoa acabou de tomar. O que
  // ficou registrado foi a DECISÃO, na timeline.
  const { error: limpaErr } = await supabase
    .from("lead_state")
    .update({ next_action: null })
    .eq("organization_id", row.organization_id)
    .eq("contact_id", row.contact_id);
  if (limpaErr) return fail("internal_error", limpaErr.message, 500, { requestId });

  return ok({ lead_id: row.id, decision, next_action: atual }, { requestId });
}
