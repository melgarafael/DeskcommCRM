"use client";
import { PipelineThemePreview, CalendarThemePreview } from "./AreaPreviews";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type { Message } from "@/lib/types/messaging";
import { inboxArea, inboxFiltersArea, inboxHeaderArea } from "@/lib/ui-themes/areas";
import { UiThemeArea, useUiThemeArea } from "./Area";

function message(id: string, direction: "inbound" | "outbound", body: string): Message {
  const at = "2026-01-01T12:00:00.000Z";
  return {
    id,
    organization_id: "preview",
    conversation_id: "preview",
    channel_session_id: "preview",
    contact_id: "preview",
    external_id: null,
    type: "text",
    direction,
    status: "read",
    ack: 3,
    error_code: null,
    error_message: null,
    body,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: at,
    delivered_at: at,
    read_at: at,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: at,
  };
}
/** Real message/controls components with synthetic data and no command handlers. */
function InboxThemePreview() {
  const t = useT();
  const { regionClass } = useUiThemeArea(inboxArea);
  const list = (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border p-3">
        <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} className="w-full" tabIndex={-1}>
          {t("Iniciar conversa")}
        </Button>
      </div>
      <UiThemeArea
        contract={inboxFiltersArea}
        slots={{
          search: (
            <input
              aria-label={t("Buscar conversas")}
              placeholder={t("Buscar conversas")}
              className="w-full rounded-md border px-2"
              readOnly
              tabIndex={-1}
            />
          ),
          views: (
            <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} variant="ghost" className="w-full justify-start">
              {t("Todas as conversas")}
            </Button>
          ),
          quick: (
            <>
              <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} variant="outline">{t("Não lidos")}</Button>
              <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} variant="outline">{t("Grupos")}</Button>
            </>
          ),
          advanced: <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} variant="outline">{t("Filtros")}</Button>,
          selection: null,
        }}
        fallback={
          <div className={`border-b border-border p-3 ${regionClass("filters") ?? ""}`}>
            <p className="text-sm font-medium">{t("Todas as conversas")}</p>
            <p className="mt-2 text-xs text-text-muted">{t("Buscar conversa")}</p>
          </div>
        }
      />
      <div className="border-b border-border bg-accent-soft p-4">
        <p className="text-sm font-semibold">{t("Contato de exemplo")}</p>
        <p className="mt-1 text-xs text-text-muted">{t("Uma conversa para visualizar o tema")}</p>
      </div>
    </aside>
  );
  const conversation = (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <UiThemeArea
        contract={inboxHeaderArea}
        slots={{
          identity: (
            <div>
              <p className="text-sm font-semibold">{t("Contato de exemplo")}</p>
              <p className="text-xs text-text-muted">{t("Conversa de demonstração")}</p>
            </div>
          ),
          primary: <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")}>{t("Assumir")}</Button>,
          tools: null,
          actions: (
            <Button disabled title={t("Amostra visual: use esta ação na página correspondente.")} variant="ghost" aria-label={t("Mais ações da conversa")}>
              ⋯
            </Button>
          ),
          notices: null,
        }}
        fallback={
          <header
            className={`border-b border-border bg-surface p-4 ${regionClass("header") ?? ""}`}
          >
            <p className="text-sm font-semibold">{t("Contato de exemplo")}</p>
            <p className="text-xs text-text-muted">{t("Conversa de demonstração")}</p>
          </header>
        }
      />
      <div
        className={`flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 ${regionClass("history") ?? ""}`}
      >
        <MessageBubble
          message={message("preview-in", "inbound", t("Olá! Podemos conversar por aqui?"))}
        />
        <MessageBubble
          message={message(
            "preview-out",
            "outbound",
            t("Sim. Esta é uma amostra visual do atendimento."),
          )}
        />
      </div>
      <div className={`border-t border-border bg-surface p-3 ${regionClass("composer") ?? ""}`}>
        <Textarea
          readOnly
          tabIndex={-1}
          aria-label={t("Mensagem de exemplo")}
          placeholder={t("Digite sua mensagem…")}
        />
      </div>
    </section>
  );
  const contact = (
    <aside className="h-full overflow-y-auto border-l border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">{t("Contato")}</h3>
      <p className="mt-4 text-sm">{t("Contato de exemplo")}</p>
      <p className="mt-2 text-xs text-text-muted">{t("Informações e atividades aparecem aqui.")}</p>
    </aside>
  );
  return (
    <div className="h-[540px] w-full overflow-hidden text-text" inert>
      <UiThemeArea
        contract={inboxArea}
        rootProps={{ className: "h-full" }}
        slots={{ list, conversation, contact }}
        fallback={
          <div className="grid h-full grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_260px]">
            <div className="hidden min-h-0 md:block">{list}</div>
            {conversation}
            <div className="hidden min-h-0 xl:block">{contact}</div>
          </div>
        }
      />
    </div>
  );
}

export function ThemePreview({ areaId = "inbox" }: { areaId?: string }) {
  const t = useT();
  if (areaId === "pipeline") return <PipelineThemePreview />;
  if (areaId === "calendar") return <CalendarThemePreview />;
  if (["inbox", "inbox-filters", "inbox-header"].includes(areaId)) return <InboxThemePreview />;
  return (
    <p className="p-6 text-sm text-text-muted">
      {t(
        "Esta área ainda não oferece uma amostra. Confira a aparência na página correspondente antes de aplicar.",
      )}
    </p>
  );
}
