"use client";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ChatCircle } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";

/**
 * Aba WHATSAPP do 360°: porta para a conversa + prévia da última mensagem.
 * Não duplica o inbox — anuncia o canal e dá a porta (mesma decisão do
 * ConversaNoDossie no dossiê do kanban).
 */
export function WhatsappDoContato({
  conversa,
}: {
  conversa: Contact["conversa"] | null | undefined;
}) {
  const t = useT();
  if (!conversa) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
        {t("Este cliente ainda não tem conversa no WhatsApp.")}
      </div>
    );
  }

  const preview = conversa.preview?.trim();

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-2.5">
        <ChatCircle
          size={20}
          weight="regular"
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">{t("Conversa no WhatsApp")}</p>
          {preview ? (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{preview}</p>
          ) : null}
          {conversa.unread > 0 ? (
            <p className="mt-0.5 text-xs font-medium text-accent-700">
              {conversa.unread} {t("mensagem(ns) sem ler")}
            </p>
          ) : null}
        </div>
      </div>
      <Button asChild variant="primary" size="sm">
        <Link href={`/app/inbox?id=${conversa.id}`}>{t("Abrir conversa no Inbox")}</Link>
      </Button>
    </div>
  );
}
