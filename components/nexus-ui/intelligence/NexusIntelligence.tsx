"use client";
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { UsersThree } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { comoMoeda } from "@/lib/format/moeda";
import { ROTULO_RECOMPRA } from "@/lib/comercial/radar-compras";
import { useNexusIntelligence } from "@/hooks/nexus/useNexusIntelligence";
import {
  buildSelectionContext,
  explainNode,
  REGIAO_NAO_INFORMADA_KEY,
  type NexusRadarRow,
} from "@/lib/nexus/graph";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { NexusErrorState } from "@/components/nexus-ui/feedback/NexusErrorState";
import { NexusTableSkeleton } from "@/components/nexus-ui/feedback/NexusSkeleton";
import { NexusConfirmDialog } from "@/components/nexus-ui/forms/NexusConfirmDialog";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";

/**
 * @xyflow/react só entra nesta rota (`ssr: false` — fora do bundle principal,
 * mesmo padrão do FlowBuilder de follow-ups).
 */
const Canvas = dynamic(() => import("./NexusGraphCanvas").then((m) => m.NexusGraphCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-[560px] w-full" />,
});

function filtraContexto(
  rows: NexusRadarRow[],
  ctx: ReturnType<typeof buildSelectionContext>,
  t: (texto: string) => string,
) {
  const semFiltro =
    ctx.clientes.length === 0 && ctx.regioes.length === 0 && ctx.situacoes.length === 0;
  if (semFiltro) return rows.slice(0, 20);
  const ids = new Set(ctx.clientes.map((c) => c.id));
  const regioes = new Set(ctx.regioes);
  // Sem cidade/UF, o nó do grafo se chama t("Região não informada") — o filtro
  // casa com a mesma chave traduzida, não com o literal PT.
  const semRegiao = t(REGIAO_NAO_INFORMADA_KEY);
  return rows.filter((r) => {
    if (ids.size > 0 && !ids.has(r.contact_id)) return false;
    if (ctx.situacoes.length > 0 && !ctx.situacoes.includes(r.situacao)) return false;
    if (regioes.size > 0) {
      const regiao = [r.cidade, r.uf].filter(Boolean).join("/") || semRegiao;
      if (!regioes.has(regiao) && !regioes.has(r.cidade ?? "")) return false;
    }
    return true;
  });
}

function LinhaCliente({
  row,
  onTask,
  busy,
}: {
  row: NexusRadarRow;
  onTask: (row: NexusRadarRow) => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <Link
          href={`/app/contacts/${row.contact_id}`}
          className="truncate text-sm font-medium text-text hover:text-accent"
        >
          {row.nome}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {ROTULO_RECOMPRA[row.situacao]} · {t("há")} {row.dias_sem_compra}d {t("sem comprar")} ·{" "}
          {comoMoeda(row.faturamento_cents, "BRL")} {t("acumulado")}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onTask(row)}>
        {t("Criar tarefa")}
      </Button>
    </li>
  );
}

export function NexusIntelligence() {
  const t = useT();
  const { graph, radarRows, isLoading, isError, refetch } = useNexusIntelligence();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busyTask, setBusyTask] = useState(false);

  const porId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const selecionados = useMemo(
    () => selectedIds.map((id) => porId.get(id)).filter((n) => n !== undefined),
    [selectedIds, porId],
  );
  const ctx = useMemo(() => buildSelectionContext(selecionados, t), [selecionados, t]);
  const lista = useMemo(() => filtraContexto(radarRows, ctx, t), [radarRows, ctx, t]);
  // Legenda fora do JSX: os kinds são valores de wire (`NexusNodeKind`), e o
  // literal "conhecimento" casa o dígrafo `nh` do guarda de prosa crua quando
  // escrito dentro da expressão JSX. Aqui é dado, não texto de tela.
  const itensLegenda = [
    ["cliente", t("Clientes")],
    ["regiao", t("Regiões")],
    ["situacao", t("Situações")],
    ["risco", t("Riscos")],
    ["insight", t("Derivados")],
    ["conhecimento", t("Conhecimento")],
    ["aprendizado", t("Memória")],
    ["metrica", t("Métricas")],
  ] as const;

  async function criarTarefa(row: NexusRadarRow) {
    setBusyTask(true);
    try {
      await apiClient.post<{ data: { id: string } }>("/api/v1/tarefas", {
        titulo: `${t("Retomar")} ${row.nome}`,
        descricao: `${ROTULO_RECOMPRA[row.situacao]} — ${t("há")} ${row.dias_sem_compra} ${t("dias sem comprar")}. ${t("Última")}: ${row.ultima_compra}.`,
        tipo: "retorno",
        contact_id: row.contact_id,
      });
      nexusToast.success(
        t("Tarefa criada"),
        `${t("Retomar")} ${row.nome}: ${t("entrou na rotina.")}`,
      );
    } catch {
      nexusToast.error(t("Não foi possível criar a tarefa"), t("Tente novamente em instantes."));
    } finally {
      setBusyTask(false);
    }
  }

  async function criarTarefasEmLote() {
    const alvos = lista.filter((r) => r.contact_id).slice(0, 10);
    setBusyTask(true);
    try {
      for (const row of alvos) {
        await apiClient.post<{ data: { id: string } }>("/api/v1/tarefas", {
          titulo: `${t("Retomar")} ${row.nome}`,
          descricao: `${ROTULO_RECOMPRA[row.situacao]} — ${t("há")} ${row.dias_sem_compra} ${t("dias sem comprar")}.`,
          tipo: "retorno",
          contact_id: row.contact_id,
        });
      }
      nexusToast.success(
        `${alvos.length} ${t("tarefas criadas")}`,
        t("A rotina do vendedor foi alimentada."),
      );
    } catch {
      nexusToast.error(
        t("Lote interrompido"),
        t("Algumas tarefas podem ter sido criadas. Confira em Tarefas."),
      );
    } finally {
      setBusyTask(false);
    }
  }

  function copiarContexto() {
    const payload = {
      resumo: ctx.resumo,
      clientes: ctx.clientes,
      regioes: ctx.regioes,
      situacoes: ctx.situacoes.map((s) => ROTULO_RECOMPRA[s]),
      outros: ctx.outros,
    };
    void copyToClipboard(JSON.stringify(payload, null, 2)).then((ok) => {
      if (ok) nexusToast.success(t("Contexto copiado"), t("Cole no assistente ou na campanha."));
      else nexusToast.error(t("Não foi possível copiar"), t("Selecione de novo e tente."));
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <NexusPageHeader
          title={t("Inteligência")}
          subtitle={t("O grafo vivo do negócio — cada nó é um dado real.")}
        />
        <NexusTableSkeleton rows={4} columns={3} />
        <Skeleton className="h-[560px] w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <NexusPageHeader title={t("Inteligência")} />
        <NexusErrorState
          title={t("Inteligência indisponível")}
          description={t("Não foi possível ler as fontes (radar, riscos, IA). Tente novamente.")}
          onRetry={refetch}
        />
      </div>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="space-y-4">
        <NexusPageHeader
          title={t("Inteligência")}
          subtitle={t("O grafo vivo do negócio — cada nó é um dado real.")}
        />
        <NexusEmptyState
          icon={UsersThree}
          headline={t("Ainda não há movimento para mapear")}
          subcopy={t("Assim que houver pedidos e conversas, o grafo aparece aqui sozinho.")}
          primary={{ label: t("Ver Radar"), href: "/app/radar" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <NexusPageHeader
        title={t("Inteligência")}
        subtitle={t("Selecione nós para montar o contexto — filtrar, explicar, criar tarefas.")}
        actions={
          <>
            {selectedIds.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
                {t("Limpar seleção")} ({selectedIds.length})
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link href="/app/radar">{t("Abrir Radar")}</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <Canvas graph={graph} selectedIds={selectedIds} onSelect={setSelectedIds} />
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "Clique para selecionar · Shift+clique para combinar · tracejado = derivado por regra.",
            )}
          </p>
        </div>

        <aside aria-label={t("Contexto selecionado")} className="space-y-4">
          <section className="rounded-lg border border-border bg-surface p-4 shadow-xs">
            <h2 className="text-sm font-semibold text-text">{t("Contexto")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{ctx.resumo}</p>
            {selecionados.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selecionados.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setSelectedIds((ids) => ids.filter((id) => id !== n.id))}
                    title={t("Clique para remover do contexto")}
                    aria-label={`${t("Remover do contexto")}: ${n.label}`}
                    className="nexus-transition inline-flex items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-0.5 text-xs leading-5 font-medium text-text-muted hover:border-accent"
                  >
                    {n.label} ×
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("Toque em nós do grafo para montar um contexto — ex.: região + situação.")}
              </p>
            )}
            {selecionados.length > 0 ? (
              <div className="mt-3 space-y-2">
                {selecionados.slice(0, 5).map((n) => (
                  <p key={n.id} className="text-xs leading-relaxed text-muted-foreground">
                    {explainNode(n, t)}
                  </p>
                ))}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={copiarContexto}>
                    {t("Copiar contexto")}
                  </Button>
                  {lista.length > 0 && lista.length <= 10 ? (
                    <NexusConfirmDialog
                      title={`${t("Criar")} ${lista.length} ${t("tarefa(s)?")}`}
                      description={t(
                        "Uma tarefa de retorno por cliente do contexto. Dá para desfazer em Tarefas.",
                      )}
                      confirmLabel={t("Criar tarefas")}
                      busy={busyTask}
                      onConfirm={criarTarefasEmLote}
                      triggerLabel={`${t("Criar tarefas")} (${lista.length})`}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-surface p-4 shadow-xs">
            <h2 className="text-sm font-semibold text-text">{t("Legenda")}</h2>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              {itensLegenda.map(([kind, rotulo]) => {
                const qtd = graph.nodes.filter((n) => n.kind === kind).length;
                if (qtd === 0) return null;
                return (
                  <li key={kind}>
                    {rotulo}: <span className="font-medium text-text">{qtd}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>

      <section aria-label={t("Clientes no contexto")} className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text">
            {t("Clientes no contexto")} ({lista.length})
          </h2>
          {lista.length > 10 ? (
            <p className="text-xs text-muted-foreground">
              {t("Refine a seleção para liberar a criação em lote (até 10).")}
            </p>
          ) : null}
        </div>
        {lista.length === 0 ? (
          <NexusEmptyState
            icon={UsersThree}
            headline={t("Nenhum cliente neste contexto")}
            subcopy={t("Ajuste a seleção no grafo para ver quem entra aqui.")}
          />
        ) : (
          <ul className="grid gap-2 lg:grid-cols-2">
            {lista.slice(0, 20).map((row) => (
              <LinhaCliente key={row.contact_id} row={row} onTask={criarTarefa} busy={busyTask} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
