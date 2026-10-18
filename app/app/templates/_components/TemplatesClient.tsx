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
import { PIX_KEYS_QUERY, usePixKeys, type PixKey } from "@/hooks/inbox/usePixKeys";
import { TemplateFormDialog } from "./TemplateFormDialog";
import { PixKeyFormDialog } from "./PixKeyFormDialog";

const TEMPLATES_KEY = ["message-templates"];

const TIPO_LABEL: Record<string, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
  email: "E-mail",
  random: "Chave aleatória",
  phone: "Celular",
};

interface Props {
  canShare: boolean;
  currentUserId: string;
}

export function TemplatesClient({ canShare, currentUserId }: Props) {
  const t = useT();
  const { data: templates, isLoading } = useMessageTemplates();
  const { data: pixKeys, isLoading: pixLoading } = usePixKeys();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/message-templates/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const delPix = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/pix-keys/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: PIX_KEYS_QUERY }),
  });
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MessageTemplate | null>(null);
  const [pixFormOpen, setPixFormOpen] = React.useState(false);
  const [editingPix, setEditingPix] = React.useState<PixKey | null>(null);

  const idDoModelo = useSearchParams()?.get("modelo") ?? null;
  const [abertoPelaUrl, setAbertoPelaUrl] = React.useState(false);

  const canModify = React.useCallback(
    (template: MessageTemplate) =>
      template.owner_user_id === currentUserId || (template.owner_user_id === null && canShare),
    [canShare, currentUserId],
  );
  const canModifyPix = React.useCallback(
    (key: PixKey) =>
      key.owner_user_id === currentUserId || (key.owner_user_id === null && canShare),
    [canShare, currentUserId],
  );

  React.useEffect(() => {
    if (abertoPelaUrl || !idDoModelo) return;
    const alvo = templates?.find((template) => template.id === idDoModelo);
    if (!alvo) return;
    setAbertoPelaUrl(true);
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
  const openNewPix = () => {
    setEditingPix(null);
    setPixFormOpen(true);
  };
  const openEditPix = (key: PixKey) => {
    setEditingPix(key);
    setPixFormOpen(true);
  };

  if (isLoading || pixLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={openNewPix} className="w-full sm:w-auto">
            <Plus /> {t("Nova chave Pix")}
          </Button>
          <Button type="button" onClick={openNew} className="w-full sm:w-auto">
            <Plus /> {t("Nova resposta")}
          </Button>
        </div>

        {!templates?.length ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma resposta rápida ainda.")}</p>
        ) : (
          <ul className="space-y-2">
            {templates.map((template) => {
              return (
                <li
                  key={template.id}
                  className="flex items-start justify-between gap-4 rounded-md border bg-card p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {template.shortcut ? `/${template.shortcut}` : template.title}
                      </span>
                      <Badge variant={template.owner_user_id ? "neutral" : "default"}>
                        {t(template.owner_user_id ? "Pessoal" : "Todos")}
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
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">{t("Chaves Pix")}</h2>
        {!pixKeys?.length ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhuma chave Pix cadastrada. Use o botão Nova chave Pix.")}
          </p>
        ) : (
          <ul className="space-y-2">
            {pixKeys.map((key) => (
              <li
                key={key.id}
                className="flex items-start justify-between gap-4 rounded-md border bg-card p-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{key.name}</span>
                    <Badge className="bg-orange-500 text-white hover:bg-orange-500">
                      {t("Pix")}
                    </Badge>
                    <Badge variant="neutral">{t(TIPO_LABEL[key.key_type] ?? key.key_type)}</Badge>
                    <Badge variant={key.owner_user_id ? "neutral" : "default"}>
                      {t(key.owner_user_id ? "Somente eu" : "Todos")}
                    </Badge>
                    {/* A resposta rápida que leva imagem do próprio operador
                        (#2526) se anuncia na lista: sem isto, quem usa o menu
                        "/" do composer não tem como saber qual script não é
                        só texto até escolher. */}
                    {template.midias && template.midias.length > 0 && (
                      <Badge variant="neutral">
                        {t("Imagens")} {template.midias.length}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{key.key_value}</p>
                </div>
                {canModifyPix(key) && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Editar chave Pix")}
                      onClick={() => openEditPix(key)}
                    >
                      <PencilSimple />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("Excluir chave Pix")}
                        >
                          <Trash />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("Excluir esta chave Pix?")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("Essa ação não pode ser desfeita.")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              delPix.mutate(key.id, {
                                onSuccess: () => toast.success(t("Chave Pix excluída.")),
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
            ))}
          </ul>
        )}
      </section>

      <TemplateFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        canShare={canShare}
        template={editing}
      />
      <PixKeyFormDialog
        open={pixFormOpen}
        onOpenChange={setPixFormOpen}
        canShare={canShare}
        pixKey={editingPix}
      />
    </div>
  );
}
