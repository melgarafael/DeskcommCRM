import Link from "next/link";

import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { carregarAlcance } from "@/lib/agencia/clientes/visibilidade";
import { ROTULO_DA_SITUACAO_DO_CONTRATO, situacaoVisivel } from "@/lib/agencia/contratos/regras";
import { diaLocal } from "@/lib/agencia/tarefas/regras";
import { formatCentsBRL } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Contratos · Agência" };
export const dynamic = "force-dynamic";

/** Todos os contratos dos clientes que a pessoa alcança (docs/agencia/SPEC-contratos.md). */
export default async function PaginaDosContratos() {
  const ctx = await requirePermissaoNaPagina("contratos.gerenciar");
  const alcance = await carregarAlcance(ctx);
  const { data } = await createAdminClient()
    .from("agencia_contratos")
    .select("id, cliente_id, titulo, situacao, valor_mensal_cents, valido_ate, assinado_em, pago_em, agencia_clientes(nome)")
    .order("criado_em", { ascending: false })
    .limit(300);
  const hoje = diaLocal(new Date());
  const contratos = ((data ?? []) as unknown as Array<{
    id: string;
    cliente_id: string;
    titulo: string;
    situacao: string;
    valor_mensal_cents: number;
    valido_ate: string;
    assinado_em: string | null;
    pago_em: string | null;
    agencia_clientes: { nome: string } | null;
  }>).filter((c) => alcance.todos || alcance.ids.has(c.cliente_id));
  const abertos = contratos.filter((c) => !["concluido", "recusado", "cancelado"].includes(c.situacao));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Contratos</h1>
          <p className="text-sm text-muted-foreground">{abertos.length} em aberto. Gere um contrato novo na ficha do cliente, aba Contratos.</p>
        </div>
        <Link href="/agencia/contratos/modelos" className="text-sm underline underline-offset-4">
          Modelos de contrato
        </Link>
      </div>
      {contratos.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">Nenhum contrato ainda.</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="lista-de-contratos">
          {contratos.map((c) => {
            const s = situacaoVisivel(c, hoje);
            return (
              <li key={c.id}>
                <Link href={`/agencia/clientes/${c.cliente_id}?aba=contratos`} className="flex flex-wrap items-baseline justify-between gap-2 p-3 text-sm hover:bg-accent/40">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{c.agencia_clientes?.nome ?? c.titulo}</span>
                    <span className="text-xs text-muted-foreground">{formatCentsBRL(Number(c.valor_mensal_cents))} por mês</span>
                  </span>
                  <span className={s === "vencido" ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{ROTULO_DA_SITUACAO_DO_CONTRATO[s]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
