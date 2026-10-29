"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FileText,
  Image as ImageIcon,
  Upload,
  Trash2,
  ExternalLink,
  Loader2,
  Eye,
  Download,
} from "lucide-react";
import type { LeadAttachment } from "@/app/api/v1/leads/[id]/attachments/route";

interface Props {
  fieldKey: string;
  label: string;
  required?: boolean;
  leadId?: string;
  /**
   * Só AVISA a lista atual (o diálogo de campos obrigatórios a usa para liberar
   * o botão). Nunca é para gravar em `custom_fields`: a fonte da verdade é
   * `crm_lead_attachments`, e é ela que a régua de etapa conta no servidor.
   */
  onChange?: (files: LeadAttachment[]) => void;
  disabled?: boolean;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function FileUploadCustomField({
  fieldKey,
  label,
  required = false,
  leadId,
  onChange,
  disabled = false,
}: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<LeadAttachment | null>(null);

  const [files, setFiles] = useState<LeadAttachment[]>([]);
  const avisar = useRef(onChange);
  useEffect(() => {
    avisar.current = onChange;
  });
  useEffect(() => {
    avisar.current?.(files);
  }, [files]);

  // A lista vem SEMPRE da tabela: o componente não recebe valor de fora.
  useEffect(() => {
    if (!leadId) return;

    let cancelado = false;
    async function carregarAnexos() {
      try {
        const res = await fetch(
          `/api/v1/leads/${leadId}/attachments?field_key=${encodeURIComponent(fieldKey)}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (!cancelado) setFiles((json.data?.files ?? []) as LeadAttachment[]);
      } catch {
        if (!cancelado) toast.error(t("Não foi possível carregar os anexos."));
      }
    }
    void carregarAnexos();
    return () => {
      cancelado = true;
    };
  }, [leadId, fieldKey, t]);

  async function uploadFiles(selectedFiles: File[]) {
    if (selectedFiles.length === 0) return;

    if (!leadId) {
      toast.error(t("Salve o lead antes de anexar arquivos."));
      return;
    }

    setIsUploading(true);
    let currentList = [...files];

    try {
      for (const selectedFile of selectedFiles) {
        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("field_key", fieldKey);

        const res = await fetch(`/api/v1/leads/${leadId}/attachments`, {
          method: "POST",
          body: formData,
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = json.error?.message || json.message || t("Falha ao subir arquivo.");
          throw new Error(msg);
        }

        currentList = json.data?.files || [...currentList, json.data?.attachment];
        setFiles(currentList);
      }

      toast.success(
        selectedFiles.length === 1
          ? t("Arquivo anexado com sucesso!")
          : t("{n} arquivos anexados com sucesso!").replace("{n}", String(selectedFiles.length)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("Erro desconhecido");
      toast.error(msg);
    } finally {
      setIsUploading(false);
    }
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(e.target.files || []);
    e.target.value = "";
    if (selectedFiles.length > 0) {
      void uploadFiles(selectedFiles);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !isUploading) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled || isUploading) return;

    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (droppedFiles.length > 0) {
      void uploadFiles(droppedFiles);
    }
  }

  async function handleRemove(attachmentId: string) {
    if (disabled || isUploading) return;

    if (leadId) {
      try {
        const res = await fetch(`/api/v1/leads/${leadId}/attachments`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ field_key: fieldKey, attachment_id: attachmentId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = json.error?.message || json.message || t("Falha ao remover arquivo.");
          throw new Error(msg);
        }
        setFiles(json.data?.files || files.filter((f) => f.id !== attachmentId));
        toast.success(t("Arquivo removido."));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Erro ao remover."));
      }
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`space-y-2 md:col-span-2 rounded-md border p-3 transition-colors ${
        isDragging
          ? "border-primary bg-primary/10 ring-2 ring-primary/20"
          : "border-border bg-card/40"
      }`}
    >
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold text-text">
          {label}
          {required && <span className="ml-1 text-error-fg">*</span>}
        </Label>
        <span className="text-[11px] text-text-muted">
          {files.length} {files.length === 1 ? t("arquivo") : t("arquivos")}
        </span>
      </div>

      {/* Lista de Arquivos Anexados */}
      {files.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {files.map((file) => {
            const isImage = file.type?.startsWith("image/");
            const isPdf = file.type === "application/pdf";
            const fileUrl =
              file.url ||
              (leadId ? `/api/v1/leads/${leadId}/attachments/${file.id}/media` : "");

            return (
              <div
                key={file.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/80 bg-background/80 px-2.5 py-1.5 text-xs shadow-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isImage ? (
                    <ImageIcon className="h-4 w-4 shrink-0 text-sky-500" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-amber-500" />
                  )}
                  <span className="truncate font-medium text-text" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-muted">
                    ({formatBytes(file.size)})
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {/* Botão de Visualização / Preview em Modal (Prioridade 2) */}
                  {(isPdf || isImage) && fileUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviewAttachment({ ...file, url: fileUrl })}
                      className="inline-flex items-center gap-1 rounded-md p-1 text-text-muted hover:text-primary hover:bg-muted"
                      title={t("Visualizar documento")}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {/* Link Externo / Download Direto */}
                  {fileUrl && (
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md p-1 text-text-muted hover:text-text hover:bg-muted"
                      title={t("Abrir em nova aba / Baixar")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}

                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => handleRemove(file.id)}
                      className="rounded-md p-1 text-error-fg hover:bg-error-fg/10"
                      title={t("Remover arquivo")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Área de Drop & Botão de Upload */}
      {!disabled && (
        <div className="pt-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg,image/webp,image/jpg"
            className="hidden"
            onChange={handleFileSelected}
            disabled={isUploading || disabled}
          />

          <div
            onClick={() => !isUploading && fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed py-3 px-4 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/80 hover:border-primary/50 hover:bg-muted/40 text-text-muted"
            } ${isUploading ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            {isUploading ? (
              <div className="flex items-center gap-2 text-xs font-medium text-primary">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t("Enviando arquivo(s)…")}</span>
              </div>
            ) : isDragging ? (
              <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                <Upload className="h-4 w-4 animate-bounce" />
                <span>{t("Solte os arquivos aqui para enviar")}</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-text">
                  <Upload className="h-3.5 w-3.5 text-text-muted" />
                  <span>{t("Arraste arquivos aqui ou clique para selecionar")}</span>
                </div>
                <span className="text-[10px] text-text-muted">
                  {t("PDF, PNG, JPG ou WebP (até 50 MB)")}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal de Pré-Visualização de Documentos (PDF / Imagem) */}
      <Dialog
        open={!!previewAttachment}
        onOpenChange={(aberto) => !aberto && setPreviewAttachment(null)}
      >
        <DialogContent className="max-w-4xl w-[95vw] max-h-[92vh] flex flex-col p-4 rounded-md">
          <DialogHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/80">
            <div className="flex items-center gap-2 min-w-0 pr-4">
              {previewAttachment?.type?.startsWith("image/") ? (
                <ImageIcon className="h-4 w-4 shrink-0 text-sky-500" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-amber-500" />
              )}
              <DialogTitle className="text-sm font-semibold truncate text-text">
                {previewAttachment?.name}
              </DialogTitle>
              {previewAttachment?.size ? (
                <span className="shrink-0 text-xs text-text-muted font-normal">
                  ({formatBytes(previewAttachment.size)})
                </span>
              ) : null}
            </div>

            {previewAttachment?.url && (
              <a
                href={previewAttachment.url}
                download={previewAttachment.name}
                className="inline-flex items-center gap-1.5 text-xs font-medium rounded-md px-2.5 py-1.5 bg-muted hover:bg-muted/80 text-text transition-colors mr-6"
                title={t("Baixar arquivo")}
              >
                <Download className="h-3.5 w-3.5" />
                <span>{t("Baixar")}</span>
              </a>
            )}
          </DialogHeader>

          <div className="flex-1 w-full overflow-hidden flex items-center justify-center min-h-[50vh] pt-2">
            {previewAttachment?.type?.startsWith("image/") ? (
              <div className="flex items-center justify-center w-full h-full p-2 bg-muted/20 rounded-md overflow-auto">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewAttachment.url}
                  alt={previewAttachment.name}
                  className="max-h-[75vh] w-auto max-w-full object-contain rounded-md shadow-sm"
                />
              </div>
            ) : previewAttachment?.type === "application/pdf" ? (
              <div className="w-full h-[75vh] rounded-md overflow-hidden border border-border bg-muted/10">
                <iframe
                  src={previewAttachment.url}
                  title={previewAttachment.name}
                  className="w-full h-full border-0 rounded-md"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-text-muted">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-sm">
                  {t("Pré-visualização indisponível para este formato.")}
                </p>
                {previewAttachment?.url && (
                  <a
                    href={previewAttachment.url}
                    download={previewAttachment.name}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 bg-primary text-primary-foreground text-xs font-medium shadow-sm hover:bg-primary/90"
                  >
                    <Download className="h-4 w-4" />
                    <span>{t("Baixar arquivo para visualizar")}</span>
                  </a>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
