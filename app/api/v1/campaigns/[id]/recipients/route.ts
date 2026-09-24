/**
 * GET /api/v1/campaigns/:id/recipients — quem recebeu, quem não, e por quê.
 *
 * Paginação keyset server-side: uma campanha de 5.000 não vira 5.000 linhas no
 * browser. O telefone NÃO volta nesta lista — quem opera reconhece a pessoa pelo
 * nome, e devolver o número de todo mundo numa tela de acompanhamento espalha
 * PII sem finalidade. O detalhe do contato tem tela própria.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { codificarCursor, decodificarCursor, listarDestinatariosSchema } from "@/lib/campanhas/schemas";
import { TEXTO_DA_EXCLUSAO } from "@/lib/campanhas/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, contact_id, channel_session_id, status, eligibility_status, exclusion_reason, sent_at, delivered_at, " +
  "read_at, replied_at, opted_out_at, last_error_code, created_at, contacts(name, display_name)";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listarDestinatariosSchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, { requestId });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("campaign_recipients")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("campaign_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.cursor) {
    const c = decodificarCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(`created_at.gt.${c.created_at},and(created_at.eq.${c.created_at},id.gt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1] as { created_at: string; id: string } | undefined;

  return ok(
    pagina.map((l) => ({ ...l, legenda_da_exclusao: rotulo(l.exclusion_reason) })),
    {
      requestId,
      meta: { cursor: temMais && ultima ? codificarCursor(ultima) : null, has_more: temMais },
    },
  );
}

function rotulo(motivo: unknown): string | null {
  if (typeof motivo !== "string") return null;
  return (TEXTO_DA_EXCLUSAO as Record<string, string>)[motivo] ?? motivo;
}
