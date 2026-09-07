import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/reactivation
 *
 * O humano decide sobre a proposta de reativação: `accept` ou `dismiss`. Os
 * DOIS geram atividade — recusa é sinal, não ausência de sinal. "Vi e decidi
 * não retomar" é o que distingue um negócio encerrado com critério de um
 * negócio esquecido, e sem registro os dois ficam idênticos na timeline.
 *
 * ⚠️ A TRAVA COMPARA A IDENTIDADE DA PROPOSTA (`proposal_id`), não o estado do
 * lead. Entre o render e o clique a proposta pode ter VENCIDO — e aceitar uma
 * proposta vencida executaria, em nome de quem clicou, uma decisão que o
 * sistema já registrou como não tomada. O `eq("status", "pending")` no UPDATE é
 * o que fecha a corrida no banco: quem perder recebe 409 e vê a tela atualizada.
 *
 * Mesmo raciocínio da wave 4, um degrau adiante: lá a trava era contra o agente
 * reescrever a proposta; aqui é contra o RELÓGIO tê-la encerrado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  decision: z.enum(["accept", "dismiss"]),
  /** QUAL proposta estava na tela. Ver o ⚠️ do cabeçalho. */
  proposal_id: z.string().uuid(),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const guard = await requireRole("agent", { requestId });
  if (!guard.ok) return guard.response;
  const t = (texto: string) => traduzir(texto, guard.user.idioma);
  const orgId = guard.org.orgId;
  const userId = guard.user.id;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("decision e proposal_id são obrigatórios."), 400, { requestId });
  }
  const { decision, proposal_id } = parsed.data;

  const supabase = await createClient();

  // O UPDATE condicional É a trava: `status = 'pending'` no WHERE. Ler-e-depois-
  // escrever deixaria a janela em que o watcher vence a proposta no meio.
  const { data: decidida, error } = await supabase
    .from("crm_lead_reactivations")
    .update({
      status: decision === "accept" ? "accepted" : "dismissed",
      decided_at: new Date().toISOString(),
      decided_by_user_id: userId,
    })
    .eq("id", proposal_id)
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .select("id, expires_at")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!decidida) {
    // Não distinguimos "não existe" de "já não está pendente" na MENSAGEM por
    // vazamento? Não: aqui distinguir ajuda e não expõe nada — a pessoa precisa
    // saber que a proposta venceu, senão ela clica de novo achando que falhou.
    const { data: existe } = await supabase
      .from("crm_lead_reactivations")
      .select("status")
      .eq("id", proposal_id)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (existe) {
      return fail(
        "reactivation_not_pending",
        `${t("Esta sugestão já foi")} ${
          (existe as { status: string }).status === "expired" ? t("encerrada pelo prazo") : t("decidida")
        }.`,
        409,
        { requestId },
      );
    }
    return fail("not_found", t("Sugestão não encontrada."), 404, { requestId });
  }

  const { data: lead } = await supabase
    .from("crm_leads")
    .select("contact_id")
    .eq("id", leadId)
    .maybeSingle();
  const contactId = (lead as { contact_id: string | null } | null)?.contact_id ?? null;

  // ── O ENVIO, pelo caminho que JÁ EXISTE ─────────────────────────────────
  //
  // `cron_jobs` + `followup_turn` é como toda mensagem agendada sai deste
  // produto. Criar um segundo caminho seria o mesmo erro de ter duas definições
  // de "esfriando": funcionaria hoje e divergiria no primeiro ajuste de
  // anti-banimento, janela de envio ou throttle — e a divergência apareceria
  // como "algumas mensagens ignoram o horário permitido".
  //
  // ⚠️ NÃO agenda se o contato JÁ tem um follow-up pendente. A guarda existe no
  // agendador do agente com a razão escrita lá — "evita bombardear o lead com
  // confirmações repetidas" — e vale igual aqui. Na prática é raro (lead com
  // follow-up agendado está `em_voo`, não `em_risco`, e não recebe proposta),
  // mas o raro acontece quando o agente agenda ENTRE a proposta e o clique.
  let envioAgendado = false;
  if (decision === "accept" && contactId) {
    const { data: pendente } = await supabase
      .from("cron_jobs")
      .select("id")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .eq("kind", "at")
      .eq("job_kind", "followup_turn")
      .eq("enabled", true)
      .gt("next_run_at", new Date().toISOString())
      .maybeSingle();
    if (!pendente) {
      const { error: cronErr } = await supabase.from("cron_jobs").insert({
        organization_id: orgId,
        contact_id: contactId,
        kind: "at",
        job_kind: "followup_turn",
        // Agora: a pessoa acabou de autorizar. Adiar seria transformar uma
        // decisão em promessa, que é o que a wave inteira combate.
        next_run_at: new Date().toISOString(),
        payload: {
          reason: "Retomada de contato autorizada por um humano",
          promise: null,
          promised_at: null,
          source: "reactivation",
          proposal_id,
        },
      });
      envioAgendado = !cronErr;
    }
  }

  const atividade = await emitLeadActivity(supabase, {
    organizationId: orgId,
    leadId,
    contactId,
    type: decision === "accept" ? "reactivation_accepted" : "reactivation_dismissed",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: userId },
    // Nomeia a decisão, nunca o conteúdo da proposta nem dado do negócio.
    // Canônico em português: quem traduz é a LEITURA (`t(item.reason)`). Ver o
    // bloco "vocabulario de dominio persistido" em `lib/i18n/dicionario.ts`.
    reason:
      decision === "accept"
        ? "Retomada de contato aprovada"
        : "Retomada de contato descartada — decisão registrada",
    payload: { proposal_id },
  });
  if (!atividade.ok) {
    // ALTO: esta atividade É O REGISTRO DA DECISÃO, não rastro de algo já
    // visível. Sem ela, o negócio volta ao normal e ninguém sabe quem mandou —
    // e a próxima proposta nasce sem saber que esta foi recusada.
    await registraFalhaDeAtividade(supabase, {
      organizationId: orgId,
      leadId,
      tipo: decision === "accept" ? "reactivation_accepted" : "reactivation_dismissed",
      origem: "api/v1/leads/[id]/reactivation",
      erro: atividade.error,
      requestId,
    });
    return fail(
      "activity_write_failed",
      t("A decisão não pôde ser registrada. Nada foi enviado ao cliente."),
      500,
      { requestId },
    );
  }

  return ok(
    {
      id: (decidida as { id: string }).id,
      status: decision === "accept" ? "accepted" : "dismissed",
      // O campo VOLTOU, e agora diz a verdade: ele reflete se um
      // `followup_turn` foi de fato enfileirado. Ele saiu por um tempo porque a
      // versão anterior respondia `true` sem agendar nada — comentário protege
      // quem edita, contrato protege quem consome, e são pessoas diferentes.
      //
      // `false` numa aceitação é estado REAL, não erro: o contato já tinha
      // follow-up pendente, ou o negócio não tem contato. Quem consome precisa
      // distinguir "autorizado e a caminho" de "autorizado e parado".
      envio_agendado: envioAgendado,
    },
    { requestId },
  );
}
