"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { AgentForm, initialAgentCreationState } from "../../[id]/_components/AgentForm";
import {
  creationCapabilities,
  type CreationDraft,
  type CreationMessage,
} from "@/lib/ai/agents/creation-chat";
import { prepareAgentConversation } from "../_chat-action";

type Props = Pick<
  ComponentProps<typeof AgentForm>,
  "credentials" | "channelSessions" | "provedoresDaInstalacao" | "defaultAI"
>;

export function ConversationalAgentCreator(props: Props) {
  const t = useT();
  const [mode, setMode] = useState<"conversation" | "editor">("conversation");
  const [form, setForm] = useState(() => initialAgentCreationState(props.defaultAI));
  const [draft, setDraft] = useState<CreationDraft>({});
  const [messages, setMessages] = useState<CreationMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const sending = useRef(false);
  const mounted = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const editorEntry = useRef(form);
  const ideaInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setPendingText(text);
    try {
      const next = [...messages, { role: "user" as const, content: text }];
      const response = await prepareAgentConversation({ messages: next, draft });
      if (!mounted.current) return;
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setMessages([...next, { role: "assistant", content: response.message }]);
      setDraft(response.draft);
      setSelected([]);
      setInput("");
    } catch {
      if (mounted.current)
        setError(t("A resposta não chegou. Sua mensagem foi mantida; tente novamente."));
    } finally {
      sending.current = false;
      if (mounted.current) {
        setBusy(false);
        setPendingText("");
      }
    }
  }

  function reviewProposal() {
    setForm((current) => ({
      ...current,
      name: draft.name ?? current.name,
      description: draft.description ?? current.description,
      system_prompt: draft.system_prompt ?? current.system_prompt,
      tool_ids: [...new Set([...current.tool_ids, ...selected])],
    }));
    editorEntry.current = {
      ...form,
      name: draft.name ?? form.name,
      description: draft.description ?? form.description,
      system_prompt: draft.system_prompt ?? form.system_prompt,
    };
    setMode("editor");
    requestAnimationFrame(() => editor.current?.querySelector<HTMLInputElement>("#name")?.focus());
  }

  const ready = !!draft.name && !!draft.system_prompt;
  const suggestions = creationCapabilities.filter((tool) =>
    draft.suggested_tool_ids?.includes(tool.name),
  );

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/app/ai/agents"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          {t("Agentes de IA")}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (mode === "editor") {
              setDraft((previous) => {
                const next = { ...previous };
                for (const key of ["name", "description", "system_prompt"] as const) {
                  if (form[key] !== editorEntry.current[key]) {
                    if (form[key].trim()) next[key] = form[key];
                    else delete next[key];
                  }
                }
                return next;
              });
              setSelected([]);
              setMode("conversation");
            } else {
              editorEntry.current = form;
              setMode("editor");
            }
          }}
        >
          {mode === "conversation" ? t("Configurar manualmente") : t("Voltar à conversa")}
        </Button>
      </div>

      <div hidden={mode !== "conversation"}>
        <div className="agent-studio grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.85fr)] xl:gap-12">
          <section aria-label={t("Criar agente por conversa")} className="min-w-0 space-y-5">
            <header className="space-y-2">
              <h1 className="artisan-title max-w-2xl">
                {t("Seu próximo agente começa com uma ideia.")}
              </h1>
              <p className="pt-3 text-base leading-7 text-muted-foreground">
                {t("Conte o que precisa. A gente organiza com você.")}
              </p>
            </header>
            <div className="space-y-2 text-sm text-muted-foreground">
              {props.defaultAI === null ? (
                <p role="status">
                  {t(
                    "A IA ainda precisa ser preparada pelo administrador. Você pode configurar o agente manualmente enquanto isso.",
                  )}
                </p>
              ) : null}
            </div>
            {!messages.length && !busy ? (
              <section className="space-y-4 py-3" aria-label={t("Ideias para começar")}>
                <h2 className="font-serif text-xl">{t("O que você quer facilitar hoje?")}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      icon: "conversation" as const,
                      label: t("Responder clientes"),
                      text: t(
                        "Quero responder dúvidas sobre meus serviços e chamar minha equipe quando precisar.",
                      ),
                    },
                    {
                      icon: "pipeline" as const,
                      label: t("Organizar vendas"),
                      text: t(
                        "Quero entender o interesse dos clientes e organizar as oportunidades no funil.",
                      ),
                    },
                    {
                      icon: "calendar" as const,
                      label: t("Agendar horários"),
                      text: t(
                        "Quero ajudar meus clientes a escolher um horário para serem atendidos.",
                      ),
                    },
                  ].map((idea, index) => (
                    <button
                      key={idea.icon}
                      type="button"
                      className="agent-idea-choice flex items-center gap-3 rounded-2xl border p-4 text-left text-sm sm:flex-col sm:items-start sm:gap-4 sm:p-5"
                      onClick={() => {
                        setInput(idea.text);
                        ideaInput.current?.focus();
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="agent-task-illustration"
                        style={{ backgroundPosition: `${index * 50}% center` }}
                      />
                      {idea.label}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div
              ref={transcript}
              role="log"
              aria-label={t("Conversa de criação")}
              aria-live="polite"
              aria-relevant="additions"
              hidden={!messages.length && !busy}
              className="max-h-[55vh] space-y-4 overflow-y-auto rounded-2xl bg-card p-4 sm:p-5"
            >
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={message.role === "user" ? "ml-4 rounded-lg bg-muted p-3" : "mr-4 py-2"}
                >
                  <p className="mb-1 text-xs font-bold text-muted-foreground">
                    {message.role === "user" ? t("Você") : "escreve.ai"}
                  </p>
                  <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {message.content}
                  </p>
                </div>
              ))}
              {busy ? (
                <>
                  <p className="ml-4 rounded-lg bg-muted p-3 text-sm break-words whitespace-pre-wrap">
                    {pendingText}
                  </p>
                  <p role="status" className="text-sm text-muted-foreground">
                    {t("Preparando sua proposta…")}
                  </p>
                </>
              ) : null}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              className="space-y-3"
            >
              <label htmlFor="agent-idea" className="block text-sm font-medium">
                {messages.length ? t("O que você quer ajustar?") : t("Escreve aí.")}
              </label>
              <Textarea
                id="agent-idea"
                ref={ideaInput}
                aria-label={messages.length ? t("O que você quer ajustar?") : t("Conte sua ideia")}
                className="min-h-32 rounded-2xl bg-card p-5 text-base leading-7"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={busy}
                rows={4}
                maxLength={3000}
                placeholder={t(
                  "Ex.: quero responder dúvidas sobre meus serviços e chamar minha equipe quando precisar.",
                )}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
                >
                  {error}{" "}
                  <Link href="/app/ai/providers" className="underline">
                    {t("Ver configuração da IA")}
                  </Link>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Button
                  type="submit"
                  className="h-12 min-w-36 rounded-xl px-7"
                  disabled={!input.trim() || busy}
                >
                  {busy
                    ? t("Preparando…")
                    : error
                      ? t("Tentar novamente")
                      : messages.length
                        ? t("Enviar")
                        : t("Começar")}
                  <span aria-hidden>→</span>
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("Você revisa tudo antes de ativar.")}
                </span>
              </div>
            </form>
            <p className="text-xs text-muted-foreground">
              {t(
                "Esta conversa prepara uma proposta. O agente só é salvo no editor e só atende depois de você publicar.",
              )}
            </p>
          </section>

          {draft.name || draft.system_prompt ? (
            <aside
              aria-label={t("Proposta do agente")}
              className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5"
            >
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t("Proposta ainda não salva")}
                </p>
                <h2 className="mt-1 text-lg font-bold break-words">
                  {draft.name ?? t("Seu agente")}
                </h2>
              </div>
              {draft.description ? (
                <p className="text-sm break-words text-muted-foreground">{draft.description}</p>
              ) : null}
              {draft.system_prompt ? (
                <div>
                  <h3 className="mb-2 text-sm font-bold">{t("Instruções")}</h3>
                  <p className="max-h-64 overflow-y-auto text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {draft.system_prompt}
                  </p>
                </div>
              ) : null}
              {suggestions.length ? (
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-sm font-bold">{t("Capacidades sugeridas")}</legend>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Marque apenas o que autoriza levar ao rascunho. Nenhuma sugestão é ligada sozinha.",
                    )}
                  </p>
                  {suggestions.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-start gap-2 rounded-lg border p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={selected.includes(tool.name)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, tool.name]
                              : current.filter((id) => id !== tool.name),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{tool.rotulo}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {tool.explicacao}
                        </span>
                        {tool.risco === "critico" ? (
                          <span className="mt-1 block text-xs text-destructive">
                            {t("Efeito que não dá para desfazer")}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ao revisar, o texto da proposta atualiza nome, descrição e instruções. Suas escolhas de modelo, número, limites e capacidades já configuradas são preservadas.",
                )}
              </p>
              <Button className="w-full" disabled={!ready || busy} onClick={reviewProposal}>
                {t("Revisar rascunho")}
              </Button>
            </aside>
          ) : (
            <aside
              className="agent-preview rounded-3xl border p-6 sm:p-8"
              aria-label={t("Prévia do agente")}
            >
              <p className="mb-3 text-xs font-medium text-muted-foreground">{t("Prévia")}</p>
              <h2 className="font-serif text-2xl tracking-tight">
                {t("Seu agente, tomando forma")}
              </h2>
              <Image
                src="/brand/agent-studio-art.png"
                width={1536}
                height={1024}
                alt=""
                className="artisan-illustration my-4 w-full rounded-2xl"
              />
              <ul className="divide-y">
                {[
                  { label: t("O que ele faz"), icon: "pipeline" as const },
                  { label: t("Como ele conversa"), icon: "conversation" as const },
                  { label: t("Quando chama você"), icon: "people" as const },
                ].map(
                  ({ label, icon }) => (
                    <li key={label} className="flex items-center gap-3 py-5 text-sm">
                      <ArtisanIcon symbol={icon} className="h-5 w-5 shrink-0 text-primary" />
                      {label}
                    </li>
                  ),
                )}
              </ul>
              <p className="mt-6 font-serif text-base text-muted-foreground italic">
                {t("Primeiro a ideia. Depois os detalhes.")}
              </p>
            </aside>
          )}
        </div>
      </div>
      <div ref={editor} hidden={mode !== "editor"}>
        <AgentForm {...props} mode="create" creationState={form} onCreationStateChange={setForm} />
      </div>
    </div>
  );
}
