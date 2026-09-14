/**
 * O catálogo financeiro: contas, formas de pagamento e plano de contas.
 *
 * ⚠️ USA O CLIENT DE SESSÃO, nunca o admin. A RLS já diz quem lê (a organização)
 * e quem escreve (manager+), e repetir a regra aqui criaria uma segunda fonte da
 * mesma verdade — a que roda em TypeScript seria a pior das duas. `requireRole`
 * é só a borda de autenticação.
 *
 * ⚠️ DELETE INATIVA, não apaga. Conta com lançamento é história; apagá-la
 * deixaria o lançamento órfão ou o levaria junto. É a mesma decisão de
 * `agenda/tipos`, e a razão é igual: o passado não se reescreve porque alguém
 * parou de usar uma forma de pagamento.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_POR_ENTIDADE,
  ENTIDADES_DO_CATALOGO,
  ROTULO_DA_ENTIDADE,
  SCHEMA_POR_ENTIDADE,
  ehEntidadeDoCatalogo,
} from "@/lib/financeiro/catalogo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tipo: string }> };

/** Resolve a entidade do path, ou devolve a resposta de recusa. */
async function entidade(ctx: Ctx, requestId: string) {
  const { tipo } = await ctx.params;
  if (!ehEntidadeDoCatalogo(tipo)) {
    return {
      ok: false as const,
      response: fail("not_found", "Catálogo desconhecido.", 404, { requestId }),
    };
  }
  return { ok: true as const, tipo, tabela: ENTIDADES_DO_CATALOGO[tipo] };
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  // `inativos=1` para quem precisa ver o que saiu de uso — a tela normal não
  // mostra, mas o histórico existe e alguém vai perguntar por ele.
  const incluirInativos = new URL(req.url).searchParams.get("inativos") === "1";
  let q = supabase
    .from(e.tabela)
    .select(COLUNAS_POR_ENTIDADE[e.tipo])
    .eq("organization_id", authz.org.orgId)
    .order("name", { ascending: true })
    .limit(500);
  if (!incluirInativos) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  const authz = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = SCHEMA_POR_ENTIDADE[e.tipo].safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from(e.tabela)
    .insert({ ...lido.data, organization_id: authz.org.orgId })
    .select(COLUNAS_POR_ENTIDADE[e.tipo])
    .single();

  if (error) {
    // 23505 é o nome repetido entre os ATIVOS — recusa esperada, não erro.
    if (error.code === "23505") {
      return fail("conflict", `${t(ROTULO_DA_ENTIDADE[e.tipo])}: ${t("esse nome já existe.")}`, 409, {
        requestId,
      });
    }
    // 23503 é a FK: forma de pagamento apontando para conta que não é da
    // organização, ou que não existe.
    if (error.code === "23503") {
      return fail("validation_failed", t("A conta informada não existe nesta organização."), 422, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "financeiro.catalogo_criado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: e.tabela,
    // ⚠️ Cast por `unknown`: `lib/database.types.ts` ainda não conhece estas
    // três tabelas, porque ele é gerado a partir de um banco que já tem a
    // migration aplicada — e ela nasce neste mesmo PR. Regenerar os tipos é o
    // passo seguinte ao merge, e aí estes casts saem. Registrado aqui para não
    // virar `any` esquecido.
    resourceId: (data as unknown as { id: string }).id,
    requestId,
    metadata: { tipo: e.tipo, nome: lido.data.name },
  });

  return ok(data, { requestId, status: 201 });
}

const alterarSchema = z.object({ id: z.string().uuid() }).passthrough();

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  const authz = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const corpo = await req.json().catch(() => ({}));
  const base = alterarSchema.safeParse(corpo);
  if (!base.success) return fail("validation_failed", t("id inválido."), 422, { requestId });

  // `.partial()` sobre o schema da entidade: alterar um campo não obriga a
  // reenviar os outros, e um campo desconhecido é recusado em vez de ignorado.
  const { id: _id, ...resto } = corpo as Record<string, unknown>;
  const campos = SCHEMA_POR_ENTIDADE[e.tipo].partial().safeParse(resto);
  if (!campos.success) {
    return fail("validation_failed", t(campos.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }
  if (Object.keys(campos.data).length === 0) {
    return fail("validation_failed", t("Nenhum campo para alterar."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from(e.tabela)
    .update(campos.data)
    .eq("id", base.data.id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_POR_ENTIDADE[e.tipo])
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", `${t(ROTULO_DA_ENTIDADE[e.tipo])}: ${t("esse nome já existe.")}`, 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) return fail("not_found", t("Não encontrado."), 404, { requestId });

  void audit({
    action: "financeiro.catalogo_alterado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: e.tabela,
    resourceId: base.data.id,
    requestId,
    metadata: { tipo: e.tipo, campos: Object.keys(campos.data) },
  });

  return ok(data, { requestId });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  const authz = await requireRole("manager", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = z
    .object({ id: z.string().uuid() })
    .safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("id inválido."), 422, { requestId });

  // INATIVA. Ver o cabeçalho: o passado não se reescreve.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(e.tabela)
    .update({ is_active: false })
    .eq("id", lido.data.id)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Não encontrado."), 404, { requestId });

  void audit({
    action: "financeiro.catalogo_inativado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: e.tabela,
    resourceId: lido.data.id,
    requestId,
    metadata: { tipo: e.tipo },
  });

  return ok({ id: lido.data.id, is_active: false }, { requestId });
}
