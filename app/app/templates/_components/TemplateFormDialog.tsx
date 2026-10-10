"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { useUploadTemplateMedia } from "@/hooks/templates/useUploadTemplateMedia";
import { MAXIMO_DE_MIDIAS, TAMANHO_MAXIMO_DA_MIDIA, type MidiaDeTemplate } from "@/lib/templates/midias";

const TEMPLATES_KEY = ["message-templates"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canShare: boolean;
  template?: MessageTemplate | null;
}

interface CreateInput {
  title: string;
  body: string;
  shortcut?: string;
  shared?: boolean;
}

interface UpdateInput {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  midias?: MidiaDeTemplate[];
}

export function TemplateFormDialog({ open, onOpenChange, canShare, template }: Props) {
  const t = useT();
  const isEdit = !!template;
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [shortcut, setShortcut] = React.useState("");
  const [shared, setShared] = React.useState(false);
  /**
   * As IMAGENS da Resposta rápida (#2526) — três estados, e cada um tem um
   * motivo:
   *
   *  `gravadas`  o que JÁ está no bucket e na linha (o template editado).
   *  `removidas` o que o operador tirou NESTA edição: nada sai do bucket antes
   *              do Salvar — cancelar tem de devolver o template inteiro.
   *  `novas`     os arquivos escolhidos, que só sobem no Salvar (a rota gera o
   *              caminho e devolve a lista gravada).
   */
  const [gravadas, setGravadas] = React.useState<MidiaDeTemplate[]>([]);
  const [removidas, setRemovidas] = React.useState<string[]>([]);
  const [novas, setNovas] = React.useState<File[]>([]);

  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: CreateInput) =>
      apiClient.post<{ data: MessageTemplate }>("/api/v1/message-templates", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const update = useMutation({
    mutationFn: async ({ id, ...input }: UpdateInput) =>
      apiClient.patch<{ data: MessageTemplate }>(`/api/v1/message-templates/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
  const upload = useUploadTemplateMedia();
  const pending = create.isPending || update.isPending || upload.isPending;

  const urlsNovas = React.useMemo(() => novas.map((file) => URL.createObjectURL(file)), [novas]);
  React.useEffect(
    () => () => {
      for (const url of urlsNovas) URL.revokeObjectURL(url);
    },
    [urlsNovas],
  );

  React.useEffect(() => {
    if (!open) return;
    setTitle(template?.title ?? "");
    setBody(template?.body ?? "");
    setShortcut(template?.shortcut ?? "");
    setShared(template ? template.owner_user_id === null : false);
    setGravadas(template?.midias ?? []);
    setRemovidas([]);
    setNovas([]);
  }, [open, template]);

  const mantidas = gravadas.filter((m) => !removidas.includes(m.storage_path));
  const total = mantidas.length + novas.length;
  const estourou = total > MAXIMO_DE_MIDIAS;

  /** O preview da imagem JÁ gravada sai da própria rota de leitura. */
  function urlDaGravada(midia: MidiaDeTemplate): string {
    const indice = gravadas.indexOf(midia);
    return `/api/v1/message-templates/${template?.id}/midias/${indice}`;
  }

  function escolherArquivos(lista: FileList | null) {
    if (!lista) return;
    const aceitas: File[] = [];
    for (const file of Array.from(lista)) {
      // A MESMA régua da rota (que confere pela ASSINATURA dos bytes): aqui é
      // só o aviso honesto antes do upload, não a autorização.
      if (!/^image\/(jpeg|png)$/.test(file.type)) {
        toast.error(t("A imagem precisa ser JPG ou PNG."));
        continue;
      }
      if (file.size > TAMANHO_MAXIMO_DA_MIDIA) {
        toast.error(t("A imagem precisa ter até 5 MB."));
        continue;
      }
      aceitas.push(file);
    }
    if (aceitas.length) setNovas((atual) => [...atual, ...aceitas]);
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isEdit) {
        // 1) Imagem nova: a ROTA gera o caminho e devolve a lista já gravada —
        //    é dela que parte o passo seguinte, para os dois não disputarem a
        //    ordem da lista.
        let lista = gravadas;
        for (const file of novas) lista = await upload.mutateAsync({ templateId: template.id, file });
        // 2) Remoção: o PATCH recebe a lista COMPLETA do que permanece e a rota
        //    apaga do bucket o que saiu. Só manda `midias` quando algo saiu —
        //    um PATCH que reescreve a lista sem mudar nada só arriscaria o
        //    `conflict` da tela atrasada.
        const mantidasAqui = lista.filter((m) => !removidas.includes(m.storage_path));
        await update.mutateAsync({
          id: template.id,
          title,
          body,
          shortcut: shortcut.trim() || null,
          ...(mantidasAqui.length !== lista.length ? { midias: mantidasAqui } : {}),
        });
        toast.success(t("Template atualizado."));
      } else {
        const criado = await create.mutateAsync({
          title,
          body,
          shortcut: shortcut.trim() || undefined,
          shared: canShare ? shared : false,
        });
        // A partir daqui o template JÁ existe: deixar o diálogo aberto faria o
        // próximo clique criar um segundo. O `finally` fecha mesmo quando o
        // upload falha — a imagem que não subiu entra pela edição, que é onde
        // ela aparece de qualquer forma.
        try {
          for (const file of novas) {
            await upload.mutateAsync({ templateId: criado.data.id, file });
          }
        } finally {
          qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
          onOpenChange(false);
        }
        toast.success(t("Template criado."));
      }
      onOpenChange(false);
    } catch {
      /* erro já mostrado pelo showApiError */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("Editar template") : t("Novo template")}</DialogTitle>
          <DialogDescription>
            {t("Scripts salvos para responder mais rápido no atendimento.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tpl-title">{t("Título")}</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("Saudação inicial")}
              minLength={1}
              maxLength={80}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-body">{t("Mensagem")}</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("Oi {{primeiro_nome}}, tudo bem?")}
              minLength={1}
              maxLength={4096}
              required
              rows={5}
            />
            <p className="text-xs text-muted-foreground">
              {t("Use")} {"{{primeiro_nome}}"} {t("e")} {"{{nome}}"} {t("para personalizar.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-shortcut">{t("Atalho (opcional)")}</Label>
            <Input
              id="tpl-shortcut"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder="oi"
              maxLength={40}
            />
          </div>
          {/*
            AS IMAGENS (#2526) — o operador carrega as dele, sem depender do
            catálogo de produtos. Prévia e remoção existem porque a aprovação é
            dele: o que entra na conversa tem de ser o que ele viu aqui.
          */}
          <div className="space-y-2">
            <Label htmlFor="tpl-midias">{t("Imagens (opcional)")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("JPG ou PNG, até 5 MB por imagem. A imagem vai junto com o texto.")}
            </p>
            {(mantidas.length > 0 || novas.length > 0) && (
              <ul className="flex flex-wrap gap-2">
                {mantidas.map((midia) => (
                  <li key={midia.storage_path} className="relative">
                    <img
                      src={urlDaGravada(midia)}
                      alt={t("Imagem da resposta rápida")}
                      className="size-16 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setRemovidas((atual) => [...atual, midia.storage_path])}
                      aria-label={t("Remover imagem")}
                      className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
                {novas.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="relative">
                    <img
                      src={urlsNovas[i]}
                      alt={t("Prévia da imagem")}
                      className="size-16 rounded-md border border-border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setNovas((atual) => atual.filter((_, j) => j !== i))}
                      aria-label={t("Remover imagem")}
                      className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Input
                id="tpl-midias"
                type="file"
                accept="image/jpeg,image/png"
                multiple
                className="sr-only"
                onChange={(e) => {
                  escolherArquivos(e.target.files);
                  // Sem isto, escolher o MESMO arquivo duas vezes seguidas não
                  // disparava `change` — e a segunda escolha some em silêncio.
                  e.target.value = "";
                }}
              />
              <Label
                htmlFor="tpl-midias"
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted"
              >
                {t("Adicionar imagem")}
              </Label>
              {estourou && (
                <p className="text-xs text-destructive">
                  {t("Cada resposta rápida tem no máximo 5 imagens.")}
                </p>
              )}
            </div>
          </div>
          {canShare && (
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-shared"
                checked={shared}
                onCheckedChange={setShared}
                disabled={isEdit}
              />
              <Label htmlFor="tpl-shared">{t("Compartilhar com a equipe")}</Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || estourou}>
              {isEdit ? t("Salvar") : t("Criar template")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
