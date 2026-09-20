"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  ArrowUpRight,
  MessageCircle,
  BookOpen,
  PanelsTopLeft,
  Plus,
  LoaderCircle,
} from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { searchable } from "@/lib/navigation/registry";
import { Button } from "@/components/ui/button";
import { askWorkspace } from "../_workspace-action";
import type { WorkspaceReply, WorkspaceScope } from "@/lib/workspace/schema";

type Turn = { question: string; reply: Extract<WorkspaceReply, { ok: true }> };
export function WorkspaceHome() {
  const { user, activeOrg } = useAuth();
  return <WorkspaceSession key={`${user.id}:${activeOrg?.orgId}:${activeOrg?.role}`} />;
}

function WorkspaceSession() {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<WorkspaceScope>("all");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const destinations = searchable(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  );
  const canKnowledge = destinations.some((d) => d.href === "/app/ai/knowledge/sources");
  const suggestions = [
    { icon: MessageCircle, text: "Resuma as conversas recentes", scope: "conversations" as const },
    {
      icon: PanelsTopLeft,
      text: "Quais oportunidades precisam de atenção?",
      scope: "leads" as const,
    },
    ...(canKnowledge
      ? [
          {
            icon: BookOpen,
            text: "Encontre uma informação nos meus conteúdos",
            scope: "knowledge" as const,
          },
        ]
      : []),
  ];
  async function send() {
    if (!question.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const text = question.trim();
    try {
      const reply = await askWorkspace({
        question: text,
        scope,
        history: turns.slice(-4).flatMap((turn) => [
          { role: "user", content: turn.question },
          { role: "assistant", content: turn.reply.answer },
        ]),
      });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setTurns((previous) => [...previous, { question: text, reply }]);
      setQuestion("");
      requestAnimationFrame(() => input.current?.focus());
    } catch {
      setError(t("A conexão falhou. Sua pergunta foi mantida; tente novamente."));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-130px)] w-full max-w-4xl flex-col px-1 pt-6 pb-24 sm:px-6 sm:pt-12">
      <div className="mb-9 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{activeOrg?.name ?? t("Seu espaço")}</span>
        <span>{t("WhatsApp · Instagram · Conteúdos")}</span>
      </div>
      <header className="mb-9 max-w-2xl">
        <p className="mb-4 text-sm text-muted-foreground">{t("Tudo conectado. Do seu jeito.")}</p>
        <h1 className="text-4xl font-medium tracking-[-0.055em] sm:text-5xl">
          {t("Seu próximo passo?")}
          <br />
          <span className="text-primary">{t("Escreve aí.")}</span>
        </h1>
        <p className="mt-5 max-w-lg text-sm leading-6 text-muted-foreground">
          {t(
            "Converse com o conteúdo do seu CRM. Encontre informações, entenda suas conversas e acompanhe o funil.",
          )}
        </p>
      </header>
      {!!turns.length && (
        <section
          aria-label={t("Conversa com seu CRM")}
          aria-live="polite"
          className="mb-6 space-y-8"
        >
          {turns.map((turn, index) => (
            <article key={index} className="space-y-4">
              <p className="ml-auto max-w-[90%] rounded-2xl bg-muted px-5 py-3 text-sm break-words">
                {turn.question}
              </p>
              <div className="px-1">
                <p className="mb-2 text-xs font-semibold text-primary">escreve.ai</p>
                <p className="text-sm leading-7 break-words whitespace-pre-wrap">
                  {turn.reply.answer}
                </p>
                {!!turn.reply.sources.length && (
                  <ul aria-label={t("Fontes consultadas")} className="mt-4 flex flex-wrap gap-2">
                    {turn.reply.sources.map((source) => (
                      <li key={source.id}>
                        <Link
                          href={source.href}
                          className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs"
                        >
                          <span className="text-muted-foreground">{t(source.kind)}</span>
                          <span className="max-w-48 truncate">{source.title}</span>
                          <ArrowUpRight size={13} aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <details className="mt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t("Sobre esta consulta")}</summary>
                  <p className="mt-2 leading-5">{turn.reply.notice}</p>
                </details>
              </div>
            </article>
          ))}
        </section>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="rounded-3xl border bg-card p-4 shadow-[0_8px_40px_-20px_rgba(0,0,0,0.14)] sm:p-5"
      >
        <label htmlFor="workspace-question" className="sr-only">
          {t("O que você quer saber sobre seu CRM?")}
        </label>
        <textarea
          ref={input}
          id="workspace-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          maxLength={2000}
          rows={3}
          placeholder={t("Pergunte sobre uma conversa, uma oportunidade ou um conteúdo…")}
          className="w-full resize-none rounded-lg bg-transparent text-base leading-7 outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Consultar")}</span>
            <select
              aria-label={t("Onde consultar")}
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value as WorkspaceScope)}
              className="max-w-36 rounded-lg border-0 bg-muted px-2 py-2 text-xs text-foreground"
            >
              <option value="all">{t("Meu espaço")}</option>
              <option value="conversations">{t("Conversas")}</option>
              <option value="leads">{t("Funil")}</option>
              {canKnowledge && <option value="knowledge">{t("Conteúdos")}</option>}
            </select>
          </label>
          <Button
            type="submit"
            size="icon"
            aria-label={t(busy ? "Consultando" : "Enviar pergunta")}
            disabled={busy || !question.trim()}
            className="h-10 w-10 rounded-full"
          >
            {busy ? (
              <LoaderCircle size={19} className="animate-spin" aria-hidden />
            ) : (
              <ArrowUp size={20} aria-hidden />
            )}
          </Button>
        </div>
      </form>
      {busy && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t("Consultando o conteúdo do seu espaço…")}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
          <Button variant="ghost" className="ml-2" onClick={() => void send()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      )}
      {!turns.length && (
        <div className="mt-5 flex flex-wrap gap-2">
          {suggestions.map(({ icon: Icon, text, scope: nextScope }) => (
            <button
              key={t(text)}
              type="button"
              disabled={busy}
              onClick={() => {
                setQuestion(text);
                setScope(nextScope);
                input.current?.focus();
              }}
              className="flex items-center gap-2 rounded-full border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            >
              <Icon size={15} strokeWidth={1.7} aria-hidden />
              {t(text)}
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-5 text-muted-foreground">
          {t("Consulta seus dados com suas permissões. Nenhuma mensagem é enviada aos clientes.")}
        </p>
        {!!turns.length && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setTurns([]);
              setQuestion("");
              setError(null);
              input.current?.focus();
            }}
          >
            <Plus size={15} aria-hidden />
            {t("Nova conversa")}
          </Button>
        )}
      </div>
      <div className="mt-auto pt-12">
        <p className="mb-3 text-xs text-muted-foreground">{t("Continue no seu espaço")}</p>
        <div className="flex flex-wrap gap-5">
          {destinations
            .filter((d) =>
              ["/app/inbox", "/app/kanban", "/app/ai/agents", "/app/connections"].includes(d.href),
            )
            .map((d) => (
              <Link
                key={d.href}
                href={d.href}
                className="flex items-center gap-1 text-sm font-medium hover:text-primary"
              >
                {t(d.href === "/app/ai/agents" ? "Agentes de IA" : d.label)}
                <ArrowUpRight size={14} aria-hidden />
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}
