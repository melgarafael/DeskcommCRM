"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Plus, PencilSimple, Trash, DragHandle } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  CHAVE_DOS_TEMPLATES,
  useMessageTemplates,
  useMoverTemplate,
  type MessageTemplate,
} from "@/hooks/inbox/useMessageTemplates";
import { ehRecursoDeAudio } from "@/lib/inbox/recursos";
import { TemplateFormDialog } from "./TemplateFormDialog";

const TEMPLATES_KEY = CHAVE_DOS_TEMPLATES;

interface Props {
  canShare: boolean;
  currentUserId: string;
}

/**
 * A LISTA QUE O OPERADOR ORDENA (#3244).
 *
 * ─── O que o arrasto manda no fio ───────────────────────────────────────────
 *
 * O VIZINHO da esquerda (`depois_de`), nunca o índice: é o que a rota
 * (`PUT /api/v1/message-templates/[id]/ordem`) espera, e é o que faz a posição
 * gravada sobreviver a uma lista que mudou entre o arrasto e a resposta — a
 * mesma decisão da reordenação de etapa do funil e do quadro.
 *
 * ─── A ordem otimista, e por que ela é LOCAL ────────────────────────────────
 *
 * `@hello-pangea/dnd` repinta a lista pelo que o pai renderiza: sem uma ordem
 * nova no MESMO render do `onDragEnd`, a linha solta voltaria para o lugar de
 * origem e só depois saltaria, quando o refetch da invalidação chegasse. A ordem
 * fica num estado local e é DESCARTADA quando a resposta chega (sucesso ou
 * erro): quem manda na tela continua sendo o servidor, e um `ordem` que o
 * backend calculou diferente não fica preso na tela.
 */
export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading } = useMessageTemplates();
  const qc = useQueryClient();
  const mover = useMoverTemplate();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
  // A ordem que o dedo do operador acabou de desenhar, enquanto o servidor não
  // respondeu. `null` = a tela segue a lista do servidor (o caso normal).
  const [ordemOtimista, setOrdemOtimista] = React.useState<string[] | null>(null);
  // Deep link: `/app/templates?modelo=<id>` abre aquele modelo. É o link que a
  // integração devolve ("use o modelo X") e que a tela não tinha — sem ele, quem
  // recebe a mensagem cai na lista e tem de caçar de qual texto se falava.
  // `?.` porque o hook devolve null fora de um contexto de navegação (o que
  // acontece em teste e em render estático), como no resto do repo.
  const idDoModelo = useSearchParams()?.get("modelo") ?? null;
  const [abertoPelaUrl, setAbertoPelaUrl] = React.useState(false);
  // Só quem pode editar/apagar pela RLS vê as ações: o dono do pessoal, ou
  // manager+ no compartilhado (owner null). Sem isto, um agent veria botões
  // que o backend rejeita (404/nada apagado).
  const canModify = React.useCallback(
    (template: MessageTemplate) =>
      template.owner_user_id === currentUserId || (template.owner_user_id === null && canShare),
    [canShare, currentUserId],
  );

  /**
   * A lista RENDERIZADA: a do servidor, com a ordem otimista por cima enquanto
   * ela existe. Ids que sumiram da lista (outra aba excluiu) são descartados e o
   * resto entra no fim — nunca some linha da tela por causa de uma ordem velha.
   */
  const lista = React.useMemo(() => {
    const base = templates ?? [];
    if (!ordemOtimista) return base;
    const porId = new Map(base.map((template) => [template.id, template]));
    const ordenada = ordemOtimista.flatMap((id) => {
      const achado = porId.get(id);
      return achado ? [achado] : [];
    });
    const fora = base.filter((template) => !ordemOtimista.includes(template.id));
    return [...ordenada, ...fora];
  }, [templates, ordemOtimista]);

  React.useEffect(() => {
    if (abertoPelaUrl || !idDoModelo) return;
    // A lista chega depois: enquanto ela não tem o modelo pedido, NÃO marca como
    // aberto — marcar aqui faria o link depender de o dado já estar em cache.
    const alvo = templates?.find((template) => template.id === idDoModelo);
    if (!alvo) return;
    setAbertoPelaUrl(true);
    // O link só abre a EDIÇÃO para quem pode editar — a mesma régua da lista.
    // Um agent que recebe o link de um compartilhado fica na lista, onde o
    // modelo está visível: abrir o form ali seria um Salvar que a RLS recusa.
    if (!canModify(alvo)) return;
    setEditing(alvo);
    setFormOpen(true);
  }, [abertoPelaUrl, idDoModelo, templates, canModify]);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (template: MessageTemplate) => {
    setEditing(template);
    setFormOpen(true);
  };

  /**
   * O fim do arrasto: reordena LOCAL, manda o vizinho e limpa o otimista quando
   * o servidor responde — é ele quem decide a ordem final.
   *
   * `destination.index` é a posição NOVA, contada na lista já sem a linha
   * arrastada (é assim que o dnd entrega o `DropResult`): o vizinho da esquerda
   * é `nova[d - 1]`, e `null` quando a linha solta na primeira posição.
   */
  const aoSoltar = (resultado: DropResult) => {
    const { source, destination, draggableId } = resultado;
    if (!destination || destination.index === source.index) return;
    const ids = lista.map((template) => template.id);
    const semArrastado = ids.filter((id) => id !== draggableId);
    semArrastado.splice(destination.index, 0, draggableId);
    setOrdemOtimista(semArrastado);
    mover.mutate(
      {
        id: draggableId,
        depoisDe: semArrastado[destination.index - 1] ?? null,
      },
      {
        onError: (erro) => {
          setOrdemOtimista(null);
          showApiError(erro);
        },
        onSuccess: async () => {
          await qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
          setOrdemOtimista(null);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex sm:justify-end">
        <Button type="button" onClick={openNew} className="w-full sm:w-auto">
          <Plus /> {t("Nova resposta rápida")}
        </Button>
      </div>
      {!templates?.length ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma resposta rápida ainda.")}</p>
      ) : (
        <DragDropContext onDragEnd={aoSoltar}>
          <Droppable droppableId="respostas-rapidas">
            {(provided) => (
              <ul ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                {lista.map((template, indice) => {
                  // Só o que a RLS deixa escrever pode ser arrastado: mover uma
                  // resposta COMPARTILHADA exige manager+, e o `agent` que
                  // arrastasse uma veria o soltar ser recusado pela policy.
                  const podeMover = canModify(template);
                  return (
                    <Draggable
                      key={template.id}
                      draggableId={template.id}
                      index={indice}
                      isDragDisabled={!podeMover}
                    >
                      {(provido, instantaneo) => (
                        <li
                          ref={provido.innerRef}
                          {...provido.draggableProps}
                          className={`flex items-start justify-between gap-4 rounded-md border bg-card p-4 ${
                            instantaneo.isDragging ? "shadow-md ring-1 ring-accent/40" : ""
                          }`}
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            {podeMover && (
                              <span
                                {...provido.dragHandleProps}
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
                                {ehRecursoDeAudio(template) && (
                                  <Badge variant="neutral">🎧 {t("Áudio")}</Badge>
                                )}
                                {/* A resposta rápida que leva imagem do próprio operador
                                    (#2526) se anuncia na lista: sem isto, quem usa o menu
                                    "/" do composer não tem como saber qual script não é
                                    só texto até escolher. */}
                                {!ehRecursoDeAudio(template) &&
                                  template.midias &&
                                  template.midias.length > 0 && (
                                    <Badge variant="neutral">
                                      {t("Imagens")} {template.midias.length}
                                    </Badge>
                                  )}
                              </div>
                              <p className="line-clamp-2 text-sm text-muted-foreground">
                                {ehRecursoDeAudio(template)
                                  ? t("Resposta rápida de áudio")
                                  : template.body}
                              </p>
                            </div>
                          </div>
                          {canModify(template) && (
                            <div className="flex shrink-0 gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={t("Editar resposta rápida")}
                                onClick={() => openEdit(template)}
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
                                    <AlertDialogTitle>
                                      {t("Excluir esta resposta rápida?")}
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {t("Essa ação não pode ser desfeita.")}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        del.mutate(template.id, {
                                          onSuccess: () =>
                                            toast.success(t("Resposta rápida excluída.")),
                                        })
                                      }
                                    >
                                      {t("Excluir")}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                        </li>
                      )}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </ul>
            )}
          </Droppable>
        </DragDropContext>
      )}
      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        canShare={canShare}
        template={editing}
      />
    </div>
  );
}
