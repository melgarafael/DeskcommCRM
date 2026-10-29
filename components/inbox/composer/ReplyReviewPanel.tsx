"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { chaveDosRascunhos, useRascunhoAssistido } from "@/hooks/inbox/useRascunhoAssistido";
import { motivoDoVeto } from "@/lib/agent-engine/agent/sugestao-de-resposta";
export function ReplyReviewPanel({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const t = useT(),
    qc = useQueryClient(),
    key = chaveDosRascunhos(conversationId);
  // A MESMA consulta que o `Composer` usa para decidir se este bloco existe
  // (issue #3027): uma chave, um cache, dois leitores. Antes dele montar o bloco
  // só quando há sugestão, `drafts[0]` era escolhido aqui — o critério não mudou,
  // mudou só quem pergunta.
  const { sugestao: draft } = useRascunhoAssistido(conversationId);
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    // Só o ERRO mora aqui: a confirmação virou toast (ver `decide`), porque o
    // bloco inteiro sai da tela quando a sugestão é decidida.
    [notice, setNotice] = useState<{ draftId: string; message: string } | null>(null);
  const body = draft ? (edits[draft.id] ?? draft.edited_body ?? draft.original_body ?? "") : "";
  // A causa do veto, em linguagem de quem opera (issue #2975): sem código
  // conhecido, a frase genérica de sempre continua sendo a verdade.
  const motivo = draft ? motivoDoVeto(draft.error_code) : null;
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
      // A CONFIRMAÇÃO VAI PARA O TOAST (issue #3027).
      //
      // Ela nasceu inline, dentro deste bloco, porque quem rejeita costuma pedir
      // outra sugestão em seguida e a tela esvaziava em silêncio. Só que agora o
      // bloco INTEIRO sai quando a sugestão é enviada ou descartada — o aviso
      // inline morreria junto com ele, e o silêncio voltaria. Toast sobrevive à
      // saída do bloco, e é onde as outras confirmações da tela já moram.
      toast.success(
        action === "approve"
          ? t("Resposta aprovada. Acompanhe o envio aqui.")
          : t("Sugestão rejeitada. O feedback será usado na próxima sugestão."),
      );
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      showApiError(e);
      setNotice({
        draftId: draft.id,
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
              {motivo
                ? t(motivo.texto)
                : t("Confira a configuração do agente e tente gerar novamente.")}
            </p>
          )}
        </>
      )}
      {/*
        O aviso de ERRO continua inline, amarrado ao rascunho que ele explica:
        "sua edição foi preservada" só faz sentido ao lado do texto preservado —
        como toast, ele chegaria depois, sem o bloco à vista para conferir.

        A confirmação de sucesso NÃO passa por aqui: ela é toast (ver `decide`),
        porque quando a sugestão sai da tela (enviada ou descartada) este bloco
        sai junto, e o aviso inline sairia com ele.
      */}
      {draft && notice && notice.draftId === draft.id && (
        <p role="status" className="text-xs">
          {notice.message}
        </p>
      )}
    </section>
  );
}
