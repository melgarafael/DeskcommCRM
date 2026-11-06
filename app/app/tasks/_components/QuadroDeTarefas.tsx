"use client";

import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import Link from "next/link";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTasks, type FiltrosDeTarefa } from "@/hooks/tasks/useTasks";
import {
  cargaAtingiuOLimite,
  COLUNA_SEM_SITUACAO,
  colunasDoQuadro,
  LIMITE_DO_QUADRO,
  type ColunaDoQuadro,
} from "@/lib/tarefas/quadro";
import {
  estaAtrasada,
  estaEncerrada,
  type PrioridadeDaTarefa,
  type SituacaoDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";
import { Kanban, UserCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { COR_DA_PRIORIDADE, COR_DA_SITUACAO } from "./estilo-da-prioridade";

/**
 * O QUADRO DE TAREFAS (#4028) — as quatro situações como colunas.
 *
 * ─── Por que ele REUSA o desenho do quadro do funil, e não inventa um ──────
 *
 * O produto já tem um quadro (`components/kanban/`): `DragDropContext` na
 * raiz, uma coluna `Droppable` por etapa com cabeçalho preso e contagem, e
 * cartões `Draggable` numa faixa horizontal que rola com `snap` no celular.
 * Repetir isso aqui com outra gramática daria duas telas que ensinam gestos
 * diferentes para a mesma pessoa. O que muda é o OBJETO (tarefa, não negócio) e
 * o destino (a situação, não a etapa) — o gesto é o mesmo.
 *
 * ─── O que este quadro NÃO faz ─────────────────────────────────────────────
 *
 *  · Não reordena dentro da coluna. A ordem é a da consulta (prazo), e uma
 *    posição gravada por tarefa exigiria coluna nova no banco — decisão de
 *    produto que esta fatia não toma. O arrasto dentro da MESMA coluna é
 *    ignorado de propósito.
 *  · Não é um caminho novo de escrita. Soltar o cartão chama o MESMO
 *    `PATCH /api/v1/tasks/:id` do formulário, com `{ status }` e mais nada.
 *    É o que faz duas abas moverem a mesma tarefa sem apagar o que a outra
 *    acabou de salvar: a escrita é parcial, e a última vence.
 *
 * ─── A carga é limitada, e a tela diz quando cortou ────────────────────────
 *
 * `?limite=200` (ver `LIMITE_DO_QUADRO`). Sem isso, um quadro com a base
 * inteira derruba a aba de quem tem anos de tarefa concluída. Quando a resposta
 * vem no teto, a faixa de aviso aparece: um quadro que esconde metade das
 * tarefas sem dizer nada é pior que uma lista paginada.
 */
export function QuadroDeTarefas({
  podeEditar,
  filtros,
  aoEditar,
}: {
  podeEditar: boolean;
  /** Os filtros da tela (responsável e funil). A situação NÃO entra: as colunas são as situações. */
  filtros: FiltrosDeTarefa;
  aoEditar: (tarefa: Tarefa) => void;
}) {
  const t = useT();
  const usuario = useUser();
  const tag = useTagDeIdioma();
  const { tarefas, carregando, falhou, recarregar, editarTarefa } = useTasks({
    ...filtros,
    limite: LIMITE_DO_QUADRO,
  });
  const membros = useAssignableMembers(podeEditar);
  const nomes = new Map((membros.data ?? []).map((m) => [m.user_id, m.full_name]));

  /**
   * O CARTÃO JÁ MUDOU DE COLUNA, mesmo antes de o servidor responder.
   *
   * `id → { de, para }` das movimentações desta sessão. Sem isto, soltar o
   * cartão faria ele voltar para a coluna de origem até o refetch chegar — e o
   * gesto pareceria não ter funcionado.
   *
   * A sobreposição VALE ENQUANTO a tarefa carregada ainda mostra a situação de
   * onde ela saiu (`de`), e SAI quando a escrita termina — com sucesso ou
   * falha. No sucesso, o `editarTarefa` só resolve depois do refetch, então o
   * dado carregado já diz `para` (ou outra coisa, se outra aba escreveu no
   * meio) quando a sobreposição sai. Se ela ficasse, a tarefa que depois
   * VOLTASSE a `de` — pelo formulário ou por outra aba — seguiria presa em
   * `para`, porque a regra casaria de novo. Quem manda é sempre o dado que
   * veio do servidor.
   */
  const [movidas, setMovidas] = useState<
    Record<string, { de: SituacaoDaTarefa; para: SituacaoDaTarefa }>
  >({});

  function situacaoEmVigor(tarefa: Tarefa): SituacaoDaTarefa {
    const movida = movidas[tarefa.id];
    return movida && tarefa.status === movida.de ? movida.para : tarefa.status;
  }

  function aoSoltar(resultado: DropResult): void {
    // A tela não convida quem só lê ao gesto que a rota vai recusar — mas o
    // guarda fica aqui também, porque `isDragDisabled` é cortesia, não
    // autorização (a mesma régua do botão "Nova tarefa").
    if (!podeEditar) return;

    const destino = resultado.destination;
    if (!destino) return;
    if (destino.droppableId === resultado.source.droppableId) return;
    // "Sem situação" não é valor de banco: é o balde do que não casa com
    // nenhuma coluna. Soltar ali não teria o que gravar.
    if (destino.droppableId === COLUNA_SEM_SITUACAO) return;

    const para = destino.droppableId as SituacaoDaTarefa;
    const id = resultado.draggableId;
    // `de` é a situação GRAVADA (não a que a tela mostra): é ela que a regra
    // de `situacaoEmVigor` compara com o dado carregado.
    const de = tarefas.find((c) => c.id === id)?.status;
    if (!de) return;

    const soltarSobreposicao = () =>
      setMovidas((atual) => {
        const proximo = { ...atual };
        delete proximo[id];
        return proximo;
      });
    setMovidas((atual) => ({ ...atual, [id]: { de, para } }));
    // Deu certo: a sobreposição sai (o porquê está no cabeçalho de `movidas`).
    void editarTarefa(id, { status: para }).then(soltarSobreposicao, (erro) => {
      // A escrita falhou: o cartão VOLTA para onde estava, e o motivo aparece.
      // Deixá-lo na coluna nova seria a tela mentindo sobre o que está gravado.
      soltarSobreposicao();
      showApiError(erro);
    });
  }

  const rotuloDaPrioridade: Record<PrioridadeDaTarefa, string> = {
    low: t("Baixa"),
    medium: t("Média"),
    high: t("Alta"),
    urgent: t("Urgente"),
  };

  const rotuloDaColuna: Record<ColunaDoQuadro, string> = {
    pending: t("Pendente"),
    in_progress: t("Em andamento"),
    done: t("Concluída"),
    cancelled: t("Cancelada"),
    sem_situacao: t("Sem situação"),
  };

  function nomeDoResponsavel(tarefa: Tarefa): string | null {
    if (!tarefa.assigned_to) return null;
    if (tarefa.assigned_to === usuario.id) return t("Eu");
    return nomes.get(tarefa.assigned_to) ?? null;
  }

  if (falhou) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-sm font-medium text-destructive">
          {t("Não foi possível carregar as tarefas.")}
        </p>
        <button
          type="button"
          onClick={() => void recarregar()}
          className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          {t("Tentar novamente")}
        </button>
      </div>
    );
  }

  if (carregando) {
    return (
      <div className="flex gap-3 overflow-hidden" aria-busy>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-64 w-[85vw] max-w-80 shrink-0 animate-pulse rounded-lg border bg-card md:w-80"
          />
        ))}
      </div>
    );
  }

  const colunas = colunasDoQuadro(
    tarefas.map((tarefa) => ({ ...tarefa, status: situacaoEmVigor(tarefa) })),
  );

  return (
    <div data-testid="tarefas-quadro" className="space-y-3">
      {cargaAtingiuOLimite(tarefas) && (
        <p
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {t("Só as primeiras tarefas aparecem aqui — use os filtros para ver as demais.")}
          <span className="ml-2 text-muted-foreground tabular-nums">
            {tarefas.length}/{LIMITE_DO_QUADRO}
          </span>
        </p>
      )}

      <DragDropContext onDragEnd={aoSoltar}>
        <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
          {colunas.map(({ coluna, tarefas: daColuna }) => (
            <section
              key={coluna}
              data-testid={`tarefas-coluna-${coluna}`}
              data-coluna={coluna}
              className="flex w-[85vw] max-w-80 shrink-0 snap-center flex-col rounded-lg border border-border bg-muted/20 md:w-80"
            >
              <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <span className={cn("h-2 w-2 rounded-full", COR_DA_SITUACAO[coluna])} aria-hidden />
                <h2 className="flex-1 truncate text-sm font-semibold">{rotuloDaColuna[coluna]}</h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                  {daColuna.length}
                </span>
              </header>

              <Droppable droppableId={coluna} isDropDisabled={!podeEditar}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={cn(
                      "flex min-h-24 flex-1 flex-col gap-2 p-2 transition-colors",
                      snapshot.isDraggingOver && "bg-primary/5",
                    )}
                  >
                    {daColuna.map((tarefa, indice) => (
                      <Draggable
                        key={tarefa.id}
                        draggableId={tarefa.id}
                        index={indice}
                        isDragDisabled={!podeEditar}
                      >
                        {(arraste, estado) => (
                          <div
                            ref={arraste.innerRef}
                            {...arraste.draggableProps}
                            {...arraste.dragHandleProps}
                            data-testid={`tarefa-no-quadro-${tarefa.id}`}
                            className={cn(
                              "rounded-lg border bg-card p-2.5 shadow-sm transition-shadow",
                              estado.isDragging && "shadow-md ring-2 ring-primary/40",
                              estaEncerrada(tarefa) && "opacity-70",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => aoEditar(tarefa)}
                              className="block w-full text-left"
                            >
                              <span
                                className={cn(
                                  "block text-sm font-medium",
                                  estaEncerrada(tarefa) && "text-muted-foreground line-through",
                                )}
                              >
                                {tarefa.title}
                              </span>
                            </button>

                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 font-medium",
                                  COR_DA_PRIORIDADE[tarefa.priority],
                                )}
                              >
                                {rotuloDaPrioridade[tarefa.priority]}
                              </span>
                              <span
                                className={cn(
                                  "text-muted-foreground",
                                  estaAtrasada(tarefa) && "font-semibold text-destructive",
                                )}
                              >
                                {tarefa.due_date
                                  ? new Date(tarefa.due_date).toLocaleString(tag, {
                                      day: "2-digit",
                                      month: "2-digit",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : t("Sem prazo")}
                              </span>
                              {nomeDoResponsavel(tarefa) ? (
                                <span className="flex items-center gap-1 text-muted-foreground">
                                  <UserCircle size={12} aria-hidden />
                                  {nomeDoResponsavel(tarefa)}
                                </span>
                              ) : null}
                              {tarefa.lead ? (
                                <Link
                                  href={`/app/leads/${tarefa.lead.id}`}
                                  title={tarefa.lead.title}
                                  className="flex max-w-[14rem] min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  <Kanban size={12} aria-hidden className="shrink-0" />
                                  <span className="truncate">{tarefa.lead.title}</span>
                                </Link>
                              ) : null}
                            </div>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                    {daColuna.length === 0 && !snapshot.isDraggingOver && (
                      <div className="flex h-16 items-center justify-center text-[11px] text-muted-foreground">
                        {t("vazio")}
                      </div>
                    )}
                  </div>
                )}
              </Droppable>
            </section>
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
