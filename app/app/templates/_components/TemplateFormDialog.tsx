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
import { TIPOS_DE_RECURSO, type TipoDeRecurso } from "@/lib/inbox/recursos";
import { useUploadTemplateMedia } from "@/hooks/templates/useUploadTemplateMedia";
import {
  MAXIMO_DE_MIDIAS,
  TAMANHO_MAXIMO_DA_MIDIA,
  TAMANHO_MAXIMO_DO_AUDIO,
  ehMidiaDeAudio,
  midiaDeAudioDe,
  type MidiaDeTemplate,
} from "@/lib/templates/midias";

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
  /** "Mostrar na barra do Inbox" (#3282) — ausente é ligado. */
  mostrar_na_barra?: boolean;
}

interface UpdateInput {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  midias?: MidiaDeTemplate[];
  /** "Mostrar na barra do Inbox" (#3282). */
  mostrar_na_barra?: boolean;
}

/**
 * O FORMULÁRIO DO RECURSO (#2833 sobre a tela da #2526) — texto ou áudio.
 *
 * O que mudou no redesenho: o ÁUDIO não tem coluna, bucket nem rota próprios.
 * Ele é uma entrada de `midias`, gravada pela MESMA rota que sobe as imagens
 * (`POST /message-templates/:id/midias`), que gera o caminho, fareja os bytes e
 * aplica o teto do tipo. Com isso o formulário também não tem upload paralelo:
 * o arquivo de áudio sobe pelo `useUploadTemplateMedia`, igual a uma imagem.
 *
 * Consequência de desenho: o TIPO é um modo da TELA. Um recurso de áudio tem
 * exatamente uma entrada de áudio em `midias` e nenhuma imagem; um de texto tem
 * as imagens e nunca áudio. Trocar o modo AFASTA o que não pertence ao modo
 * novo — o PATCH manda a lista completa e a rota apaga do bucket o que saiu.
 */
export function TemplateFormDialog({ open, onOpenChange, canShare, template }: Props) {
  const t = useT();
  const isEdit = !!template;
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [shortcut, setShortcut] = React.useState("");
  const [shared, setShared] = React.useState(false);
  /**
   * "Mostrar na barra do Inbox" (#3282). Nasce LIGADO — o default da coluna e o
   * comportamento de quem já usava o produto.
   */
  const [mostrarNaBarra, setMostrarNaBarra] = React.useState(true);
  const [tipo, setTipo] = React.useState<TipoDeRecurso>("texto");
  // O arquivo de áudio escolhido NESTA edição; quando null, o recurso continua
  // com o áudio que já tem em `midias` (`audioAtual`).
  const [arquivo, setArquivo] = React.useState<File | null>(null);
  /**
   * As IMAGENS da Resposta rápida (#2526) — três estados, e cada um tem um
   * motivo:
   *
   *  `gravadas`  o que JÁ está no bucket e na linha (o template editado). Só as
   *              imagens: a entrada de áudio do recurso não é imagem e não
   *              entra nesta lista.
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

  /** A LISTA da linha, na ordem gravada — a posição é a URL da prévia. */
  const listaDa = React.useMemo(
    () => (template?.midias ?? []) as MidiaDeTemplate[],
    [template],
  );
  /** A entrada de áudio do recurso editado, se houver (#2833). */
  const audioAtual = midiaDeAudioDe(listaDa);

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
    // Ausente = ligado: linha anterior à coluna (e template recém-criado) aparece.
    setMostrarNaBarra(template ? template.mostrar_na_barra !== false : true);
    setTipo(midiaDeAudioDe(template?.midias) ? "audio" : "texto");
    setArquivo(null);
    setGravadas(((template?.midias ?? []) as MidiaDeTemplate[]).filter((m) => !ehMidiaDeAudio(m)));
    setRemovidas([]);
    setNovas([]);
  }, [open, template]);

  const mantidas = gravadas.filter((m) => !removidas.includes(m.storage_path));
  const total = mantidas.length + novas.length;
  const estourou = total > MAXIMO_DE_MIDIAS;

  /**
   * O preview da mídia JÁ gravada sai da própria rota de leitura. O índice é a
   * POSIÇÃO na linha — inclusive quando há uma entrada de áudio antes das
   * imagens: `gravadas` filtra o áudio, mas a rota serve por posição na lista
   * do banco.
   */
  function urlDaGravada(midia: MidiaDeTemplate): string {
    const indice = listaDa.findIndex((m) => m.storage_path === midia.storage_path);
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

  function escolherAudio(lista: FileList | null) {
    const file = lista?.[0] ?? null;
    if (!file) {
      setArquivo(null);
      return;
    }
    // Aviso antes do upload; quem decide é a rota, pelos bytes. O teto é o do
    // ÁUDIO (16 MB), não o da imagem.
    if (!/^audio\//.test(file.type)) {
      toast.error(t("O arquivo precisa ser de áudio."));
      return;
    }
    // M4A (o padrão do gravador do iPhone e do Mac) e WebM a rota recusa com
    // 415. Recusar AQUI, antes de o template existir, é o que impede a criação
    // de deixar uma resposta rápida sem texto e sem áudio.
    if (/^audio\/(mp4|x-m4a|m4a|webm)$/.test(file.type)) {
      toast.error(t("O áudio precisa ser OGG, MP3, AAC, AMR ou WAV."));
      return;
    }
    if (file.size > TAMANHO_MAXIMO_DO_AUDIO) {
      toast.error(t("O áudio precisa ter até 16 MB."));
      return;
    }
    setArquivo(file);
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Recurso de áudio precisa de um arquivo — o novo desta edição ou o que o
    // recurso já tem. Sem nenhum dos dois não haveria conteúdo nenhum: nem
    // texto (o modo áudio não tem campo) nem arquivo.
    if (tipo === "audio" && !arquivo && !audioAtual) {
      toast.error(t("Escolha um arquivo de áudio para a resposta rápida."));
      return;
    }
    // Recurso de áudio não tem corpo: o conteúdo é o arquivo.
    const corpo = tipo === "audio" ? "" : body;

    try {
      if (isEdit) {
        // 1) A LISTA FINAL: `[áudio]` no recurso de áudio (vazio enquanto o
        //    arquivo novo não subiu), as imagens mantidas no de texto. O PATCH
        //    só manda `midias` quando algo SAI de verdade — reescrever a lista
        //    sem mudança só arriscaria o `conflict` da tela atrasada. E a
        //    remoção vem PRIMEIRO pelo mesmo motivo da #2526: o teto de 5 vale
        //    a cada upload.
        //
        //    "Sai" é medido contra o que o FORM conhece (`gravadas` + a entrada
        //    de áudio), não contra a prop `template`: no retry depois de um
        //    upload que falhou, o form já sabe que a imagem removida saiu — a
        //    prop ainda mostra a linha antiga.
        const listaNova: MidiaDeTemplate[] =
          tipo === "audio" ? (arquivo ? [] : audioAtual ? [audioAtual] : []) : mantidas;
        const conhecidas: MidiaDeTemplate[] = audioAtual ? [...gravadas, audioAtual] : gravadas;
        const sai = conhecidas.filter(
          (m) => !listaNova.some((k) => k.storage_path === m.storage_path),
        );
        // TROCA de áudio: o novo sobe ANTES do PATCH que tira o antigo. Na ordem
        // inversa, um upload recusado deixava o recurso sem o áudio que
        // funcionava. A ordem remover-antes (#2526) só é necessária quando o
        // teto de 5 morderia, o que num recurso de áudio (1 + 1) não acontece.
        if (tipo === "audio" && arquivo && conhecidas.length < MAXIMO_DE_MIDIAS) {
          const lista = await upload.mutateAsync({ templateId: template.id, file: arquivo });
          const nova = lista.find((m) => !conhecidas.some((k) => k.storage_path === m.storage_path));
          await update.mutateAsync({
            id: template.id,
            title,
            body: corpo,
            shortcut: shortcut.trim() || null,
            mostrar_na_barra: mostrarNaBarra,
            ...(nova ? { midias: [nova] } : {}),
          });
          setGravadas([]);
          setRemovidas([]);
          setArquivo(null);
          toast.success(t("Resposta rápida atualizada."));
          onOpenChange(false);
          return;
        }
        await update.mutateAsync({
          id: template.id,
          title,
          body: corpo,
          shortcut: shortcut.trim() || null,
          mostrar_na_barra: mostrarNaBarra,
          ...(sai.length ? { midias: listaNova } : {}),
        });
        if (sai.length) {
          setGravadas(listaNova.filter((m) => !ehMidiaDeAudio(m)));
          setRemovidas([]);
        }
        // 2) O ARQUIVO NOVO sobe pela MESMA rota das imagens (#2833): ela gera
        //    e confere o caminho, e o teto do áudio é dela. A rota devolve a
        //    lista completa já gravada.
        const subir = tipo === "audio" ? (arquivo ? [arquivo] : []) : novas;
        for (const file of subir) {
          const lista = await upload.mutateAsync({ templateId: template.id, file });
          setGravadas(lista.filter((m) => !ehMidiaDeAudio(m)));
          if (file === arquivo) setArquivo(null);
          setNovas((atual) => atual.filter((f) => f !== file));
        }
        toast.success(t("Resposta rápida atualizada."));
      } else {
        const criado = await create.mutateAsync({
          title,
          body: corpo,
          shortcut: shortcut.trim() || undefined,
          shared: canShare ? shared : false,
          mostrar_na_barra: mostrarNaBarra,
        });
        // A partir daqui o template JÁ existe: deixar o diálogo aberto faria o
        // próximo clique criar um segundo. O `finally` fecha mesmo quando o
        // upload falha — a mídia que não subiu entra pela edição, que é onde
        // ela aparece de qualquer forma.
        try {
          const subir = tipo === "audio" ? (arquivo ? [arquivo] : []) : novas;
          for (const file of subir) {
            await upload.mutateAsync({ templateId: criado.data.id, file });
          }
        } catch (erro) {
          // Recurso de áudio sem o áudio não tem conteúdo nenhum: ficaria na
          // barra do Inbox como um botão vazio. Desfaz a criação.
          if (tipo === "audio") {
            await apiClient
              .delete(`/api/v1/message-templates/${criado.data.id}`)
              .catch(showApiError);
          }
          throw erro;
        } finally {
          qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
          onOpenChange(false);
        }
        toast.success(t("Resposta rápida criada."));
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
          <DialogTitle>{isEdit ? t("Editar resposta rápida") : t("Nova resposta rápida")}</DialogTitle>
          <DialogDescription>
            {t("Respostas rápidas: o texto cai no campo editável do Inbox; a imagem e o áudio entram na fila de anexos, com prévia, e você revisa antes de enviar.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t("Tipo de resposta rápida")}</Label>
            <div className="flex gap-1">
              {TIPOS_DE_RECURSO.map((opcao) => (
                <Button
                  key={opcao}
                  type="button"
                  variant={tipo === opcao ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTipo(opcao)}
                >
                  {opcao === "texto" ? t("Texto") : t("Áudio")}
                </Button>
              ))}
            </div>
          </div>
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
          {tipo === "texto" ? (
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
          ) : (
            <div className="space-y-2">
              <Label htmlFor="tpl-audio">{t("Arquivo de áudio")}</Label>
              <Input
                id="tpl-audio"
                type="file"
                accept=".ogg,.opus,.mp3,.aac,.amr,.wav"
                onChange={(e) => escolherAudio(e.target.files)}
                required={!audioAtual}
              />
              {/* A prévia do áudio ATUAL sai da mesma rota das imagens (por
                  posição): é o arquivo que o recurso já tem em `midias`. */}
              {audioAtual && !arquivo && (
                <audio
                  controls
                  preload="none"
                  src={urlDaGravada(audioAtual)}
                  className="h-9 w-full"
                  aria-label={t("Áudio da resposta rápida")}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {audioAtual && !arquivo
                  ? t("Áudio atual mantido. Escolha outro arquivo para substituir.")
                  : t("O áudio fica na biblioteca e entra no Inbox na fila de anexos, como o `/`.")}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="tpl-shortcut">{t("Atalho (opcional)")}</Label>
            <Input
              id="tpl-shortcut"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              placeholder={t("oi")}
              maxLength={40}
            />
          </div>
          {tipo === "texto" && (
            /*
              AS IMAGENS (#2526) — o operador carrega as dele, sem depender do
              catálogo de produtos. Prévia e remoção existem porque a aprovação
              é dele: o que entra na conversa tem de ser o que ele viu aqui.
            */
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
          )}
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
          {/*
            "MOSTRAR NA BARRA DO INBOX" (#3282) — o liga/desliga por resposta
            rápida. Nasce LIGADO (default da coluna e da tela): quem já usava o
            produto continua vendo tudo na barra. Desmarcado, o botão sai da
            barra e a resposta CONTINUA no atalho `/` — a dica abaixo diz isso,
            porque a confusão natural é achar que apagar da barra apaga a resposta.
          */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-na-barra"
                checked={mostrarNaBarra}
                onCheckedChange={setMostrarNaBarra}
              />
              <Label htmlFor="tpl-na-barra">{t("Mostrar na barra do Inbox")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Desmarcado, a resposta sai da barra do Inbox e continua no atalho /.")}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || (tipo === "texto" && estourou)}>
              {isEdit ? t("Salvar") : t("Criar resposta rápida")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
