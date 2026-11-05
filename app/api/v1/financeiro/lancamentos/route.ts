/**
 * OS LANÇAMENTOS — o dinheiro que não veio de comanda.
 *
 * Até aqui `financial_entries` só nascia de `fn_finalizar_comanda`. Consequência
 * prática: o relatório de faturamento tinha uma linha "Saiu" que era zero para
 * sempre, porque não havia como registrar aluguel, material ou salário. Metade
 * do financeiro existia.
 *
 * ⚠️ SÓ ENTRADA MANUAL, nunca de comanda. `origin` é gravado como `'manual'` e
 * não vem do corpo: deixar quem chama escolher `'sale'` permitiria criar uma
 * entrada que o relatório conta como venda sem existir comanda nenhuma por trás.
 *
 * ⚠️ COM SESSÃO, client de SESSÃO. A RLS já diz que escrever exige `agent`, e a
 * rota cobra o mesmo degrau de propósito — pedir `manager` aqui criaria uma
 * segunda régua.
 *
 * ⚠️ COM TOKEN (`mcp:write`, Spec 33 R2) o client é a service role e a RLS deixa
 * de proteger: o insert leva a organização da linha do token, `account_id` e
 * `account_plan_id` do corpo são conferidos na organização (a FK é simples e
 * aceitaria a conta de outra), e `created_by_user_id` fica nulo (token não é
 * pessoa).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

const LIMITE_MAXIMO = 500;

const criarSchema = z.object({
  account_id: z.string().uuid(),
  account_plan_id: z.string().uuid().nullish(),
  direction: z.enum(["in", "out"]),
  // O CHECK do banco exige positivo, e quem dá o sinal é `direction`. Recusar
  // zero aqui é o mesmo motivo: um lançamento de R$ 0,00 não é dinheiro, é ruído
  // no extrato.
  amount_cents: z.number().int().min(1).max(1_000_000_000),
  description: z.string().min(1).max(300),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  status: z.enum(["pending", "paid"]).default("pending"),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Leitura do extrato: sessão OU token `mcp:read`.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_lancamentos_listar", requestId);
  if (teto) return teto;

  const url = new URL(req.url);
  const de = url.searchParams.get("de");
  const ate = url.searchParams.get("ate");
  const status = url.searchParams.get("status");

  const supabase = authz.supabase;
  let q = supabase
    .from("financial_entries")
    .select(
      "id, account_id, account_plan_id, sale_id, direction, amount_cents, currency, description, entry_date, status, paid_at, origin, reverses_entry_id, created_at",
    )
    .eq("organization_id", authz.organizationId)
    .order("entry_date", { ascending: false })
    .limit(LIMITE_MAXIMO);

  if (de) q = q.gte("entry_date", de);
  if (ate) q = q.lte("entry_date", ate);
  if (status === "pending" || status === "paid") q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_lancamentos_criar", requestId);
  if (teto) return teto;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = authz.supabase;
  const atorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  // Só o token precisa desta conferência: a sessão passa pela RLS do banco.
  if (authz.via === "token") {
    const { data: conta } = await supabase
      .from("financial_accounts")
      .select("id")
      .eq("organization_id", authz.organizationId)
      .eq("id", lido.data.account_id)
      .maybeSingle();
    let planoValido = true;
    if (lido.data.account_plan_id) {
      const { data: plano } = await supabase
        .from("account_plans")
        .select("id")
        .eq("organization_id", authz.organizationId)
        .eq("id", lido.data.account_plan_id)
        .maybeSingle();
      planoValido = Boolean(plano);
    }
    if (!conta || !planoValido) {
      return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
    }
  }

  // ─── A MOEDA É DA ORGANIZAÇÃO, NUNCA DO CORPO (#3379) ──────────────────
  //
  // `financial_entries.currency` tem `default 'BRL'` e este insert não mandava
  // nada: numa organização em dólar o lançamento manual de `1,300` gravava
  // 130000 centavos em BRL — o número certo depois do #3378, com o rótulo de
  // outra unidade na lista, que é o pior desfecho porque parece certo. Mesmo
  // leitor da comanda (`moedaDaOrganizacao`), e o corpo nem declara o campo: o
  // Zod o descarta antes de chegar aqui.
  const moeda = await moedaDaOrganizacao(supabase, authz.organizationId);

  const { data, error } = await supabase
    .from("financial_entries")
    .insert({
      organization_id: authz.organizationId,
      currency: moeda,
      account_id: lido.data.account_id,
      account_plan_id: lido.data.account_plan_id ?? null,
      direction: lido.data.direction,
      amount_cents: lido.data.amount_cents,
      description: lido.data.description,
      entry_date: lido.data.entry_date,
      status: lido.data.status,
      // Nasce pago só se quem lançou disse que já pagou. `paid_at` acompanha o
      // status e não vem do corpo: uma data de pagamento que não corresponde ao
      // status é a linha que faz o relatório e o extrato contarem histórias
      // diferentes.
      paid_at: lido.data.status === "paid" ? new Date().toISOString() : null,
      origin: "manual",
      created_by_user_id: atorUserId,
    })
    .select("id, direction, amount_cents, currency, status, entry_date")
    .single();

  if (error) {
    // 23503 = a conta não existe nesta organização. Sem a tradução, chegaria
    // como 500 e a pessoa não saberia que basta escolher outra conta.
    if (error.code === "23503") {
      return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "financeiro.lancamento_criado",
    actorUserId: atorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "financial_entry",
    resourceId: data.id,
    requestId,
    metadata: {
      direction: data.direction,
      amount_cents: data.amount_cents,
      status: data.status,
    },
  });

  return ok(data, { requestId });
}
