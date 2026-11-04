"use client";
import { useEffect, useRef, useState } from "react";
import type { PilotSession } from "@/lib/assistant-pilot/types";
import { HEADER_ORG_DA_ABA } from "@/lib/auth/org-da-aba";

export function AssistentePiloto({
  enabled,
  tenantId,
  userId,
}: {
  enabled: boolean;
  tenantId: string;
  userId: string;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [session, setSession] = useState<PilotSession | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function load() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      const r = await fetch("/api/v1/assistant-pilot", {
        signal: c.signal,
        headers: { [HEADER_ORG_DA_ABA]: tenantId },
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Histórico indisponível. Recarregue o CRM para conferir a conta.");
      const s = (await r.json()).data as PilotSession;
      if (s.identity.userId !== userId || s.identity.tenantId !== tenantId)
        throw new Error("Identidade divergente.");
      if (c.signal.aborted) return;
      setSession(s);
      const receipt = s.receipts.find((x) => x.turnId === pending);
      if (receipt?.status === "completed") {
        setPending(null);
        setText("");
        setError(null);
      } else if (receipt?.status === "failed" && receipt.error?.startsWith("Falha no motor")) {
        setPending(null);
        setError(receipt.error);
      }
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof Error ? e.message : "Falha ao ler histórico.");
    }
  }
  useEffect(() => {
    if (enabled && open && !busy) void load();
  }, [enabled, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled) return null;
  const uncertain = session?.receipts.some((r) => r.error?.startsWith("Turno em andamento"));
  async function send() {
    if (!text.trim() || busy || pending || uncertain) return;
    // Invalidate any older history snapshot before reserving a new turn.
    // An aborted GET may still resolve (e.g. cached/mocked responses); load checks its signal.
    controller.current?.abort();
    const id = crypto.randomUUID();
    setPending(id);
    setBusy(true);
    setError(null);
    const c = new AbortController();
    controller.current = c;
    try {
      const r = await fetch("/api/v1/assistant-pilot", {
        method: "POST",
        signal: c.signal,
        headers: { "content-type": "application/json", [HEADER_ORG_DA_ABA]: tenantId },
        body: JSON.stringify({ channel: "crm", text: text.trim(), turn_id: id }),
      });
      const p = await r.json();
      if (!r.ok || !p.data) throw new Error(p.error?.message ?? "Turno não confirmado.");
      const s = p.data as PilotSession;
      if (s.identity.userId !== userId || s.identity.tenantId !== tenantId)
        throw new Error("Identidade divergente.");
      if (c.signal.aborted) return;
      setSession(s);
      setPending(null);
      setText("");
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof Error ? e.message : "Falha no turno.");
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <aside
      className="fixed right-5 bottom-5 z-50 flex flex-col items-end gap-2"
      data-testid="assistant-pilot-widget"
      data-release="internal-pilot-20261014-r3"
    >
      {open ? (
        <section className="flex h-[30rem] max-h-[80vh] w-[22rem] max-w-[90vw] flex-col rounded-xl border border-border bg-background p-4 shadow-xl">
          <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <div>
              <h2 className="text-sm font-semibold">Assistente pessoal</h2>
              <p className="text-xs text-muted-foreground">
                Motor interno · consultas · janela de histórico 90 dias
              </p>
              <a href="/app/ai/providers" className="text-xs underline">
                Configuração de IA
              </a>
            </div>
            <button type="button" aria-label="Recolher assistente" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          <div
            role="log"
            aria-live="polite"
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-3"
          >
            {!session?.messages.length ? (
              <p className="text-xs text-muted-foreground">
                Conversa pessoal restrita. Não envia mensagens nem altera registros.
              </p>
            ) : null}
            {session?.messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "self-end rounded-lg bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap"
                    : "rounded-lg border border-border px-3 py-2 text-sm whitespace-pre-wrap"
                }
              >
                {m.text}
              </div>
            ))}
          </div>
          {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
          {pending || uncertain ? (
            <p className="text-xs">
              Resultado pendente ou incerto. Atualize o histórico; não reenviamos automaticamente.
              Se continuar incerto, requer recuperação técnica sem repetir o turno.
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void load()}
            className="mb-2 text-xs underline"
          >
            Atualizar histórico
          </button>
          <div className="flex gap-2">
            <input
              aria-label="Mensagem ao assistente"
              disabled={busy || !!pending || uncertain}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder="Converse com o assistente…"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={busy || !!pending || uncertain || !text.trim()}
              onClick={() => void send()}
              className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground disabled:opacity-50"
            >
              {busy ? "…" : "Enviar"}
            </button>
          </div>
        </section>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded-full bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-lg"
      >
        {open ? "Fechar" : "Assistente"}
      </button>
    </aside>
  );
}
