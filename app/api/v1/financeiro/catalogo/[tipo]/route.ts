/**
 * O catálogo financeiro: contas, formas de pagamento e plano de contas.
 *
 * ⚠️ COM SESSÃO usa o client de SESSÃO: a RLS já diz quem lê (a organização) e
 * quem escreve (manager+), e repetir a regra aqui criaria uma segunda fonte da
 * mesma verdade. `resolveAuthDual` é só a borda de autenticação.
 *
 * ⚠️ COM TOKEN (`mcp:read`/`mcp:write`, Spec 33 R2) o client é a service role e a
 * RLS deixa de proteger: toda cadeia filtra `organization_id` da linha do
 * token, e as REFERÊNCIAS do corpo (conta, plano de contas, serviço, pessoa)
 * são conferidas na organização antes de gravar. A FK é simples, e o banco
 * aceitaria a conta de outra organização.
 *
 * ⚠️ DELETE INATIVA, não apaga. Conta com lançamento é história; apagá-la
 * deixaria o lançamento órfão ou o levaria junto. É a mesma decisão de
 * `agenda/tipos`, e a razão é igual: o passado não se reescreve porque alguém
 * parou de usar uma forma de pagamento.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import {
  COLUNAS_POR_ENTIDADE,
  type EntidadeDoCatalogo,
  ENTIDADES_DO_CATALOGO,
  ROTULO_DA_ENTIDADE,
  SCHEMA_POR_ENTIDADE,
  ehEntidadeDoCatalogo,
  lerAlteracao,
  temColunaDeMoeda,
} from "@/lib/financeiro/catalogo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

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
  // #1907: `commission_rules` é tabela do módulo `financeiro` (a comanda). Sem ele
  // instalado ela não existe, e este catálogo também não — 404, como as rotas de
  // comandas. As outras entidades são do caixa, que é núcleo.
  if (tipo === "regras_de_comissao" && !(await moduloLigado(createAdminClient(), "financeiro"))) {
    return {
      ok: false as const,
      response: fail("not_found", "Catálogo desconhecido.", 404, { requestId }),
    };
  }
  return { ok: true as const, tipo, tabela: ENTIDADES_DO_CATALOGO[tipo] };
}

/**
 * As colunas do corpo que apontam para outra tabela por FK SIMPLES, e a tabela
 * que elas apontam. Só o ramo do token usa: a sessão tem a RLS do banco.
 */
const REFERENCIAS_DO_CATALOGO: Partial<
  Record<EntidadeDoCatalogo, ReadonlyArray<{ campo: string; tabela: string }>>
> = {
  formas_de_pagamento: [{ campo: "account_id", tabela: "financial_accounts" }],
  recorrencias: [
    { campo: "account_id", tabela: "financial_accounts" },
    { campo: "account_plan_id", tabela: "account_plans" },
  ],
  regras_de_comissao: [{ campo: "event_type_id", tabela: "calendar_event_types" }],
};

/**
 * `true` quando alguma referência do corpo NÃO é da organização. Com a service
 * role a FK aceitaria o id de outra organização, então cada referência
 * presente e não nula é buscada com o filtro de `organization_id`. A pessoa da
 * regra de comissão é conferida pelo vínculo ativo dela com a organização.
 */
async function temReferenciaDeFora(
  db: SupabaseClient,
  organizationId: string,
  tipo: EntidadeDoCatalogo,
  campos: Record<string, unknown>,
): Promise<boolean> {
  for (const { campo, tabela } of REFERENCIAS_DO_CATALOGO[tipo] ?? []) {
    const id = campos[campo];
    if (typeof id !== "string") continue;
    const { data } = await db
      .from(tabela)
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (!data) return true;
  }
  const pessoa = tipo === "regras_de_comissao" ? campos.attendant_user_id : undefined;
  if (typeof pessoa === "string") {
    const { data } = await db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("user_id", pessoa)
      .is("revoked_at", null)
      .maybeSingle();
    if (!data) return true;
  }
  return false;
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  // Leitura do catálogo: sessão OU token `mcp:read`. O papel mínimo é o da sessão.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_catalogo", requestId);
  if (teto) return teto;

  const supabase = authz.supabase;
  // `inativos=1` para quem precisa ver o que saiu de uso — a tela normal não
  // mostra, mas o histórico existe e alguém vai perguntar por ele.
  const incluirInativos = new URL(req.url).searchParams.get("inativos") === "1";
  let q = supabase
    .from(e.tabela)
    .select(COLUNAS_POR_ENTIDADE[e.tipo])
    .eq("organization_id", authz.organizationId)
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

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_catalogo_criar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const atorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const lido = SCHEMA_POR_ENTIDADE[e.tipo].safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }

  const supabase = authz.supabase;

  // ─── A MOEDA É DA ORGANIZAÇÃO, NUNCA DO CORPO (#3379) ──────────────────
  //
  // `financial_accounts.currency` e `recurring_entries.currency` têm
  // `default 'BRL'` no banco, e nenhum dos dois schemas declara o campo: sem
  // esta linha a conta e o molde de uma organização em dólar nasciam em real —
  // e o cron da recorrência copiava essa moeda para cada lançamento do mês, para
  // sempre. O leitor é o mesmo do cadastro de produto (`moedaDaOrganizacao`),
  // porque são a mesma pergunta: qual é a moeda desta organização.
  const linha: Record<string, unknown> = {
    ...lido.data,
    organization_id: authz.organizationId,
  };
  // Só o token precisa desta conferência: a sessão passa pela RLS do banco.
  if (authz.via === "token" && (await temReferenciaDeFora(supabase, authz.organizationId, e.tipo, lido.data))) {
    return fail("validation_failed", t("A conta informada não existe nesta organização."), 422, {
      requestId,
    });
  }
  if (temColunaDeMoeda(e.tipo)) linha.currency = await moedaDaOrganizacao(supabase, authz.organizationId);

  const { data, error } = await supabase
    .from(e.tabela)
    .insert(linha)
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
    actorUserId: atorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
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

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_catalogo_alterar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const atorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const corpo = await req.json().catch(() => ({}));
  const base = alterarSchema.safeParse(corpo);
  if (!base.success) return fail("validation_failed", t("id inválido."), 422, { requestId });

  // Cada campo opcional: alterar um não obriga a reenviar os outros. E só o que
  // veio no corpo é gravado — ver `lerAlteracao`.
  const { id: _id, ...resto } = corpo as Record<string, unknown>;
  const lido = lerAlteracao(e.tipo, resto);
  if (!lido.ok) return fail("validation_failed", t(lido.mensagem), 422, { requestId });
  const campos = lido.campos;
  if (Object.keys(campos).length === 0) {
    return fail("validation_failed", t("Nenhum campo para alterar."), 422, { requestId });
  }

  const supabase = authz.supabase;
  if (authz.via === "token" && (await temReferenciaDeFora(supabase, authz.organizationId, e.tipo, campos))) {
    return fail("validation_failed", t("A conta informada não existe nesta organização."), 422, {
      requestId,
    });
  }
  const { data, error } = await supabase
    .from(e.tabela)
    .update(campos)
    .eq("id", base.data.id)
    .eq("organization_id", authz.organizationId)
    .select(COLUNAS_POR_ENTIDADE[e.tipo])
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", `${t(ROTULO_DA_ENTIDADE[e.tipo])}: ${t("esse nome já existe.")}`, 409, {
        requestId,
      });
    }
    // Os mesmos da criação: 23503 é conta de outra organização (ou inexistente),
    // 23514 é a regra de comissão que ficaria sem alvo. Recusa, não erro.
    if (error.code === "23503") {
      return fail("validation_failed", t("A conta informada não existe nesta organização."), 422, {
        requestId,
      });
    }
    if (error.code === "23514") {
      return fail("validation_failed", t("Escolha ao menos uma pessoa ou um serviço."), 422, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) return fail("not_found", t("Não encontrado."), 404, { requestId });

  void audit({
    action: "financeiro.catalogo_alterado",
    actorUserId: atorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: e.tabela,
    resourceId: base.data.id,
    requestId,
    metadata: { tipo: e.tipo, campos: Object.keys(campos) },
  });

  return ok(data, { requestId });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const e = await entidade(ctx, requestId);
  if (!e.ok) return e.response;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_catalogo_inativar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const atorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const lido = z
    .object({ id: z.string().uuid() })
    .safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("id inválido."), 422, { requestId });

  // INATIVA. Ver o cabeçalho: o passado não se reescreve.
  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from(e.tabela)
    .update({ is_active: false })
    .eq("id", lido.data.id)
    .eq("organization_id", authz.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Não encontrado."), 404, { requestId });

  void audit({
    action: "financeiro.catalogo_inativado",
    actorUserId: atorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: e.tabela,
    resourceId: lido.data.id,
    requestId,
    metadata: { tipo: e.tipo },
  });

  return ok({ id: lido.data.id, is_active: false }, { requestId });
}
