"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText, X } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";

interface Props {
  /**
   * Uma FILA, não um arquivo (#2526).
   *
   * O "+" do composer escolhe uma e a lista tem um; a resposta rápida traz as
   * várias que o operador carregou no template. As duas continuam no MESMO
   * diálogo porque é o mesmo contrato: preview, legenda, remover e só então
   * enviar — o operador aprova antes de qualquer byte sair.
   */
  files: File[];
  /**
   * O texto da resposta rápida, que entra como legenda da PRIMEIRA imagem —
   * o mesmo contrato do envio de mídia que já existe. `null` no caminho do
   * "+", onde a legenda nasce vazia.
   */
  legendaInicial?: string | null;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
  /**
   * Tira UM item da fila antes do envio (#2526: "o operador pode remover
   * imagem antes de enviar"). Leva a legenda do momento para que tirar uma
   * imagem não apague o que o operador já editou.
   */
  onRemove?: (indice: number, caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): capa, demais imagens e legenda. */
export function AttachmentPreviewDialog({
  files,
  legendaInicial = null,
  sending,
  onCancel,
  onSend,
  onRemove,
}: Props) {
  const t = useT();
  const [caption, setCaption] = useState("");
  // As deps são ESTADOS (`files` vem do state do composer), então isto roda na
  // troca da fila e não a cada tecla digitada na legenda.
  useEffect(() => setCaption(legendaInicial ?? ""), [files, legendaInicial]);

  // PAR resolvido de uma vez: arquivo + URL do preview. É o que mantém
  // `noUncheckedIndexedAccess` feliz (nenhum índice cru vira `src`) e mantém a
  // ordem da fila casada com a ordem de envio.
  const itens = useMemo(
    () =>
      files.map((file) => ({
        file,
        url: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null,
      })),
    [files],
  );
  useEffect(
    () => () => {
      for (const item of itens) if (item.url) URL.revokeObjectURL(item.url);
    },
    [itens],
  );

  const capa = itens.at(0);
  if (!capa) return null;
  const demais = itens.slice(1);
  const isImage = capa.file.type.startsWith("image/");
  const isVideo = capa.file.type.startsWith("video/");

  const remover = (indice: number) =>
    onRemove && (
      <button
        type="button"
        onClick={() => onRemove(indice, caption.trim())}
        disabled={sending}
        aria-label={t("Remover imagem")}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <X size={12} weight="bold" aria-hidden />
      </button>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enviar anexo")}</DialogTitle>
        </DialogHeader>
        <div className="relative flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {remover(0)}
          {isImage && capa.url && (
            <img src={capa.url} alt={capa.file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && capa.url && <video src={capa.url} controls className="max-h-64 rounded-md" />}
          {!isImage && !isVideo && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{capa.file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(capa.file.size)}</p>
              </div>
            </div>
          )}
        </div>
        {/*
          As demais imagens da fila (#2526): a PRIMEIRA é a capa e leva a
          legenda; estas entram em seguida, cada uma como sua mensagem, na
          MESMA ordem em que aparecem aqui — trocar a ordem na tela sem trocar
          na fila mandaria as fotos fora de ordem.
        */}
        {demais.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {demais.map((item, i) => (
              <li key={`${item.file.name}-${i}`} className="relative">
                {item.file.type.startsWith("image/") && item.url ? (
                  <img
                    src={item.url}
                    alt={item.file.name}
                    className="size-14 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-14 items-center justify-center rounded-md border border-border bg-muted/40">
                    <FileText size={18} weight="duotone" className="text-muted-foreground" aria-hidden />
                  </div>
                )}
                {remover(i + 1)}
              </li>
            ))}
          </ul>
        )}
        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t("Legenda (opcional)")}
          aria-label={t("Legenda")}
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => onSend(caption.trim())} disabled={sending}>
            {t("Enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
