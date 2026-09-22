import { NextResponse } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function authorize() {
  const user = await loadAuthUser();
  if (!user) return { error: NextResponse.json({ error: "Não autenticado." }, { status: 401 }) };
  const org = await resolveActiveOrg(user);
  if (!org)
    return {
      error: NextResponse.json({ error: "Organização ativa não encontrada." }, { status: 400 }),
    };
  if (org.role !== "admin" && !user.is_platform_admin) {
    return {
      error: NextResponse.json(
        { error: "Somente administradores podem alterar auditorias." },
        { status: 403 },
      ),
    };
  }
  return { user, org };
}

export async function PATCH(request: Request, context: Context) {
  try {
    const auth = await authorize();
    if ("error" in auth) return auth.error;
    const { id } = await context.params;
    const body = await request.json();
    const update: Record<string, unknown> = {};
    const fields = [
      "title",
      "persona_name",
      "persona_description",
      "objective",
      "target_channel_session_id",
      "target_phone",
      "evaluation_criteria",
      "is_active",
    ] as const;

    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) update[field] = body[field];
    }
    update.updated_at = new Date().toISOString();

    if (typeof update.title === "string" && !update.title.trim()) {
      return NextResponse.json({ error: "O nome do cenário é obrigatório." }, { status: 400 });
    }

    const { data, error } = await createAdminClient()
      .from("audit_mystery_scenarios")
      .update(update)
      .eq("id", id)
      .eq("organization_id", auth.org.orgId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });
    return NextResponse.json({ scenario: data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível atualizar o cenário." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const auth = await authorize();
    if ("error" in auth) return auth.error;
    const { id } = await context.params;
    const { data, error } = await createAdminClient()
      .from("audit_mystery_scenarios")
      .delete()
      .eq("id", id)
      .eq("organization_id", auth.org.orgId)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });
    return NextResponse.json({ deleted: true, id: data.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Não foi possível excluir o cenário." },
      { status: 500 },
    );
  }
}
