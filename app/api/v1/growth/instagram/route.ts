import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await loadAuthUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const activeOrg = await resolveActiveOrg(user);
    if (!activeOrg) return NextResponse.json({ error: "No active org" }, { status: 400 });

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("growth_instagram_triggers")
      .select("*")
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ triggers: data ?? [] });
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
      name,
      post_id,
      post_permalink,
      post_thumbnail,
      keywords,
      match_mode,
      dm_response_template,
      auto_create_lead,
      pipeline_id,
      pipeline_stage_id,
      lead_tags,
    } = body;

    if (!name || !dm_response_template) {
      return NextResponse.json(
        { error: "Nome e template de resposta da DM são obrigatórios." },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("growth_instagram_triggers")
      .insert({
        organization_id: activeOrg.orgId,
        name,
        post_id: post_id || null,
        post_permalink: post_permalink || null,
        post_thumbnail: post_thumbnail || null,
        keywords: Array.isArray(keywords) ? keywords : [keywords].filter(Boolean),
        match_mode: match_mode || "contains",
        dm_response_template,
        auto_create_lead: auto_create_lead ?? true,
        pipeline_id: pipeline_id || null,
        pipeline_stage_id: pipeline_stage_id || null,
        lead_tags: Array.isArray(lead_tags) ? lead_tags : [],
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ trigger: data }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
