"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
type Draft = {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
};
export function ReplyReviewPanel({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const t = useT(),
    qc = useQueryClient(),
    key = ["reply-drafts", conversationId];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      apiClient.get<{ data: { drafts: Draft[] } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    refetchInterval: 4000,
    retry: false,
  });
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{
      draftId: string;
      message: string;
      kind: "success" | "error";
    } | null>(null);
  const draft = query.data?.data.drafts[0];
  const body = draft ? (edits[draft.id] ?? draft.edited_body ?? draft.original_body ?? "") : "";
  async function generate() {
    setNotice(null);
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/conversations/${conversationId}/draft-reply`, {});
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
    } finally {
      setBusy(false);
    }
  }
  async function decide(action: "approve" | "reject") {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiClient.post(`/api/v1/ai/replies/${draft.id}`, {
        action,
        revision: draft.revision,
        body,
        feedback,
      });
      setNotice({
        draftId: draft.id,
        kind: "success",
        message:
          action === "approve"
            ? t("Resposta aprovada. Acompanhe o envio aqui.")
            : t("Sugestão rejeitada. O feedback será usado na próxima sugestão."),
      });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
      setNotice({
        draftId: draft.id,
        kind: "error",
        message: t(
          "Sua edição foi preservada. Confira se a conversa mudou antes de aprovar novamente.",
        ),
      });
      await qc.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
    }
  }
  const statuses: Record<string, string> = {
    generating: "Preparando sugestão…",
    pending: "Sugestão para revisar",
    approved: "Resposta aprovada: aguardando envio",
    sending: "Enviando resposta aprovada…",
    sent: "Resposta aprovada enviada",
    dismissed: "Sugestão rejeitada",
    stale: "Sugestão obsoleta: a conversa mudou",
    failed: "Não foi possível concluir a sugestão ou o envio",
  };
  return (
    <section
      className="mb-3 space-y-2 rounded-md border bg-muted/30 p-3"
      aria-label={t("Assistência do agente")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {t(draft ? (statuses[draft.status] ?? "Assistência do agente") : "Assistência do agente")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={generate}
        >
          {t(busy ? "Preparando…" : "Sugerir resposta")}
        </Button>
      </div>
      {draft && (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              "Aprovar envia somente este texto. Não altera dados, agenda ou a autonomia do agente.",
            )}
          </p>
          {body && (
            <Textarea
              aria-label={t("Resposta sugerida")}
              value={body}
              onChange={(e) => setEdits({ ...edits, [draft.id]: e.target.value })}
              disabled={disabled || busy || draft.status !== "pending"}
              rows={3}
            />
          )}
          {draft.proposals.length > 0 && (
            <details className="text-xs">
              <summary>{t("Ações propostas: precisam de autorização separada")}</summary>
              <p>{t("Abra a ação correspondente no CRM ou na agenda para confirmar.")}</p>
              <ul>
                {draft.proposals.map((p, i) => (
                  <li key={i}>{p.tool}</li>
                ))}
              </ul>
            </details>
          )}
          {draft.status === "pending" && (
            <>
              <Input
                aria-label={t("Feedback para a próxima sugestão")}
                placeholder={t("Feedback para a próxima sugestão")}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                maxLength={1000}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || busy || !body.trim()}
                  onClick={() => decide("approve")}
                >
                  {t("Aprovar e enviar")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={() => decide("reject")}
                >
                  {t("Rejeitar")}
                </Button>
              </div>
            </>
          )}
          {draft.status === "failed" && (
            <p className="text-xs">
              {t("Confira a configuração do agente e tente gerar novamente.")}
            </p>
          )}
        </>
      )}
      {notice &&
        draft &&
        notice.draftId === draft.id &&
        (notice.kind === "error" ||
          ["approved", "sending", "sent", "dismissed"].includes(draft.status)) && (
          <p role="status" className="text-xs">
            {notice.message}
          </p>
        )}
    </section>
  );
}
