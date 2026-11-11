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

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { abrirComandaSchema } from "@/lib/financeiro/comanda";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 200;
/** Quantas comandas entram em cada consulta de itens: o `.in` não cresce sem teto. */
const COMANDAS_POR_LOTE = 50;
/** Teto de linhas por resposta do PostgREST (`max_rows`): o tamanho da página dos itens. */
const PAGINA_DE_ITENS = 1000;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // #1907 item 4 — comanda é MÓDULO DE TABELA: sem `modulos_instalados` a
  // linha ativa as cinco tabelas não existem e a rota não existe. 404,
  // mesmo molde da cobrança desligada (falha fechada, dois lados).
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "financeiro"))) return fail("not_found", "Not found", 404, { requestId });
  // Leitura: sessão OU token `mcp:read`. O papel mínimo é o da sessão.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_comandas_listar", requestId);
  if (teto) return teto;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limite = Math.min(Number(url.searchParams.get("limit")) || LIMITE_PADRAO, LIMITE_MAXIMO);

  const supabase = authz.supabase;
  let q = supabase
    .from("sales")
    // Literal ÚNICO, e não concatenação: o supabase-js infere o tipo do
    // resultado a partir do TEXTO do select. Sem embed de `sale_items`: no token
    // o embed traria item de outra organização; os itens vêm abaixo, com a organização.
    .select(
      "id, number, status, contact_id, attendant_user_id, appointment_id, discount_cents, total_cents, currency, payment_method_id, notes, finalized_at, cancelled_at, reversed_at, created_at",
    )
    .eq("organization_id", authz.organizationId)
    .order("number", { ascending: false })
    .limit(limite);

  if (status === "open" || status === "finalized" || status === "cancelled") {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const vendas = data ?? [];
  // Os itens vêm em lotes de comandas, e cada lote pagina por `range`: o PostgREST
  // corta toda resposta em `max_rows` (1000 linhas), e um `.in` sem paginação
  // perdia itens em silêncio, o que deixava o total da comanda aberta menor.
  // A página avança pelo que VEIO, não pelo tamanho pedido, porque o `max_rows` da
  // instalação pode ser menor. Só a página vazia encerra o lote.
  const itens: Array<{ sale_id: string; total_cents: number }> = [];
  for (let i = 0; i < vendas.length; i += COMANDAS_POR_LOTE) {
    const lote = vendas.slice(i, i + COMANDAS_POR_LOTE).map((v) => v.id);
    let de = 0;
    for (;;) {
      const { data: pagina, error: erroItens } = await supabase
        .from("sale_items")
        .select(
          "id, sale_id, description, quantity, unit_price_cents, discount_cents, total_cents, commission_percent, attendant_user_id, event_type_id",
        )
        .eq("organization_id", authz.organizationId)
        .in("sale_id", lote)
        .order("id", { ascending: true })
        .range(de, de + PAGINA_DE_ITENS - 1);
      if (erroItens) return fail("internal_error", erroItens.message, 500, { requestId });
      const lidas = (pagina ?? []) as Array<{ sale_id: string; total_cents: number }>;
      if (lidas.length === 0) break;
      itens.push(...lidas);
      de += lidas.length;
    }
  }

  // O total de uma comanda ABERTA é derivado dos itens, sempre. `total_cents` só
  // é gravado na finalização, e ler a coluna antes disso mostraria zero numa
  // comanda com itens — o tipo de número errado que o operador acredita.
  const comandas = vendas.map((c) => {
    const meus = itens
      .filter((i) => i.sale_id === c.id)
      .map(({ sale_id: _venda, ...item }) => item);
    const soma = meus.reduce((acc, i) => acc + Number(i.total_cents), 0);
    return {
      ...c,
      sale_items: meus,
      total_cents:
        c.status === "open" ? Math.max(soma - Number(c.discount_cents ?? 0), 0) : c.total_cents,
    };
  });

  return ok(comandas, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // #1907 item 4 — comanda é MÓDULO DE TABELA: sem `modulos_instalados` a
  // linha ativa as cinco tabelas não existem e a rota não existe. 404,
  // mesmo molde da cobrança desligada (falha fechada, dois lados).
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "financeiro"))) return fail("not_found", "Not found", 404, { requestId });
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_comandas_abrir", requestId);
  if (teto) return teto;

  const lido = abrirComandaSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = authz.supabase;
  const org = authz.organizationId;
  // Quem é o autor: só a pessoa da sessão. Token não é pessoa: a coluna fica nula.
  const autor = authz.actor.type === "user" ? authz.actor.id : null;

  // No token, o corpo é a única fonte destes ids: cada um tem de ser desta
  // organização, senão a comanda nasceria amarrada a contato ou agendamento alheio.
  if (authz.via === "token") {
    if (lido.data.contact_id) {
      const { data: contato } = await supabase
        .from("contacts")
        .select("id")
        .eq("id", lido.data.contact_id)
        .eq("organization_id", org)
        .maybeSingle();
      if (!contato) return fail("validation_failed", "Contato inválido para esta organização.", 422, { requestId });
    }
    if (lido.data.appointment_id) {
      const { data: agenda } = await supabase
        .from("calendar_appointments")
        .select("id")
        .eq("id", lido.data.appointment_id)
        .eq("organization_id", org)
        .maybeSingle();
      if (!agenda) return fail("validation_failed", "Agendamento inválido para esta organização.", 422, { requestId });
    }
  }

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

  // A MOEDA VEM DA ORGANIZAÇÃO, nunca do corpo e nunca do default da coluna.
  // Sem isto a comanda nascia em BRL (default `'BRL'` de `sales.currency`) em
  // toda organização que opera em euro, e a tela mostrava R$ ao lado do € que
  // a própria lista de pendentes exibia — dois números para o mesmo
  // atendimento (#2160). O corpo nem declara `currency`: o Zod descarta.
  const moeda = await moedaDaOrganizacao(supabase, org);

  const { data, error } = await supabase
    .from("sales")
    .insert({
      organization_id: org,
      number: numero as number,
      contact_id: lido.data.contact_id ?? null,
      appointment_id: lido.data.appointment_id ?? null,
      attendant_user_id: autor,
      created_by_user_id: autor,
      notes: lido.data.notes ?? null,
      currency: moeda,
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
    organizationId: org,
    actorUserId: autor,
    actorApiTokenId: authz.apiTokenId ?? null,
    resourceType: "sale",
    resourceId: data.id,
    requestId,
    metadata: { number: data.number, appointment_id: lido.data.appointment_id ?? null },
  });

  return ok(data, { requestId });
}
