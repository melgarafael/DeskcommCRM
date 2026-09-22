/**
 * GET /api/v1/radar-compras — recompra por cliente a partir dos PEDIDOS REAIS.
 *
 * Não existe tabela de radar: o histórico é derivado de commercial_orders a
 * cada chamada (lib/comercial/radar-compras.ts). Query params: ?situacao=
 * (uma das chaves de ROTULO_RECOMPRA), ?limit= (1..500, default 200).
 *
 * Performance (medido na base real, 10k+ pedidos): service_role com filtro
 * explícito de organization_id (molde das 89 rotas: org vindo do authz do
 * servidor, NUNCA do body). Via RLS de sessão, cada página custava ~1,7s
 * (18s no total) e o frontend abortava — a tela mentia "base em dia"; em
 * paralelo, a contenção derrubava página com 500. Leitura pura, sem mutação.
 * A resposta traz o resumo por cliente SEM o array `vendas` completo (a
 * tela usa `ultimos`), e os nomes vêm só dos contatos com pedido (o
 * `.limit(10000)` antigo estourava o teto de 1000 do PostgREST e a maioria
 * das linhas saía sem nome).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { historicoDeCompra, ROTULO_RECOMPRA, type SituacaoRecompra } from "@/lib/comercial/radar-compras";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SITUACOES = Object.keys(ROTULO_RECOMPRA) as SituacaoRecompra[];

type LinhaPedido = {
  id: string;
  contact_id: string | null;
  total_cents: number;
  status: string;
  origem: string;
  dia: string;
  vendedor_user_id: string | null;
};

type LinhaPedidoCru = {
  id: string;
  contact_id: string | null;
  total_cents: number;
  status: string;
  origem: string;
  created_at: string;
  vendedor_user_id: string | null;
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const situacao = req.nextUrl.searchParams.get("situacao")?.trim() ?? "";
  // `todas` (inclui "em dia") existe para o dashboard agregar a carteira
  // inteira; o default sem parâmetro continua excluindo "ok".
  if (situacao !== "" && situacao !== "todas" && !(SITUACOES as string[]).includes(situacao)) {
    return fail("validation_failed", `situacao aceita: ${SITUACOES.join(", ")}, todas.`, 422, { requestId });
  }
  const limit = Math.min(5000, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "200") || 200));
  const hoje = new Date().toISOString().slice(0, 10);

  // Service role + filtro explícito de org (ver docstring): a mesma consulta
  // via RLS de sessão custa 10× por página e estoura qualquer timeout.
  const supabase = createAdminClient();
  const orgId = authz.org.orgId;
  // TEMP diagnóstico: tempos por fase no log do servidor (sai antes de fechar).
  const tFase = Date.now();
  const marca = (fase: string): void => {
    console.error(`[radar-compras] ${fase}: ${Date.now() - tFase}ms (${requestId})`);
  };
  const COLS = "id, contact_id, total_cents, status, origem, created_at, vendedor_user_id";
  const TETO_LINHAS = 25000;

  const { count, error: erroContagem } = await supabase
    .from("commercial_orders")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (erroContagem) {
    console.error(`[radar-compras] contagem: ${erroContagem.message} (${requestId})`);
    return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });
  }
  const total = Math.min(count ?? 0, TETO_LINHAS);
  const faixas: [number, number][] = [];
  for (let de = 0; de < total; de += 1000) faixas.push([de, Math.min(de + 999, total - 1)]);

  // Em paralelo: com service_role não há contenção de RLS (medido: 11
  // faixas em ~0,5s). Via RLS de sessão, NUNCA em paralelo (500).
  const paginas = await Promise.all(
    faixas.map(([de, ate]) =>
      supabase
        .from("commercial_orders")
        .select(COLS)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true })
        .range(de, ate),
    ),
  );
  const pedidos: LinhaPedido[] = [];
  for (const pg of paginas) {
    if (pg.error) {
      console.error(`[radar-compras] pagina: ${pg.error.message} (${requestId})`);
      return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });
    }
    for (const p of (pg.data ?? []) as unknown as LinhaPedidoCru[]) {
      pedidos.push({
        id: p.id,
        contact_id: p.contact_id,
        total_cents: p.total_cents,
        status: p.status,
        origem: p.origem,
        dia: p.created_at.slice(0, 10),
        vendedor_user_id: p.vendedor_user_id ?? null,
      });
    }
  }
  marca(`pedidos ${pedidos.length}`);

  const porContato = new Map<string, typeof pedidos>();
  for (const p of pedidos) {
    if (!p.contact_id) continue;
    const lista = porContato.get(p.contact_id) ?? [];
    lista.push(p);
    porContato.set(p.contact_id, lista);
  }

  // Só os contatos com pedido, em lotes de 100 (o `.limit(10000)` antigo
  // estourava o teto de 1000 do PostgREST e a maioria das linhas saía sem
  // nome; e lote de 500 com ~19KB de URL morre com `fetch failed` após 8s —
  // medido: IN(500) falha, IN(200) passa em ~130ms, IN(100) com margem).
  // Em paralelo: consultas curtas, sem o custo das páginas de pedidos.
  const idsContatos = [...porContato.keys()];
  const nomes = new Map<string, { nome: string; fone: string | null; cidade: string | null; uf: string | null }>();
  const lotes: string[][] = [];
  for (let i = 0; i < idsContatos.length; i += 100) lotes.push(idsContatos.slice(i, i + 100));
  const blocos = await Promise.all(
    lotes.map((lote) =>
      supabase
        .from("contacts")
        .select("id, display_name, name, phone_number, cidade, uf")
        .eq("organization_id", orgId)
        .in("id", lote),
    ),
  );
  for (const b of blocos) {
    if (b.error) {
      console.error(`[radar-compras] contatos: ${b.error.message} (${requestId})`);
      return fail("internal_error", "Erro ao ler os contatos.", 500, { requestId });
    }
    for (const c of (b.data ?? []) as unknown as {
      id: string;
      display_name: string | null;
      name: string | null;
      phone_number: string | null;
      cidade: string | null;
      uf: string | null;
    }[]) {
      nomes.set(c.id, {
        nome: c.display_name ?? c.name ?? "—",
        fone: c.phone_number,
        cidade: c.cidade,
        uf: c.uf,
      });
    }
  }
  marca(`contatos ${nomes.size}`);

  const linhas = [...porContato.entries()].map(([contactId, lista]) => {
    // Sem o `vendas` completo: a tela usa `ultimos` + agregados, e o array
    // inteiro por cliente engordava a resposta sem ninguém ler.
    const { vendas: _omit, ...h } = historicoDeCompra(lista, contactId, hoje);
    const c = nomes.get(contactId) ?? { nome: contactId.slice(0, 8), fone: null, cidade: null, uf: null };
    // Vendedor predominante nos pedidos (para o filtro da tela) — moda simples
    // sobre o que já foi carregado, sem query a mais.
    const votos = new Map<string, number>();
    for (const p of lista) {
      if (p.vendedor_user_id) votos.set(p.vendedor_user_id, (votos.get(p.vendedor_user_id) ?? 0) + 1);
    }
    const vendedor = [...votos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { ...h, nome: c.nome, fone: c.fone, cidade: c.cidade, uf: c.uf, vendedor_user_id: vendedor };
  });

  const PRIORIDADE: Record<SituacaoRecompra, number> = {
    em_risco: 0,
    recompra_atrasada: 1,
    em_voo: 2,
    cancelado_sem_nova: 3,
    oportunidade_aberta: 4,
    primeira_compra: 5,
    novo_sem_compras: 6,
    ok: 7,
  };
  const filtradas = (
    situacao === "todas"
      ? linhas
      : situacao
        ? linhas.filter((l) => l.situacao === situacao)
        : linhas.filter((l) => l.situacao !== "ok")
  )
    .sort((a, b) => PRIORIDADE[a.situacao] - PRIORIDADE[b.situacao] || b.atraso_dias - a.atraso_dias)
    .slice(0, limit);

  return ok(filtradas, { requestId });
}
