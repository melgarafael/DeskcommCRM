import { type NextRequest } from "next/server";
import { z } from "zod";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  tenant_id: z.string().uuid().optional(),
  role: z.enum(["viewer", "agent", "manager", "admin"]).optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  last_sign_in_at: string | null;
  user_id: string;
  organization_id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { tenant_id, role, q, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  // O join com `auth.users` acontece em memória, não no Postgres: `auth` não é
  // um dos schemas expostos ao PostgREST (`supabase/config.toml` expõe `public`,
  // `storage` e `graphql_public`), então qualquer `.schema("auth")` responde
  // PGRST106 "Invalid schema: auth" mesmo com service role. O vínculo vem do
  // PostgREST; email, nome e último login vêm do GoTrue (Auth Admin API).

  // Step 1: query user_organizations + organizations
  type UoRow = {
    user_id: string;
    organization_id: string;
    role: string;
    accepted_at: string | null;
    revoked_at: string | null;
    organizations: {
      display_name: string;
      slug: string;
    } | null;
  };

  let uoQuery = admin
    .from("user_organizations")
    .select(
      `
      user_id,
      organization_id,
      role,
      accepted_at,
      revoked_at,
      organizations!user_organizations_organization_id_fkey!inner(display_name, slug)
    `,
    )
    .order("user_id", { ascending: false });

  if (tenant_id) {
    uoQuery = uoQuery.eq("organization_id", tenant_id);
  }
  if (role) {
    uoQuery = uoQuery.eq("role", role);
  }

  const { data: uoRows, error: uoError } = await uoQuery;

  if (uoError) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: uoError.message,
    });
  }

  if (!uoRows || uoRows.length === 0) {
    void audit({
      action: "platform_admin.users_listed",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      requestId,
      metadata: { filters: { tenant_id, role, has_q: !!q }, result_count: 0 },
    });
    return ok([], { requestId, meta: { has_more: false, cursor: null } });
  }

  // Step 2: get unique user IDs
  const userIds = [...new Set((uoRows as unknown as UoRow[]).map((r) => r.user_id))];

  // Step 3: fetch auth users via the Auth Admin API.
  //
  // Varredura paginada do diretório, NÃO um `getUserById` por vínculo. O
  // fan-out custava um request HTTP por vínculo, todos concorrentes, e o número
  // deles não é o tamanho da página — o `limit` só corta no Step 8. Medido na
  // revisão do PR, em localhost com 300 vínculos: 214 respostas 504 em 12,2s.
  //
  // O trade-off é banda por número de requests: `listUsers` baixa o diretório
  // inteiro (inclusive quem não tem vínculo nesta busca), mas num punhado de
  // requests SEQUENCIAIS em vez de N concorrentes — e esse punhado depende do
  // tamanho do diretório, não do número de vínculos. É a troca certa para o
  // perfil do produto (self-host de PME, diretório na casa das dezenas a
  // centenas). O servidor pode reduzir o `perPage` pedido; a varredura não
  // depende disso: ela para na primeira página vazia, ou antes, assim que todos
  // os ids necessários apareceram.
  type AuthUser = {
    id: string;
    email: string | null;
    last_sign_in_at: string | null;
    created_at: string;
    raw_user_meta_data: Record<string, unknown> | null;
  };

  const needed = new Set(userIds);
  const authMap = new Map<string, AuthUser>();
  const PER_PAGE = 1000;
  // Teto defensivo: as paradas naturais da varredura são a página vazia e o
  // mapa completo, e este é o terceiro fim (o erro do GoTrue, logo abaixo, é o
  // quarto).
  //
  // A condição exata é "a página MAX_PAGES veio NÃO-VAZIA e ainda falta id", que
  // NÃO é o mesmo que "o diretório é maior que MAX_PAGES × PER_PAGE". Um
  // diretório com exatamente MAX_PAGES páginas não-vazias e um vínculo órfão
  // (usuário removido do Auth) cai aqui igual: a varredura nunca chega a ver a
  // página vazia que provaria o fim, e não há como saber qual dos dois mundos é
  // o de fora — `listUsers` só preenche `total` quando a resposta traz header
  // Link, e lê `lastPage` com `.substring(0, 1)` (@supabase/auth-js 2.111.0).
  //
  // Sem como distinguir, a rota falha alto: entregar a lista como se estivesse
  // completa é o erro caro (some um usuário que existe, e ninguém fica sabendo).
  // O que ela não pode é afirmar a causa que não mediu — daí a mensagem falar da
  // varredura, e não do tamanho do diretório, e o `details` levar quantos
  // vínculos ficaram sem resolver: 1 num diretório grande cheira a órfão,
  // centenas cheiram a truncamento.
  const MAX_PAGES = 50;
  let authPage = 1;
  let directoryExhausted = false;

  while (authMap.size < needed.size && !directoryExhausted) {
    const res = await admin.auth.admin.listUsers({
      page: authPage,
      perPage: PER_PAGE,
    });

    if (res.error) {
      // O GoTrue devolve AuthRetryableFetchError SEM lançar em 504/500/socket
      // fechado. Tratar isso como "usuário não existe" transformava
      // indisponibilidade em "Nenhum usuário encontrado" — indistinguível de
      // banco vazio, e uma regressão silenciosa em cima do 500 explícito que a
      // rota dava antes.
      return fail("upstream_unavailable", "Auth indisponível", 503, {
        requestId,
        details: res.error.message,
      });
    }

    for (const u of res.data.users) {
      if (!needed.has(u.id)) continue;
      authMap.set(u.id, {
        id: u.id,
        email: u.email ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        created_at: u.created_at,
        raw_user_meta_data:
          (u.user_metadata as Record<string, unknown> | null) ?? null,
      });
    }

    // Página vazia = fim do diretório. Não usamos `nextPage`: o auth-js o
    // deriva do header Link com `.substring(0, 1)` (`GoTrueAdminApi.listUsers`,
    // @supabase/auth-js 2.111.0), então da página 10 em diante ele lê "1" e a
    // varredura andaria para trás.
    if (res.data.users.length === 0) {
      directoryExhausted = true;
      break;
    }
    // O teto só é falha se ainda falta id para resolver. Um diretório com
    // exatamente MAX_PAGES páginas não-vazias cujo último id necessário está na
    // última delas deixa o mapa COMPLETO: nada foi truncado, e derrubar a
    // listagem aqui seria reprovar quem terminou em cima da fronteira.
    if (authMap.size < needed.size && authPage >= MAX_PAGES) {
      const pendentes = needed.size - authMap.size;
      return fail(
        "upstream_unavailable",
        "Varredura do diretório de usuários atingiu o teto de páginas sem resolver todos os vínculos",
        503,
        {
          requestId,
          details: `scanned ${MAX_PAGES} pages of ${PER_PAGE}; ${pendentes} of ${needed.size} link(s) unresolved`,
        },
      );
    }
    authPage += 1;
  }

  // Step 4: build joined rows
  type JoinedRow = {
    user_id: string;
    organization_id: string;
    role: string;
    accepted_at: string | null;
    revoked_at: string | null;
    tenant_name: string;
    tenant_slug: string;
    email: string | null;
    full_name: string | null;
    last_sign_in_at: string | null;
    created_at: string;
  };

  let joined: JoinedRow[] = (uoRows as unknown as UoRow[]).flatMap((uo) => {
    const u = authMap.get(uo.user_id);
    // Chegar aqui sem usuário só é possível depois de o diretório inteiro ter
    // sido varrido com sucesso (erro do GoTrue já abortou lá em cima): é um
    // vínculo apontando para usuário removido do Auth, e some da lista.
    if (!u) return [];
    const org = uo.organizations;
    if (!org) return [];
    return [
      {
        user_id: uo.user_id,
        organization_id: uo.organization_id,
        role: uo.role,
        accepted_at: uo.accepted_at,
        revoked_at: uo.revoked_at,
        tenant_name: org.display_name,
        tenant_slug: org.slug,
        email: u.email ?? null,
        full_name:
          (u.raw_user_meta_data?.full_name as string | undefined) ?? null,
        last_sign_in_at: u.last_sign_in_at,
        created_at: u.created_at,
      },
    ];
  });

  // Step 5: apply q filter (email or full_name ilike)
  if (q) {
    const lq = q.toLowerCase();
    joined = joined.filter(
      (r) =>
        r.email?.toLowerCase().includes(lq) ||
        r.full_name?.toLowerCase().includes(lq),
    );
  }

  // Step 6: sort by last_sign_in_at desc nulls last, then user_id+org_id
  joined.sort((a, b) => {
    if (!a.last_sign_in_at && !b.last_sign_in_at) {
      return a.user_id < b.user_id ? -1 : 1;
    }
    if (!a.last_sign_in_at) return 1;
    if (!b.last_sign_in_at) return -1;
    const diff =
      new Date(b.last_sign_in_at).getTime() -
      new Date(a.last_sign_in_at).getTime();
    if (diff !== 0) return diff;
    const uid = a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
    if (uid !== 0) return uid;
    return a.organization_id < b.organization_id ? -1 : 1;
  });

  // Step 7: apply cursor
  if (cursorPayload) {
    const { last_sign_in_at: cLsi, user_id: cUid, organization_id: cOid } =
      cursorPayload;
    const cursorIdx = joined.findIndex(
      (r) =>
        r.last_sign_in_at === cLsi &&
        r.user_id === cUid &&
        r.organization_id === cOid,
    );
    if (cursorIdx !== -1) {
      joined = joined.slice(cursorIdx + 1);
    }
  }

  // Step 8: paginate
  const has_more = joined.length > limit;
  const page = has_more ? joined.slice(0, limit) : joined;
  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({
          last_sign_in_at: lastRow.last_sign_in_at,
          user_id: lastRow.user_id,
          organization_id: lastRow.organization_id,
        })
      : null;

  void audit({
    action: "platform_admin.users_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: { tenant_id, role, has_q: !!q },
      result_count: page.length,
    },
  });

  return ok(page, { requestId, meta: { has_more, cursor: nextCursor } });
}
