"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { Label } from "@/components/ui/label";
import { FileText, Image as ImageIcon, Upload, Trash2, ExternalLink, Loader2 } from "lucide-react";
import type { LeadAttachment } from "@/app/api/v1/leads/[id]/attachments/route";

interface Props {
  fieldKey: string;
  label: string;
  required?: boolean;
  leadId?: string;
  value?: unknown;
  onChange: (files: LeadAttachment[]) => void;
  disabled?: boolean;
}

function parseFileList(val: unknown): LeadAttachment[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as LeadAttachment[];
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed as LeadAttachment[];
    } catch {
      return [];
    }
  }
  return [];
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
  value,
  onChange,
  disabled = false,
}: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const files = parseFileList(value);

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

        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.message || t("Falha ao subir arquivo."));
        }

        currentList = json.data?.files || [...currentList, json.data?.attachment];
        onChange(currentList);
      }

      toast.success(
        selectedFiles.length === 1
          ? t("Arquivo anexado com sucesso!")
          : t(`${selectedFiles.length} arquivos anexados com sucesso!`),
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
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.message || t("Falha ao remover arquivo."));
        }
        onChange(json.data?.files || files.filter((f) => f.id !== attachmentId));
        toast.success(t("Arquivo removido."));
        return;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Erro ao remover."));
        return;
      }
    }

    onChange(files.filter((f) => f.id !== attachmentId));
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`space-y-2 md:col-span-2 rounded-lg border p-3 transition-colors ${
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
            return (
              <div
                key={file.id}
                className="flex items-center justify-between gap-2 rounded border border-border/80 bg-background/80 px-2.5 py-1.5 text-xs shadow-sm"
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
                  {file.url && (
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded p-1 text-text-muted hover:text-text hover:bg-muted"
                      title={t("Abrir / Baixar arquivo")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => handleRemove(file.id)}
                      className="rounded p-1 text-error-fg hover:bg-error-fg/10"
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
    </div>
  );
}
