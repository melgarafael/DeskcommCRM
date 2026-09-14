/**
 * A COMANDA — abrir e listar.
 *
 * A migration 0240 trouxe as tabelas e as duas funções que movem dinheiro
 * (`fn_finalizar_comanda`, `fn_estornar_comanda`), e ninguém as chamava: o
 * módulo inteiro existia sem porta. Estas rotas são a porta.
 *
 * ⚠️ CLIENT DE SESSÃO, nunca o admin — e aqui não é só doutrina, é requisito.
 * `fn_finalizar_comanda` começa por `auth.uid() is null` e recusa; chamada com a
 * service key ela levanta `comanda_forbidden`. A RLS diz quem lê e quem escreve,
 * e `requireRole` é só a borda de autenticação.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { abrirComandaSchema } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limite = Math.min(Number(url.searchParams.get("limit")) || LIMITE_PADRAO, LIMITE_MAXIMO);

  const supabase = await createClient();
  let q = supabase
    .from("sales")
    // Literal ÚNICO, e não concatenação: o supabase-js infere o tipo do
    // resultado a partir do TEXTO do select, e um `+` no meio o reduz a `string`
    // — o embed `sale_items(...)` deixa de existir para o TypeScript.
    .select(
      "id, number, status, contact_id, attendant_user_id, appointment_id, discount_cents, total_cents, currency, payment_method_id, notes, finalized_at, cancelled_at, reversed_at, created_at, sale_items(id, description, quantity, unit_price_cents, discount_cents, total_cents, commission_percent, attendant_user_id, event_type_id)",
    )
    .order("number", { ascending: false })
    .limit(limite);

  if (status === "open" || status === "finalized" || status === "cancelled") {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  // O total de uma comanda ABERTA é derivado dos itens, sempre. `total_cents` só
  // é gravado na finalização, e ler a coluna antes disso mostraria zero numa
  // comanda com itens — o tipo de número errado que o operador acredita.
  const comandas = (data ?? []).map((c) => {
    const itens = (c.sale_items ?? []) as Array<{ total_cents: number }>;
    const soma = itens.reduce((acc, i) => acc + Number(i.total_cents), 0);
    return {
      ...c,
      total_cents:
        c.status === "open" ? Math.max(soma - Number(c.discount_cents ?? 0), 0) : c.total_cents,
    };
  });

  return ok(comandas, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = abrirComandaSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const org = authz.org.orgId;

  // IDEMPOTÊNCIA POR AGENDAMENTO, antes de qualquer escrita.
  //
  // O índice único da 0243 é a garantia de verdade (duas requisições simultâneas
  // não passam pelas duas consultas). Este atalho existe para o caso comum, o
  // toque repetido, devolver a comanda que já existe em vez de um 409 que a tela
  // teria de traduzir.
  if (lido.data.appointment_id) {
    const { data: existente } = await supabase
      .from("sales")
      .select("id, number, status")
      .eq("organization_id", org)
      .eq("appointment_id", lido.data.appointment_id)
      .neq("status", "cancelled")
      .maybeSingle();
    if (existente) return ok({ ...existente, ja_existia: true }, { requestId });
  }

  const { data: numero, error: erroNumero } = await supabase.rpc("fn_proximo_numero_de_comanda", {
    p_org: org,
  });
  if (erroNumero) return fail("internal_error", erroNumero.message, 500, { requestId });

  const { data, error } = await supabase
    .from("sales")
    .insert({
      organization_id: org,
      number: numero as number,
      contact_id: lido.data.contact_id ?? null,
      appointment_id: lido.data.appointment_id ?? null,
      attendant_user_id: authz.user.id,
      created_by_user_id: authz.user.id,
      notes: lido.data.notes ?? null,
    })
    .select("id, number, status")
    .single();

  if (error) {
    // 23505 = a corrida que o índice único pegou: o número foi tomado entre a
    // chamada da sequência e o insert, ou o agendamento já tinha comanda.
    if (error.code === "23505") {
      return fail("conflict", "Esta comanda já foi aberta.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "comanda.aberta",
    resourceType: "sale",
    resourceId: data.id,
    requestId,
    metadata: { number: data.number, appointment_id: lido.data.appointment_id ?? null },
  });

  return ok(data, { requestId });
}
