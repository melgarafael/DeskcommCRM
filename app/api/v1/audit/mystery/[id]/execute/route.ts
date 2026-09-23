import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { sendMessageSchema } from "@/lib/schemas/messaging";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

type Criteria = {
  opening_message?: string;
  speed?: boolean;
  politeness?: boolean;
  objection_handling?: boolean;
  closing?: boolean;
};

export async function POST(_request: Request, context: Context) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  const org = await resolveActiveOrg(user);
  if (!org)
    return NextResponse.json({ error: "Organização ativa não encontrada." }, { status: 400 });
  if (org.role !== "admin" && !user.is_platform_admin) {
    return NextResponse.json(
      { error: "Somente administradores podem executar auditorias." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  const db = createAdminClient();
  const { data: scenario, error: scenarioError } = await db
    .from("audit_mystery_scenarios")
    .select("*")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (scenarioError) return NextResponse.json({ error: scenarioError.message }, { status: 500 });
  if (!scenario) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });
  if (!scenario.is_active)
    return NextResponse.json({ error: "Ative o cenário antes de executar." }, { status: 409 });

  const criteria = (scenario.evaluation_criteria ?? {}) as Criteria;
  const openingMessage = criteria.opening_message?.trim();
  if (!scenario.target_channel_session_id || !scenario.target_phone || !openingMessage) {
    return NextResponse.json(
      { error: "Complete o canal, o número auditado e a primeira mensagem antes de executar." },
      { status: 422 },
    );
  }

  const { data: execution, error: executionError } = await db
    .from("audit_mystery_executions")
    .insert({
      organization_id: org.orgId,
      scenario_id: scenario.id,
      status: "pending",
      transcript: [],
    })
    .select()
    .single();

  if (executionError || !execution) {
    return NextResponse.json(
      { error: executionError?.message ?? "Não foi possível abrir a execução." },
      { status: 500 },
    );
  }

  try {
    const opened = await openSharedContactConversation(db, org.orgId, {
      channel_session_id: scenario.target_channel_session_id,
      phone_number: scenario.target_phone,
      name: scenario.persona_name,
    });
    const input = sendMessageSchema.parse({
      conversation_id: opened.conversation_id,
      type: "text",
      body: openingMessage,
    });
    const message = await sendMessageHandler(
      db,
      {
        organization_id: org.orgId,
        actor: { type: "user", id: user.id, role: org.role },
        requestId,
        idioma: user.idioma,
      },
      input,
    );

    const transcript = [
      {
        direction: "outbound",
        body: openingMessage,
        sent_at: message.sent_at ?? new Date().toISOString(),
        message_id: message.id,
        conversation_id: opened.conversation_id,
      },
    ];
    const { data: updated, error: updateError } = await db
      .from("audit_mystery_executions")
      .update({ status: "running", messages_exchanged: 1, transcript })
      .eq("id", execution.id)
      .eq("organization_id", org.orgId)
      .select()
      .single();
    if (updateError) throw updateError;

    return NextResponse.json(
      {
        execution: updated,
        conversation_id: opened.conversation_id,
        message_id: message.id,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao enviar a primeira mensagem.";
    await db
      .from("audit_mystery_executions")
      .update({ status: "failed", ai_feedback: message, completed_at: new Date().toISOString() })
      .eq("id", execution.id)
      .eq("organization_id", org.orgId);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
