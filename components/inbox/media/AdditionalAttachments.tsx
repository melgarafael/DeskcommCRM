"use client";
import { useT } from "@/hooks/i18n/useT";
import type { Message } from "@/lib/types/messaging";
import { formatBytes } from "./media-utils";

/** Anexos adicionais preservam a mensagem original, sem criar bolhas fictícias. */
export function AdditionalAttachments({ message }: { message: Message }) {
  const t = useT();
  const hasPrimary = Boolean(message.media_storage_path || message.media_url);
  const items = (message.attachments ?? []).filter(item => item.position > 0 || !hasPrimary);
  if (items.length === 0) return null;
  return <ul className="mt-2 space-y-1 text-xs" aria-label={t("Anexos da mensagem")}>
    {items.map(item => <li key={item.id} className="rounded-md border border-current/20 p-2">
      {item.availability === "available" ? <a
        className="underline underline-offset-2"
        href={`/api/v1/messages/${message.id}/media?attachment_id=${item.id}`}
        target="_blank" rel="noreferrer"
      >{item.file_name ?? t("Arquivo")} · {formatBytes(item.size_bytes)}</a>
        : <span>{item.file_name ?? t("Arquivo")} · {t("Anexo indisponível na origem.")}</span>}
    </li>)}
  </ul>;
}
