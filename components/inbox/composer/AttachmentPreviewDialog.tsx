"use client";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";

interface Props {
  file: File | null;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): thumb ou card + legenda. */
export function AttachmentPreviewDialog({ file, sending, onCancel, onSend }: Props) {
  const [caption, setCaption] = useState("");
  useEffect(() => setCaption(""), [file]);

  const objectUrl = useMemo(() => (file && /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!file) return null;
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enviar anexo</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {isImage && objectUrl && (
            <img src={objectUrl} alt={file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && objectUrl && <video src={objectUrl} controls className="max-h-64 rounded-md" />}
          {!isImage && !isVideo && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
            </div>
          )}
        </div>
        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Legenda (opcional)"
          aria-label="Legenda"
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            Cancelar
          </Button>
          <Button onClick={() => onSend(caption.trim())} disabled={sending}>
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
