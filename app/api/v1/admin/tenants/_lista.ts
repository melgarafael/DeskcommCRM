/**
 * O NÚCLEO da listagem de tenants — a ÚNICA resposta para a pergunta "quais
 * instalações existem, filtradas assim" (issue #2777).
 *
 * ─── Por que isto saiu da rota ─────────────────────────────────────────────
 *
 * A rota `GET /api/v1/admin/tenants` e a rota `GET /api/v1/admin/tenants/export`
 * precisam devolver o MESMO conjunto para a MESMA query. Duas cópias do `WHERE`
 * seriam o anti-pattern nº 2 do CLAUDE.md (duplicação sem source of truth
 * declarado) com consequência medida: um filtro consertado num arquivo e não no
 * outro, e o arquivo CSV passando a mentir sobre o que a tela mostra — sem que
 * nenhum dos dois testes ficasse vermelho.
 *
 * Da mesma ideia de `app/api/v1/contacts/_handler.ts`: quem lê é UM, e a rota
 * de export é só outro formato de escrita do mesmo leitor.
 *
 * ─── O que NÃO muda ────────────────────────────────────────────────────────
 *
 * Nada. É o mesmo código que estava no `GET` da listagem, movido: mesmos
 * predicados (`onboarding` é estado DERIVADO, `q` é `ilike` em três colunas),
 * mesma ordenação (`created_at` desc, `id` desc), mesma paginação por cursor e
 * mesmo `limit + 1` que prova `has_more`.
 */
import { z } from "zod";

import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import type { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "suspended", "onboarding", "redacted"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type StatusDeTenant = z.infer<typeof querySchema>["status"];

export interface FiltrosDeTenants {
  q?: string;
  status?: StatusDeTenant;
  cursor?: string;
  limit: number;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A leitura
// ---------------------------------------------------------------------------

export interface PaginaDeTenants {
  page: AdminTenantRow[];
  has_more: boolean;
  nextCursor: string | null;
  /** O erro do PostgREST, quando houver — quem chama decide o status. */
  error: { message: string } | null;
}

export async function listarTenants(
  admin: ReturnType<typeof createAdminClient>,
  filtros: FiltrosDeTenants,
): Promise<PaginaDeTenants> {
  const { q, status, cursor, limit } = filtros;
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  let query = admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      suspended_kind,
      created_at,
      user_count:user_organizations!user_organizations_organization_id_fkey(count),
      conversations_count:conversations(count)
    `,
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (status === "onboarding") {
    // Estado derivado: ativo no banco, onboarding ainda não concluído.
    query = query.eq("status", "active").is("onboarded_at", null);
  } else if (status) {
    query = query.eq("status", status);
  }

  if (q) {
    query = query.or(`display_name.ilike.%${q}%,slug::text.ilike.%${q}%,cnpj.ilike.%${q}%`);
  }

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return { page: [], has_more: false, nextCursor: null, error };

  const rows = (data ?? []) as AdminTenantRow[];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({ created_at: lastRow.created_at, id: lastRow.id })
      : null;

  return { page, has_more, nextCursor, error: null };
}
