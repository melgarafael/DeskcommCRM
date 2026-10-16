"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText, Plus, Trash, CaretLeft, CaretRight, VideoCamera } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";
import { cn } from "@/lib/utils";

interface Props {
  file?: File | null;
  files?: File[];
  sending: boolean;
  uploadProgress?: { current: number; total: number } | null;
  onCancel: () => void;
  onRemoveFile?: (index: number) => void;
  onAddFiles?: (files: File[]) => void;
  onSend: (caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): suporta 1 ou múltiplos arquivos com carrossel/miniaturas. */
export function AttachmentPreviewDialog({
  file,
  files,
  sending,
  uploadProgress,
  onCancel,
  onRemoveFile,
  onAddFiles,
  onSend,
}: Props) {
  const t = useT();
  const fileList = useMemo(() => {
    if (files && files.length > 0) return files;
    if (file) return [file];
    return [];
  }, [file, files]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [caption, setCaption] = useState("");
  const addMoreRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCaption("");
    setActiveIndex(0);
  }, [fileList.length === 0]);

  // Garante que o activeIndex não aponte para um índice removido
  useEffect(() => {
    if (activeIndex >= fileList.length && fileList.length > 0) {
      setActiveIndex(fileList.length - 1);
    }
  }, [fileList.length, activeIndex]);

  const currentFile = fileList[activeIndex] ?? fileList[0];

  // Gera object URL para o arquivo ativo
  const objectUrl = useMemo(() => {
    if (currentFile && /^(image|video)\//.test(currentFile.type)) {
      return URL.createObjectURL(currentFile);
    }
    return null;
  }, [currentFile]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  if (fileList.length === 0 || !currentFile) return null;

  const isImage = currentFile.type.startsWith("image/");
  const isVideo = currentFile.type.startsWith("video/");

  const handleAddMore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const novos = Array.from(e.target.files ?? []);
    if (novos.length > 0 && onAddFiles) {
      onAddFiles(novos);
    }
    e.target.value = "";
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between text-base">
            <span>{t("Enviar anexo")}</span>
            {fileList.length > 1 && (
              <span className="text-xs font-normal text-muted-foreground">
                {activeIndex + 1} {t("de")} {fileList.length}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Visualizador do arquivo ativo */}
        <div className="relative flex min-h-[220px] max-h-80 items-center justify-center rounded-lg bg-muted/40 p-2">
          {fileList.length > 1 && activeIndex > 0 && (
            <button
              type="button"
              onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
              className="absolute left-2 z-10 rounded-full bg-background/80 p-1.5 shadow-md hover:bg-background"
              aria-label={t("Arquivo anterior")}
            >
              <CaretLeft size={16} weight="bold" />
            </button>
          )}

          {isImage && objectUrl && (
            <img src={objectUrl} alt={currentFile.name} className="max-h-72 rounded-md object-contain" />
          )}
          {isVideo && objectUrl && (
            <video src={objectUrl} controls className="max-h-72 rounded-md" />
          )}
          {!isImage && !isVideo && (
            <div className="flex items-center gap-3 py-6">
              <FileText size={36} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="max-w-[280px] truncate font-medium">{currentFile.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(currentFile.size)}</p>
              </div>
            </div>
          )}

          {fileList.length > 1 && activeIndex < fileList.length - 1 && (
            <button
              type="button"
              onClick={() => setActiveIndex((i) => Math.min(fileList.length - 1, i + 1))}
              className="absolute right-2 z-10 rounded-full bg-background/80 p-1.5 shadow-md hover:bg-background"
              aria-label={t("Próximo arquivo")}
            >
              <CaretRight size={16} weight="bold" />
            </button>
          )}
        </div>

        {/* Barra de miniaturas para múltiplos arquivos (estilo WhatsApp) */}
        {fileList.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto py-1">
            {fileList.map((f, idx) => {
              const isSelected = idx === activeIndex;
              const isImg = f.type.startsWith("image/");
              return (
                <div
                  key={`${f.name}-${idx}-${f.size}`}
                  className={cn(
                    "group relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-muted/30 transition-all",
                    isSelected ? "ring-2 ring-primary border-primary" : "opacity-70 hover:opacity-100",
                  )}
                  onClick={() => setActiveIndex(idx)}
                >
                  {isImg ? (
                    <ThumbnailPreview file={f} />
                  ) : f.type.startsWith("video/") ? (
                    <div className="flex h-full w-full flex-col items-center justify-center p-1 text-[9px] text-muted-foreground">
                      <VideoCamera size={18} weight="duotone" className="text-primary" />
                      <span className="w-full truncate text-center">{f.name.split(".").pop() || "VÍDEO"}</span>
                    </div>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center p-1 text-[9px] text-muted-foreground">
                      <FileText size={18} weight="duotone" className="text-primary" />
                      <span className="w-full truncate text-center">{f.name.split(".").pop()}</span>
                    </div>
                  )}
                  {onRemoveFile && !sending && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFile(idx);
                      }}
                      className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive"
                      aria-label={t("Remover")}
                    >
                      <Trash size={10} />
                    </button>
                  )}
                </div>
              );
            })}

            {onAddFiles && !sending && (
              <>
                <button
                  type="button"
                  onClick={() => addMoreRef.current?.click()}
                  className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary"
                  title={t("Adicionar mais")}
                >
                  <Plus size={18} />
                  <span className="text-[9px]">{t("Mais")}</span>
                </button>
                <input
                  ref={addMoreRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleAddMore}
                />
              </>
            )}
          </div>
        )}

        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t("Legenda (opcional)")}
          aria-label={t("Legenda")}
          disabled={sending}
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {sending && uploadProgress ? (
              <span>{t("Enviando")} {uploadProgress.current} {t("de")} {uploadProgress.total}...</span>
            ) : (
              <span>{formatBytes(fileList.reduce((acc, f) => acc + f.size, 0))}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={sending}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => onSend(caption.trim())} disabled={sending}>
              {sending
                ? t("Enviando...")
                : fileList.length > 1
                ? `${t("Enviar")} (${fileList.length})`
                : t("Enviar")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ThumbnailPreview({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!src) return null;
  return <img src={src} alt={file.name} className="h-full w-full object-cover" />;
}
