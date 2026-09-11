"use client";
import { useMemo } from "react";
import { useAdminConversation } from "@/hooks/useAdminConversation";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { TenantBadge } from "@/components/admin/inbox/TenantBadge";
import { AdminSidePanel } from "./AdminSidePanel";
import { CircleNotch, Lock } from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import type { Message } from "@/lib/types/messaging";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Status badge color
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  open: "default",
  resolved: "outline",
  closed: "outline",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  conversationId: string;
}

export function AdminThreadClient({ conversationId }: Props) {
  const t = useT();
  const { data, isLoading, isError } = useAdminConversation(conversationId);

  // Messages come in desc order from API — reverse for chronological display
  const messages = useMemo<Message[]>(() => {
    const msgs = data?.messages ?? [];
    return [...msgs].reverse() as Message[];
  }, [data?.messages]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <CircleNotch size={24} className="animate-spin" aria-label={t("Carregando")} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        {t("Falha ao carregar conversa.")}
      </div>
    );
  }

  const { conversation, organization, contact } = data;
  const contactName = contact?.name?.trim() || contact?.phone_number || t("Sem nome");
  const statusVariant = STATUS_VARIANT[conversation.status] ?? "outline";

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      {/* ── Thread area ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{contactName}</span>
              <Badge variant={statusVariant} className="h-5 px-2 text-[10px] capitalize">
                {conversation.status}
              </Badge>
            </div>
            {organization && (
              <div className="mt-0.5">
                <TenantBadge
                  name={organization.display_name}
                  slug={organization.slug}
                  size="sm"
                />
              </div>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto py-2">
          {messages.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {t("Sem mensagens nesta conversa.")}
            </p>
          ) : (
            // Sem `viewerUserId` de propósito: quem lê aqui é o super-admin da
            // plataforma, olhando a conversa de OUTRA organização. Nenhuma
            // mensagem é dele, então "Você" seria falso em todas — sem o id, o
            // balão rotula "Atendente", que é o que o dado sustenta.
            messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
          )}
        </div>

        {/* Composer — disabled (read-only) */}
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-3">
          <Lock size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">
            {t("Modo somente-leitura.")}{" "}
            <span className="font-medium">
              {t("Use “Impersonate” (em breve, S-11.07) para responder.")}
            </span>
          </span>
        </div>
      </div>

      {/* ── Side panel ── */}
      <AdminSidePanel data={data} />
    </div>
  );
}
