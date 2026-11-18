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
 * ⚠️ CLIENT DE SESSÃO. A RLS já diz que escrever exige `agent`, e a rota cobra o
 * mesmo degrau de propósito — pedir `manager` aqui criaria uma segunda régua, e
 * quem chamasse com um token de servidor passaria pela RLS mesmo assim.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

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
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const de = url.searchParams.get("de");
  const ate = url.searchParams.get("ate");
  const status = url.searchParams.get("status");

  const supabase = await createClient();
  // #4845 — o extrato é da EMPRESA ATIVA. A RLS de `financial_entries` libera
  // todas as empresas de que a pessoa é membro, então o caixa da empresa A
  // listava o dinheiro da B.
  let q = supabase
    .from("financial_entries")
    .select(
      "id, account_id, account_plan_id, sale_id, direction, amount_cents, currency, description, entry_date, status, paid_at, origin, reverses_entry_id, created_at",
    )
    .eq("organization_id", authz.org.orgId)
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

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const org = authz.org.orgId;

  // ─── A CONTA E O PLANO SÃO DESTA EMPRESA (#4845) ───────────────────────
  //
  // A FK de `financial_entries.account_id` só exige que a conta EXISTA, e a RLS
  // de escrita confere a empresa da LINHA — que esta rota já preenche — não a da
  // conta apontada. Para quem é membro de duas empresas, o lançamento da A saía
  // apontando para o caixa da B, e o extrato de uma citava a conta da outra.
  // É a mesma conferência que `fn_honorarios_parcela_pagar` faz no banco antes de
  // gravar (`conta_invalida`), e a mensagem é a que esta rota já usa para o 23503.
  const { data: conta } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("id", lido.data.account_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (!conta) {
    return fail("validation_failed", "Conta ou plano de contas inválido.", 422, { requestId });
  }
  if (lido.data.account_plan_id) {
    const { data: plano } = await supabase
      .from("account_plans")
      .select("id")
      .eq("id", lido.data.account_plan_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (!plano) {
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
  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);

  const { data, error } = await supabase
    .from("financial_entries")
    .insert({
      organization_id: authz.org.orgId,
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
      created_by_user_id: authz.user.id,
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
