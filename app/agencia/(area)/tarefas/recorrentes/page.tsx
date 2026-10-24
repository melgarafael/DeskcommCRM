import Link from "next/link";

import { RecorrentesCliente, type RecorrenteDaLista } from "@/components/agencia/tarefas/RecorrentesCliente";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { apoioDoQuadro, carregarQuemOlha } from "@/lib/agencia/tarefas/consultas";
import type { Padrao, Prioridade } from "@/lib/agencia/tarefas/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Tarefas recorrentes · Agência" };
export const dynamic = "force-dynamic";

export default async function PaginaDeRecorrentes() {
  const ctx = await requirePermissaoNaPagina("tarefas.atribuir");
  const quem = await carregarQuemOlha(ctx);
  const [apoio, { data }] = await Promise.all([
    apoioDoQuadro(quem),
    createAdminClient()
      .from("agencia_tarefas_recorrentes")
      .select("*, agencia_recorrentes_responsaveis(membro_id), agencia_recorrentes_etiquetas(etiqueta_id)")
      .order("criada_em"),
  ]);

  const lista: RecorrenteDaLista[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    titulo: r.titulo as string,
    descricao: (r.descricao as string | null) ?? "",
    clienteId: (r.cliente_id as string | null) ?? "",
    funcaoId: (r.funcao_id as string | null) ?? "",
    prioridade: r.prioridade as Prioridade,
    padrao: r.padrao as Padrao,
    diasSemana: (r.dias_semana as number[]) ?? [],
    diaDoMes: (r.dia_do_mes as number | null) ?? null,
    hora: String(r.hora).slice(0, 5),
    prazoEmHoras: (r.prazo_em_horas as number | null) ?? null,
    inicio: r.inicio as string,
    fim: (r.fim as string | null) ?? "",
    ativa: r.ativa as boolean,
    proximaExecucao: (r.proxima_execucao as string | null) ?? null,
    responsaveis: ((r.agencia_recorrentes_responsaveis as Array<{ membro_id: string }> | null) ?? []).map((x) => x.membro_id),
    etiquetas: ((r.agencia_recorrentes_etiquetas as Array<{ etiqueta_id: string }> | null) ?? []).map((x) => x.etiqueta_id),
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/tarefas" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Tarefas
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Tarefas recorrentes</h1>
        <p className="text-sm text-muted-foreground">Tarefas que nascem sozinhas no dia e na hora marcados.</p>
      </div>
      <RecorrentesCliente recorrentes={lista} apoio={apoio} />
    </div>
  );
}
