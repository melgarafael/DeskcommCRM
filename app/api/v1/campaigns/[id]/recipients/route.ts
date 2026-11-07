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

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import {
  codificarCursor,
  decodificarCursor,
  listarDestinatariosSchema,
} from "@/lib/campanhas/schemas";
import { codigoDaPlataforma, fraseDaFalha } from "@/lib/channels/erro-da-plataforma";
import { TEXTO_DA_EXCLUSAO } from "@/lib/campanhas/tipos";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

// Sem o embed de `contacts`: o ramo do token junta o nome em consulta própria
// (ver `juntarContatos`). A sessão segue com o embed, como sempre foi.
const COLUNAS_SEM_CONTATO =
  "id, contact_id, channel_session_id, status, eligibility_status, exclusion_reason, sent_at, delivered_at, " +
  "read_at, replied_at, opted_out_at, last_error_code, last_error_detail, created_at";
const COLUNAS = `${COLUNAS_SEM_CONTATO}, contacts(name, display_name)`;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaigns",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaigns_destinatarios", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  const { id } = await ctx.params;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listarDestinatariosSchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, { requestId });
  }
  const q = parsed.data;

  const supabase = authz.supabase;
  let query = supabase
    .from("campaign_recipients")
    .select(authz.via === "token" ? COLUNAS_SEM_CONTATO : COLUNAS)
    .eq("organization_id", org.orgId)
    .eq("campaign_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.cursor) {
    const c = decodificarCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(
      `created_at.gt.${c.created_at},and(created_at.eq.${c.created_at},id.gt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const brutas = (data ?? []) as unknown as Array<Record<string, unknown>>;
  let linhas = brutas;
  if (authz.via === "token") {
    const juntadas = await juntarContatos(supabase, org.orgId, brutas);
    if (!juntadas.ok) return fail("internal_error", juntadas.erro, 500, { requestId });
    linhas = juntadas.linhas;
  }
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1] as { created_at: string; id: string } | undefined;

  return ok(
    pagina.map((l) => ({
      ...l,
      legenda_da_exclusao: rotulo(l.exclusion_reason),
      // A falha em frase, quando a plataforma disse por quê (131050, 131049…):
      // "falhou" sozinho não diz se tentar de novo adianta.
      motivo_da_falha:
        l.status === "failed"
          ? fraseDaFalha(
              codigoDaPlataforma(
                l.last_error_code as string | null,
                l.last_error_detail as string | null,
              ),
              l.last_error_detail as string | null,
            )
          : null,
    })),
    {
      requestId,
      meta: { cursor: temMais && ultima ? codificarCursor(ultima) : null, has_more: temMais },
    },
  );
}

/**
 * O nome do contato para o ramo do token, sem embed: uma consulta à própria
 * `contacts`, filtrada pela organização, e o mesmo formato que o embed devolvia
 * (`{ name, display_name }` ou `null`).
 */
async function juntarContatos(
  db: SupabaseClient,
  organizationId: string,
  linhas: Array<Record<string, unknown>>,
): Promise<{ ok: true; linhas: Array<Record<string, unknown>> } | { ok: false; erro: string }> {
  const ids = [
    ...new Set(linhas.map((l) => l.contact_id).filter((v): v is string => typeof v === "string")),
  ];
  const porId = new Map<string, { name: string | null; display_name: string | null }>();
  if (ids.length > 0) {
    const { data, error } = await db
      .from("contacts")
      .select("id, name, display_name")
      .eq("organization_id", organizationId)
      .in("id", ids);
    if (error) return { ok: false, erro: error.message };
    for (const c of (data ?? []) as Array<{ id: string; name: string | null; display_name: string | null }>) {
      porId.set(c.id, { name: c.name, display_name: c.display_name });
    }
  }
  return {
    ok: true,
    linhas: linhas.map((l) => ({ ...l, contacts: porId.get(String(l.contact_id)) ?? null })),
  };
}

function rotulo(motivo: unknown): string | null {
  if (typeof motivo !== "string") return null;
  return (TEXTO_DA_EXCLUSAO as Record<string, string>)[motivo] ?? motivo;
}
