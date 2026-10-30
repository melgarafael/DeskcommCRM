"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PencilSimple, Trash, DragHandle } from "@/lib/ui/icons";
import type { MessageTemplate, GrupoDeRespostas } from "@/hooks/inbox/useMessageTemplates";
import { lerRespostaRapidaGravada } from "@/lib/inbox/resposta-rapida";
import { secoesDeRespostas } from "@/lib/templates/grupos";

/**
 * A LISTA DE RESPOSTAS RÁPIDAS, em duas formas (#3244 + #3245).
 *
 * ─── O "opcional" é um caminho de render, não uma condição espalhada ────────
 *
 * `ListaDeRespostas` pergunta a `secoesDeRespostas` (lib/templates/grupos.ts) se
 * há grupo. Sem grupo nenhum ela devolve `null`, e aí esta função devolve
 * `ListaPlana` — o MESMO componente que a tela renderizava antes dos grupos,
 * com o mesmo `DragDropContext`, o mesmo `Droppable` ("respostas-rapidas") e o
 * mesmo `ItemDeResposta`. Não há um segundo caminho "plano" escrito de novo:
 * quem nunca criar grupo vê hoje, byte a byte.
 *
 * ─── Uma lista por seção, e o arrasto é DENTRO dela ────────────────────────
 *
 * Cada seção é um `Droppable` próprio (`grupo:<id>`, ou `sem-grupo`), então
 * `destination.index` do dnd é a posição DENTRO da seção — que é a conta que o
 * servidor espera (`depois_de`, o vizinho da esquerda). Arrastar para outra
 * seção é o gesto de MUDAR DE GRUPO: quem trata é o pai
 * (`TemplatesClient`), que manda o `grupo_id` no PATCH e a posição na rota de
 * ordem.
 */
export interface PropsDeLista {
  templates: MessageTemplate[];
  podeMover: (template: MessageTemplate) => boolean;
  onEditar: (template: MessageTemplate) => void;
  onExcluir: (template: MessageTemplate) => void;
  aoSoltar: (resultado: DropResult) => void;
}

/**
 * O item — o `<li>` de sempre, extraído para as duas listas usarem o MESMO
 * markup. Duplicá-lo seria o jeito mais fácil de a lista agrupada divergir da
 * plana em um selo, um espaçamento ou um `aria-label`.
 */
function ItemDeResposta({
  template,
  podeMover,
  onEditar,
  onExcluir,
  dragHandleProps,
  arrastando,
  innerRef,
  draggableProps,
}: {
  template: MessageTemplate;
  podeMover: boolean;
  onEditar: (template: MessageTemplate) => void;
  onExcluir: (template: MessageTemplate) => void;
  dragHandleProps: Record<string, unknown> | null | undefined;
  arrastando: boolean;
  innerRef: (element: HTMLElement | null) => void;
  draggableProps: Record<string, unknown>;
}) {
  const t = useT();
  /**
   * A MESMA régua da barra e do envio (#3009). Aqui ela vira ETIQUETA: quantas
   * mídias de cada tipo a resposta leva — e o texto do lugar do corpo quando a
   * resposta é só mídia.
   */
  const leitura = lerRespostaRapidaGravada(template);
  const descricao = !leitura.ok
    ? t("Resposta rápida sem conteúdo")
    : leitura.texto.trim() !== ""
      ? leitura.texto
      : leitura.audios > 0
        ? t("Resposta rápida de áudio")
        : t("Resposta rápida de imagem");
  return (
    <li
      ref={innerRef}
      {...draggableProps}
      className={`flex items-start justify-between gap-4 rounded-md border bg-card p-4 ${
        arrastando ? "shadow-md ring-1 ring-accent/40" : ""
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        {podeMover && (
          <span
            {...dragHandleProps}
            aria-label={t("Arrastar para reordenar")}
            className="mt-0.5 shrink-0 cursor-grab text-muted-foreground"
          >
            <DragHandle />
          </span>
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{template.title}</span>
            <Badge variant={template.owner_user_id ? "neutral" : "default"}>
              {t(template.owner_user_id ? "Pessoal" : "Compartilhado")}
            </Badge>
            {leitura.ok && leitura.audios > 0 && <Badge variant="neutral">🎧 {t("Áudio")}</Badge>}
            {/* A resposta rápida que leva imagem do próprio operador (#2526) se
                anuncia na lista: sem isto, quem usa o menu "/" do composer não
                tem como saber qual script não é só texto até escolher. Com a
                régua da #3009, a resposta que leva os DOIS anuncia os dois. */}
            {leitura.ok && leitura.imagens > 0 && (
              <Badge variant="neutral">
                {t("Imagens")} {leitura.imagens}
              </Badge>
            )}
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground">{descricao}</p>
        </div>
      </div>
      {podeMover && (
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("Editar resposta rápida")}
            onClick={() => onEditar(template)}
          >
            <PencilSimple />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Excluir resposta rápida")}
              >
                <Trash />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Excluir esta resposta rápida?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("Essa ação não pode ser desfeita.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => onExcluir(template)}>
                  {t("Excluir")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </li>
  );
}

/**
 * A LISTA PLANA — o que a tela renderiza quando não há grupo nenhum. É o
 * componente de antes dos grupos, inteiro: mesmo `DragDropContext`, mesmo
 * `Droppable` e mesma ordem de itens.
 */
export function ListaPlana({ templates, podeMover, onEditar, onExcluir, aoSoltar }: PropsDeLista) {
  return (
    <DragDropContext onDragEnd={aoSoltar}>
      <Droppable droppableId="respostas-rapidas">
        {(provided) => (
          <ul ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
            {templates.map((template, indice) => {
              // Só o que a RLS deixa escrever pode ser arrastado: mover uma
              // resposta COMPARTILHADA exige manager+, e o `agent` que arrastasse
              // uma veria o soltar ser recusado pela policy.
              const movel = podeMover(template);
              return (
                <Draggable
                  key={template.id}
                  draggableId={template.id}
                  index={indice}
                  isDragDisabled={!movel}
                >
                  {(provido, instantaneo) => (
                    <ItemDeResposta
                      template={template}
                      podeMover={movel}
                      onEditar={onEditar}
                      onExcluir={onExcluir}
                      innerRef={provido.innerRef}
                      draggableProps={provido.draggableProps as unknown as Record<string, unknown>}
                      dragHandleProps={provido.dragHandleProps as Record<string, unknown> | null}
                      arrastando={instantaneo.isDragging}
                    />
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
          </ul>
        )}
      </Droppable>
    </DragDropContext>
  );
}

/** O `droppableId` de uma seção — o mesmo vocabulário que o pai lê no `DropResult`. */
export function chaveDaSecao(grupo: GrupoDeRespostas | null): string {
  return grupo ? `grupo:${grupo.id}` : "sem-grupo";
}

interface PropsAgrupada extends PropsDeLista {
  grupos: GrupoDeRespostas[];
  /** Só `manager+` vê renomear/excluir/reordenar — a mesma régua da policy. */
  podeGerirGrupos: boolean;
  onRenomearGrupo: (grupo: GrupoDeRespostas) => void;
  onExcluirGrupo: (grupo: GrupoDeRespostas) => void;
  onMoverGrupo: (grupo: GrupoDeRespostas, direcao: -1 | 1) => void;
}

/**
 * A LISTA EM SEÇÕES (#3245). Os cabeçalhos são os grupos, na ordem deles, com a
 * seção "Sem grupo" no fim — e ela só aparece quando existe resposta sem grupo,
 * porque um cabeçalho vazio não diz nada a ninguém.
 *
 * O grupo VAZIO aparece de propósito: é o grupo que a pessoa acabou de criar, e
 * é nele que ela vai soltar a primeira resposta. Escondê-lo faria o "criei o
 * grupo" parecer que não funcionou.
 */
export function ListaAgrupada({
  templates,
  grupos,
  podeMover,
  podeGerirGrupos,
  onEditar,
  onExcluir,
  aoSoltar,
  onRenomearGrupo,
  onExcluirGrupo,
  onMoverGrupo,
}: PropsAgrupada) {
  const t = useT();
  const secoes = secoesDeRespostas(templates, grupos);
  // Defesa: quem chama já conferiu que há grupo. Sem grupo, a lista de hoje.
  if (!secoes) return <ListaPlana {...{ templates, podeMover, onEditar, onExcluir, aoSoltar }} />;

  return (
    <DragDropContext onDragEnd={aoSoltar}>
      <div className="space-y-6">
        {secoes.map((secao, posicaoDaSecao) => {
          const chave = chaveDaSecao(secao.grupo);
          const primeiro = posicaoDaSecao === 0;
          const ultimo = posicaoDaSecao === secoes.length - 1 || secao.grupo === null;
          return (
            <section key={chave} data-testid="secao-de-respostas" data-secao={chave}>
              <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-1">
                <h2 className="text-sm font-semibold tracking-tight">
                  {secao.grupo ? secao.grupo.name : t("Sem grupo")}
                </h2>
                {secao.grupo && podeGerirGrupos && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label={t("Mover grupo para cima")}
                      disabled={primeiro}
                      onClick={() => onMoverGrupo(secao.grupo!, -1)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t("Mover grupo para baixo")}
                      disabled={ultimo}
                      onClick={() => onMoverGrupo(secao.grupo!, 1)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={t("Renomear grupo")}
                      onClick={() => onRenomearGrupo(secao.grupo!)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <PencilSimple />
                    </button>
                    <button
                      type="button"
                      aria-label={t("Excluir grupo")}
                      onClick={() => onExcluirGrupo(secao.grupo!)}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    >
                      <Trash />
                    </button>
                  </div>
                )}
              </div>
              <Droppable droppableId={chave}>
                {(provided) => (
                  <ul ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                    {secao.respostas.map((template, indice) => {
                      const movel = podeMover(template);
                      return (
                        <Draggable
                          key={template.id}
                          draggableId={template.id}
                          index={indice}
                          isDragDisabled={!movel}
                        >
                          {(provido, instantaneo) => (
                            <ItemDeResposta
                              template={template}
                              podeMover={movel}
                              onEditar={onEditar}
                              onExcluir={onExcluir}
                              innerRef={provido.innerRef}
                              draggableProps={provido.draggableProps as unknown as Record<string, unknown>}
                              dragHandleProps={
                                provido.dragHandleProps as Record<string, unknown> | null
                              }
                              arrastando={instantaneo.isDragging}
                            />
                          )}
                        </Draggable>
                      );
                    })}
                    {provided.placeholder}
                  </ul>
                )}
              </Droppable>
              {secao.respostas.length === 0 && (
                <p className="text-xs text-muted-foreground">{t("Nenhuma resposta neste grupo.")}</p>
              )}
            </section>
          );
        })}
      </div>
    </DragDropContext>
  );
}

/**
 * A PORTA DA TELA: com grupo, seções; sem grupo, a lista plana de hoje.
 *
 * A decisão é de `secoesDeRespostas` (uma função pura, com teste próprio) e não
 * daqui — quem escreve a próxima tela herda a régua, em vez de reinventar a
 * condição `grupos.length > 0`.
 */
export function ListaDeRespostas({
  grupos,
  ...props
}: PropsDeLista & {
  grupos?: GrupoDeRespostas[] | null;
  podeGerirGrupos?: boolean;
  onRenomearGrupo?: (grupo: GrupoDeRespostas) => void;
  onExcluirGrupo?: (grupo: GrupoDeRespostas) => void;
  onMoverGrupo?: (grupo: GrupoDeRespostas, direcao: -1 | 1) => void;
}) {
  const secoes = secoesDeRespostas(props.templates, grupos);
  if (!secoes) return <ListaPlana {...props} />;
  return (
    <ListaAgrupada
      {...props}
      grupos={grupos ?? []}
      podeGerirGrupos={props.podeGerirGrupos ?? false}
      onRenomearGrupo={props.onRenomearGrupo ?? (() => {})}
      onExcluirGrupo={props.onExcluirGrupo ?? (() => {})}
      onMoverGrupo={props.onMoverGrupo ?? (() => {})}
    />
  );
}
