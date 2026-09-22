import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: Request) {
  try {
    const user = await loadAuthUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const activeOrg = await resolveActiveOrg(user);
    if (!activeOrg) return NextResponse.json({ error: "No active org" }, { status: 400 });

    const supabase = createAdminClient();
    const { data: scenarios, error: sErr } = await supabase
      .from("audit_mystery_scenarios")
      .select("*, audit_mystery_executions(*)")
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false });

    if (sErr) throw sErr;
    return NextResponse.json({ scenarios: scenarios ?? [] });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Não foi possível carregar as auditorias." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await loadAuthUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const activeOrg = await resolveActiveOrg(user);
    if (!activeOrg) return NextResponse.json({ error: "No active org" }, { status: 400 });
    if (activeOrg.role !== "admin" && !user.is_platform_admin) {
      return NextResponse.json(
        { error: "Somente administradores podem criar auditorias." },
        { status: 403 },
      );
    }

    const body = await req.json();
    const {
      title,
      persona_name,
      persona_description,
      objective,
      target_channel_session_id,
      target_phone,
      evaluation_criteria,
      is_active,
    } = body;

    if (!title || !persona_name || !objective) {
      return NextResponse.json(
        { error: "Título, nome da persona e objetivo são obrigatórios." },
        { status: 400 },
      );
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("audit_mystery_scenarios")
      .insert({
        organization_id: activeOrg.orgId,
        title,
        persona_name,
        persona_description: persona_description || "",
        objective,
        target_channel_session_id: target_channel_session_id || null,
        target_phone: target_phone || null,
        evaluation_criteria: evaluation_criteria || {
          speed: true,
          politeness: true,
          objection_handling: true,
          closing: true,
        },
        is_active: is_active ?? true,
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ scenario: data }, { status: 201 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Não foi possível criar a auditoria." },
      { status: 500 },
    );
  }
}
