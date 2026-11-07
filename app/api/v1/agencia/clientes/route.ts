import { criarClienteAgenciaSchema } from "@/lib/agencias/schema";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import { requireAgencia } from "@/lib/agencias/require-agencia";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";

const querySchema = z
  .object({ pagina: z.coerce.number().int().min(1).max(10000).default(1) })
  .strict();
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!input.success) return fail("validation_error", "Página inválida.", 422, { requestId });
  const auth = await requireAgencia(requestId);
  if (!auth.ok) return auth.response;
  const inicio = (input.data.pagina - 1) * 30;
  // RLS e predicado explícito: nunca se devolvem vínculos de outras agências.
  const [vinculos, configuracao] = await Promise.all([
    auth.db
      .from("agencia_clientes")
      .select("organization_id, created_at", { count: "exact" })
      .eq("agencia_id", auth.org.orgId)
      .order("created_at", { ascending: false })
      .order("organization_id")
      .range(inicio, inicio + 29),
    auth.db
      .from("agencia_configuracoes")
      .select("limite_clientes")
      .eq("organization_id", auth.org.orgId)
      .single(),
  ]);
  if (vinculos.error || configuracao.error)
    return fail("upstream_unavailable", "Não foi possível carregar os clientes.", 503, {
      requestId,
    });
  const ids = (vinculos.data ?? []).map((v) => v.organization_id);
  // Os ids vêm exclusivamente da leitura RLS acima, nunca do pedido.
  const orgs = ids.length
    ? await createAdminClient()
        .from("organizations")
        .select("id, display_name, slug, status")
        .in("id", ids)
    : { data: [], error: null };
  if (orgs.error)
    return fail("upstream_unavailable", "Não foi possível carregar os clientes.", 503, {
      requestId,
    });
  const porId = new Map((orgs.data ?? []).map((org) => [org.id, org]));
  return ok(
    {
      clientes: ids.map((id) => porId.get(id)).filter(Boolean),
      utilizadas: vinculos.count ?? 0,
      limite_clientes: configuracao.data.limite_clientes,
      pagina: input.data.pagina,
      tem_mais: (vinculos.count ?? 0) > inicio + 30,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const input = criarClienteAgenciaSchema.safeParse(await req.json().catch(() => null));
  const key = z.string().uuid().safeParse(req.headers.get("Idempotency-Key"));
  if (!input.success || !key.success)
    return fail(
      "validation_error",
      "Informe nome, identificador e chave de criação válidos.",
      422,
      { requestId },
    );
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireAgencia(requestId);
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.db.rpc("fn_agencia_criar_cliente", {
    p_agencia: auth.org.orgId,
    p_chave: key.data,
    p_nome: input.data.display_name,
    p_slug: input.data.slug,
  });
  if (error) {
    const message = error.message.includes("agencia_limite_atingido")
      ? "O limite de organizações clientes foi atingido."
      : error.message.includes("agencia_cobranca_exige_plataforma")
        ? "Com cobrança ativa, a criação exige uma política comercial definida pela plataforma."
        : "Não foi possível criar o cliente. Confira o identificador e sua autorização.";
    return fail("conflict", message, 409, { requestId });
  }
  if (data.created)
    await audit({
      action: "agency.client_created",
      actorUserId: auth.user.id,
      organizationId: data.id,
      resourceType: "organization",
      resourceId: data.id,
      requestId,
      metadata: { agency_id: auth.org.orgId },
    });
  return ok(data, { status: data.created ? 201 : 200, requestId });
}
