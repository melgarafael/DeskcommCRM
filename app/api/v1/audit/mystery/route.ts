import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await loadAuthUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const activeOrg = await resolveActiveOrg(user);
    if (!activeOrg) return NextResponse.json({ error: "No active org" }, { status: 400 });

    const supabase = await createServerClient();
    const { data: scenarios, error: sErr } = await supabase
      .from("audit_mystery_scenarios")
      .select("*, audit_mystery_executions(*)")
      .eq("organization_id", activeOrg.id)
      .order("created_at", { ascending: false });

    if (sErr) throw sErr;
    return NextResponse.json({ scenarios: scenarios ?? [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await loadAuthUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const activeOrg = await resolveActiveOrg(user);
    if (!activeOrg) return NextResponse.json({ error: "No active org" }, { status: 400 });

    const body = await req.json();
    const {
      title,
      persona_name,
      persona_description,
      objective,
      target_channel_session_id,
      target_phone,
      evaluation_criteria,
    } = body;

    if (!title || !persona_name || !objective) {
      return NextResponse.json(
        { error: "Título, nome da persona e objetivo são obrigatórios." },
        { status: 400 }
      );
    }

    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from("audit_mystery_scenarios")
      .insert({
        organization_id: activeOrg.id,
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
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ scenario: data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
