"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

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
import { Plus, PencilSimple, Trash } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { TemplateFormDialog } from "./TemplateFormDialog";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  canShare: boolean;
  currentUserId: string;
}

export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading } = useMessageTemplates();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
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
          <Plus /> {t("Novo template")}
        </Button>
      </div>
      {!templates?.length ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum template ainda.")}</p>
      ) : (
        <ul className="space-y-2">
          {templates.map((template) => {
            return (
              <li
                key={template.id}
                className="flex items-start justify-between gap-4 rounded-md border bg-card p-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{template.title}</span>
                    <Badge variant={template.owner_user_id ? "neutral" : "default"}>
                      {t(template.owner_user_id ? "Pessoal" : "Compartilhado")}
                    </Badge>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{template.body}</p>
                </div>
                {canModify(template) && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Editar template")}
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
                          aria-label={t("Excluir template")}
                        >
                          <Trash />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("Excluir este template?")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("Essa ação não pode ser desfeita.")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              del.mutate(template.id, {
                                onSuccess: () => toast.success(t("Template excluído.")),
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
            );
          })}
        </ul>
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
