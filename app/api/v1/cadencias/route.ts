/**
 * GET  /api/v1/cadencias — a lista, para montar E para escolher onde inscrever
 *      um lead. Por isso o papel mínimo é `agent`, não `manager`: quem vende
 *      precisa ver quais cadências existem antes de poder pôr um lead numa.
 * POST /api/v1/cadencias — cria um rascunho. Montar é `manager`+ (mesmo corte
 *      de `campaigns`, migration 0375): sequência de e-mail em massa não é
 *      gesto de `agent`.
 *
 * Paginação: keyset sobre (updated_at DESC, id DESC), mesmo formato de
 * `campaigns`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { configuracaoPadrao } from "@/lib/cadencias/exemplos";
import { criarCadenciaSchema, listarCadenciasSchema } from "@/lib/cadencias/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS_DA_LISTA =
  "id, name, status, configuracao, versao, created_at, updated_at, created_by, updated_by";

function codificarCursor(row: { updated_at: string; id: string }): string {
  return Buffer.from(JSON.stringify(row)).toString("base64url");
}

function decodificarCursor(cursor: string): { updated_at: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof v?.updated_at === "string" && typeof v?.id === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listarCadenciasSchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, { requestId, details: parsed.error.flatten() });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("email_cadences")
    .select(COLUNAS_DA_LISTA)
    .eq("organization_id", authz.org.orgId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.cursor) {
    const c = decodificarCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(`updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1] as { updated_at: string; id: string } | undefined;

  return ok(pagina, {
    requestId,
    meta: { cursor: temMais && ultima ? codificarCursor(ultima) : null, has_more: temMais },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarCadenciaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  // Client ADMIN na escrita: `authenticated` só tem SELECT na 0428 (mesmo
  // corte de `campaigns`, 0375) — o servidor escreve, com `org.orgId` do
  // `requireRole()`, nunca do corpo.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("email_cadences")
    .insert({
      organization_id: org.orgId,
      name: entrada.name,
      status: "rascunho",
      configuracao: { ...configuracaoPadrao(), tagDoSegmento: entrada.tagDoSegmento ?? "" },
      passos: [],
      created_by: user.id,
      updated_by: user.id,
    })
    .select(COLUNAS_DA_LISTA)
    .single();
  if (error || !data) {
    return fail("internal_error", error?.message ?? t("Não foi possível criar a cadência."), 500, { requestId });
  }

  const criada = data as unknown as { id: string };
  void audit({
    action: "cadencia.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "email_cadence",
    resourceId: criada.id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
