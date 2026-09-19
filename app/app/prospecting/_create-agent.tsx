"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import type { CampaignConfig } from "@/lib/prospecting/schema";
import {
  prospectingAgentSetupSchema,
  type ProspectingAgentSetupInput,
} from "@/lib/prospecting/agent-setup-schema";
import { agentChatDraftSchema, type AgentChatResponse } from "@/lib/prospecting/agent-chat-schema";
import type { AgentSessionResponse } from "@/lib/prospecting/agent-session-schema";
import { useT } from "@/hooks/i18n/useT";
import { useAgentSetupSession } from "./_use-agent-session";
import { AgentSetupSummary } from "./_agent-summary";
import { AgentPreview } from "./_agent-preview";

type AgentSetup = Omit<
  ProspectingAgentSetupInput,
  "request_id" | "campaign_id" | "enable_router_continuity"
>;
export type CreatedProspectingAgent = {
  agent: { id: string; name: string };
  version_id: string;
  model_label: string;
};
type Props = {
  campaign: { id: string; name: string };
  config: CampaignConfig;
  channels: {
    id: string;
    display_name: string | null;
    phone_number: string | null;
    status: string;
  }[];
  stages: { id: string; name: string; pipeline_id: string; pipeline_name: string }[];
  onCreated: (
    campaignId: string,
    result: CreatedProspectingAgent,
    config: AgentSetup,
  ) => Promise<void>;
};

/** Configuration stays a proposal until explicit publication. Tests use a paused draft. */
export function ProspectingAgentBuilder(props: Props) {
  const t = useT();
  const store = useAgentSetupSession(props.campaign.id);
  const { session } = store;
  const [pending, setPending] = useState<"chat" | "create" | "prepare" | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [mode, setMode] = useState<"configure" | "preview">("configure");
  const [error, setError] = useState<string | null>(null);
  const [failedTurn, setFailedTurn] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const completed = useRef<string | null>(null);
  const mounted = useRef(true);
  const onCreated = useRef(props.onCreated);
  useEffect(() => {
    onCreated.current = props.onCreated;
  }, [props.onCreated]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [session?.messages.length, pendingText, pending]);
  useEffect(() => {
    if (!session?.completed || !session.attempt || completed.current === session.completed.agent.id)
      return;
    completed.current = session.completed.agent.id;
    void onCreated.current(props.campaign.id, session.completed, session.attempt).catch((cause) => {
      completed.current = null;
      setError(
        cause instanceof Error ? cause.message : "Não foi possível selecionar o agente salvo.",
      );
    });
  }, [props.campaign.id, session]);

  const draft = session?.draft ?? {};
  const channel = props.channels.find(
    (item) => item.id === draft.channel_session_id && item.status === "WORKING",
  );
  const pipeline = props.stages.find((item) => item.pipeline_id === draft.pipeline_id);
  const initialStage = props.stages.find((item) => item.id === draft.stage_id);
  const qualifiedStage = props.stages.find((item) => item.id === draft.qualified_stage_id);
  const ready =
    !!session?.ready &&
    !!channel &&
    !!pipeline &&
    !!initialStage &&
    !!qualifiedStage &&
    initialStage.pipeline_id === draft.pipeline_id &&
    qualifiedStage.pipeline_id === draft.pipeline_id &&
    draft.stage_id !== draft.qualified_stage_id &&
    !failedTurn;
  const busy = !!pending || previewBusy;
  const locked = busy || !!session?.uncertain || !!store.error;
  const recoveringPreparation = !!session?.uncertain && session.attempt_action !== "publish";

  async function send(value?: string) {
    const content = (value ?? store.current.current?.input ?? "").trim();
    if (submitting.current || previewBusy || !content || session?.uncertain || store.error) return;
    submitting.current = true;
    setPending("chat");
    setPendingText(content);
    setError(null);
    setFailedTurn(false);
    const abort = new AbortController();
    controller.current = abort;
    try {
      store.change({
        attempt: undefined,
        attempt_action: undefined,
        prepared: undefined,
        uncertain: false,
      });
      await store.flush();
      const current = store.current.current!;
      const chatDraft = { ...current.draft };
      if (!current.messages.length) {
        // Carry valid work from the manual alternative into the first chat turn.
        for (const field of [
          "instruction",
          "qualification",
          "channel_session_id",
          "pipeline_id",
          "stage_id",
          "qualified_stage_id",
        ] as const) {
          const value = props.config[field];
          if (
            !chatDraft[field] &&
            value &&
            agentChatDraftSchema.safeParse({ [field]: value }).success
          )
            chatDraft[field] = value;
        }
      }
      const previous =
        current.messages.at(-1)?.role === "user" ? current.messages.slice(0, -1) : current.messages;
      const messages = [...previous, { role: "user" as const, content }].slice(-24);
      while (
        messages.length > 1 &&
        messages.reduce((total, message) => total + message.content.length, 0) > 24000
      )
        messages.shift();
      const response = await apiClient.post<{ data: AgentChatResponse & AgentSessionResponse }>(
        "/api/v1/prospecting/agents/chat",
        {
          campaign_id: props.campaign.id,
          messages,
          draft: chatDraft,
          revision: store.revision.current,
        },
        { timeoutMs: 120_000, signal: abort.signal },
      );
      if (mounted.current && !abort.signal.aborted) store.accept(response.data);
    } catch (cause) {
      if (mounted.current) {
        try {
          await store.reload();
          store.change({
            input: content,
            attempt: undefined,
            attempt_action: undefined,
            prepared: undefined,
          });
          await store.flush();
        } catch {
          /* The persistence hook displays its actionable error. */
        }
        setFailedTurn(true);
        setError(
          abort.signal.aborted
            ? t("Resposta interrompida. Sua mensagem foi mantida para tentar novamente.")
            : cause instanceof Error
              ? cause.message
              : t("Não foi possível continuar a conversa."),
        );
      }
    } finally {
      submitting.current = false;
      controller.current = null;
      if (mounted.current) {
        setPending(null);
        setPendingText("");
      }
    }
  }

  async function saveAttempt(action: "prepare" | "publish") {
    await store.flush();
    const current = store.current.current!;
    const payload = {
      ...current.draft,
      campaign_id: props.campaign.id,
      enable_router_continuity: current.needs_continuity && current.enable_router_continuity,
    };
    const previous = current.attempt;
    const changed =
      previous &&
      Object.entries(payload).some(
        ([key, value]) =>
          key !== "enable_router_continuity" &&
          previous[key as keyof ProspectingAgentSetupInput] !== value,
      );
    const attempt = prospectingAgentSetupSchema.parse({
      ...payload,
      request_id: previous && (!changed || current.uncertain) ? previous.request_id : randomId(),
    });
    store.change({ attempt, attempt_action: action, uncertain: true });
    await store.flush();
    return attempt;
  }

  async function recoverMutation(cause: unknown) {
    const knownRejection =
      cause instanceof ApiError &&
      cause.status >= 400 &&
      cause.status < 500 &&
      cause.status !== 409 &&
      !cause.details?.agent_id;
    try {
      await store.reload();
      if (knownRejection) {
        store.change({ uncertain: false });
        await store.flush();
      }
    } catch {
      /* Preserve the stable attempt for a later authoritative reload. */
    }
  }

  async function prepare(): Promise<CreatedProspectingAgent> {
    if (!ready || store.error || (session?.uncertain && session.attempt_action === "publish"))
      throw new Error(
        t("Complete a configuração e recupere uma publicação pendente antes de testar."),
      );
    try {
      const attempt = await saveAttempt("prepare");
      const result = await apiClient.post<{ data: CreatedProspectingAgent }>(
        "/api/v1/prospecting/agents/prepare",
        attempt,
      );
      await store.reload();
      return result.data;
    } catch (cause) {
      await recoverMutation(cause);
      throw cause;
    }
  }

  async function recoverPreparation() {
    if (submitting.current || previewBusy || store.error) return;
    submitting.current = true;
    setPending("prepare");
    setError(null);
    try {
      await prepare();
      if (mounted.current) setMode("preview");
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : t("Não foi possível recuperar o rascunho."),
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function create() {
    if (
      !session ||
      recoveringPreparation ||
      !ready ||
      submitting.current ||
      previewBusy ||
      session.input.trim() ||
      store.error ||
      (session.needs_continuity && !session.enable_router_continuity)
    )
      return;
    submitting.current = true;
    setPending("create");
    setError(null);
    try {
      const attempt = await saveAttempt("publish");
      const result = await apiClient.post<{ data: CreatedProspectingAgent }>(
        "/api/v1/prospecting/agents",
        attempt,
      );
      completed.current = result.data.agent.id;
      await props.onCreated(props.campaign.id, result.data, attempt);
    } catch (cause) {
      await recoverMutation(cause);
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : t("Não foi possível publicar o agente."));
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  if (!session)
    return (
      <div className="p-5" role={store.error ? "alert" : "status"}>
        {store.error || t("Carregando sua conversa…")}
        {store.error && (
          <Button
            className="ml-3"
            variant="outline"
            onClick={() => void store.reload().catch(() => {})}
          >
            {t("Recarregar conversa salva")}
          </Button>
        )}
      </div>
    );

  const suggestions = session.choices.length
    ? session.choices
    : session.messages.length
      ? []
      : [
          {
            label: t("Qualificar interessados"),
            value: t(
              "Quero montar um agente para descobrir o problema do cliente e qualificar interessados.",
            ),
          },
          {
            label: t("Agendar uma conversa"),
            value: t(
              "Quero que o agente entenda a necessidade e convide o cliente para uma conversa com a equipe.",
            ),
          },
        ];
  return (
    <section aria-label={t("Configuração por conversa")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t("Vamos montar seu agente")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Conte o que você quer alcançar. O resumo acompanha suas escolhas.")}
          </p>
        </div>
        <span role="status" className="text-xs text-muted-foreground">
          {store.saving
            ? t("Salvando…")
            : store.error
              ? t("Conversa com alterações não salvas")
              : t("Conversa salva no CRM")}
        </span>
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(240px,1fr)]">
        <div className="min-w-0 overflow-hidden rounded-xl border">
          <div
            className="flex gap-2 border-b p-2"
            role="group"
            aria-label={t("Modo do assistente")}
          >
            <Button
              type="button"
              size="sm"
              variant={mode === "configure" ? "secondary" : "ghost"}
              disabled={busy}
              aria-pressed={mode === "configure"}
              onClick={() => setMode("configure")}
            >
              {t("Configurar conversando")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "preview" ? "secondary" : "ghost"}
              disabled={
                busy ||
                !ready ||
                !!session.input.trim() ||
                !!store.error ||
                (session.uncertain && session.attempt_action === "publish")
              }
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              {t("Testar como cliente")}
            </Button>
          </div>
          {mode === "configure" ? (
            <>
              <div
                ref={transcript}
                className="max-h-[460px] min-h-56 space-y-4 overflow-y-auto p-4"
                role="log"
                aria-label={t("Conversa para criar agente")}
                aria-live="polite"
              >
                <div className="mr-5 rounded-xl rounded-tl-sm bg-muted p-3 text-sm">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t("Assistente de configuração")}
                  </p>
                  <p>
                    {t("O que você oferece e o que quer descobrir na conversa com essas empresas?")}
                  </p>
                </div>
                {session.messages.map((message, index) => (
                  <div
                    key={index}
                    className={
                      message.role === "user"
                        ? "ml-5 rounded-xl rounded-tr-sm bg-primary p-3 text-sm text-primary-foreground"
                        : "mr-5 rounded-xl rounded-tl-sm bg-muted p-3 text-sm"
                    }
                  >
                    <p className="mb-1 text-xs font-medium opacity-70">
                      {message.role === "user" ? t("Você") : t("Assistente de configuração")}
                    </p>
                    <p className="break-words whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))}
                {pendingText && session.messages.at(-1)?.content !== pendingText && (
                  <div className="ml-5 rounded-xl bg-primary p-3 text-sm text-primary-foreground">
                    <p className="break-words whitespace-pre-wrap">{pendingText}</p>
                  </div>
                )}
                {pending === "chat" && (
                  <div
                    role="status"
                    className="flex items-center justify-between gap-2 text-sm text-muted-foreground"
                  >
                    <span>{t("Organizando suas escolhas e preparando a próxima pergunta…")}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => controller.current?.abort()}
                    >
                      {t("Cancelar resposta")}
                    </Button>
                  </div>
                )}
                {!locked && suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((choice, index) => (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto py-2 text-left whitespace-normal"
                        key={`${index}:${choice.value}`}
                        onClick={() => void send(choice.value)}
                      >
                        {choice.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <form
                className="space-y-3 border-t p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <Label htmlFor="agent-builder-message" className="sr-only">
                  {t("Mensagem para configurar o agente")}
                </Label>
                <Textarea
                  id="agent-builder-message"
                  rows={2}
                  maxLength={3000}
                  placeholder={t("Conte o que você quer que o agente faça…")}
                  value={session.input}
                  disabled={locked}
                  onChange={(event) => store.change({ input: event.target.value })}
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={locked || !session.input.trim()}>
                    {pending === "chat" ? t("Preparando resposta…") : t("Enviar mensagem")}
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <AgentPreview
              key={JSON.stringify(draft)}
              prepare={prepare}
              disabled={
                !!store.error ||
                !!pending ||
                !!session.input.trim() ||
                (session.uncertain && session.attempt_action === "publish")
              }
              onBusy={setPreviewBusy}
            />
          )}
        </div>
        <AgentSetupSummary
          draft={{ ...draft, name: draft.name || props.campaign.name }}
          channel={channel?.display_name ?? channel?.phone_number}
          pipeline={pipeline?.pipeline_name}
          initialStage={initialStage?.name}
          qualifiedStage={qualifiedStage?.name}
        >
          {session.prepared && (
            <p className="text-xs text-muted-foreground">
              {t("Rascunho salvo e pausado. Você pode testar e ajustar antes de publicar.")}
            </p>
          )}
          {ready && (
            <>
              {session.needs_continuity && (
                <label className="flex items-start gap-2 rounded-lg border bg-background p-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={session.enable_router_continuity}
                    disabled={busy || !!session.uncertain || !!store.error}
                    onChange={(event) =>
                      store.change({ enable_router_continuity: event.target.checked })
                    }
                  />
                  <span>
                    <span className="block font-medium">
                      {t("Manter a continuidade do agente neste canal")}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t(
                        "Dar continuidade com o mesmo agente, salvo mudança de assunto ou transferência. Esta configuração vale para as conversas deste canal.",
                      )}
                    </span>
                  </span>
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ao publicar, o agente poderá atender mensagens recebidas neste canal. A prospecção começa apenas quando você iniciar a campanha.",
                )}
              </p>
              <Button
                type="button"
                className="h-auto w-full py-2 whitespace-normal"
                disabled={
                  busy ||
                  !!session.input.trim() ||
                  !!store.error ||
                  (!recoveringPreparation &&
                    session.needs_continuity &&
                    !session.enable_router_continuity)
                }
                onClick={() => void (recoveringPreparation ? recoverPreparation() : create())}
              >
                {pending === "create"
                  ? t("Publicando agente…")
                  : pending === "prepare"
                    ? t("Recuperando rascunho…")
                    : recoveringPreparation
                      ? t("Recuperar rascunho de teste")
                      : session.uncertain
                        ? t("Recuperar criação do agente")
                        : t("Publicar e usar agente")}
              </Button>
            </>
          )}
          {session.prepared && (
            <Link
              className="block text-xs underline"
              href={`/app/ai/agents/${session.prepared.agent.id}#voice-assistant`}
            >
              {t("Configurar assistente de voz")}
            </Link>
          )}
        </AgentSetupSummary>
      </div>
      {(error || store.error || session.uncertain) && (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-3 text-sm">
          {(error || store.error) && <p>{error || store.error}</p>}
          {session.uncertain && (
            <p>
              {t(
                "A última criação ainda precisa de confirmação. Recupere a mesma solicitação para evitar outro agente.",
              )}
            </p>
          )}
          {failedTurn && !store.error && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send()}
            >
              {t("Tentar novamente")}
            </Button>
          )}
          {store.error && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void store.reload().catch(() => {})}
            >
              {t("Recarregar conversa salva")}
            </Button>
          )}
          {session.uncertain && !ready && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void store.reload().catch(() => {})}
            >
              {t("Consultar criação salva")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
