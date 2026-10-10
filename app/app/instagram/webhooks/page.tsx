/**
 * /app/instagram/webhooks — Tokens de webhook do Instagram Graph API
 *
 * Permite ao manager gerar e gerenciar tokens de URL para configurar o
 * webhook do Instagram Business no App Meta. Cada token mapeia para uma
 * organização + channel_session.
 *
 * URL de webhook resultante: https://<domínio>/api/v1/webhooks/instagram-comments/<token>
 *
 * Acesso: manager+
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

// ── Tipos ──────────────────────────────────────────────────────────────────────

interface WebhookToken {
  id: string;
  path_token: string;
  descricao: string | null;
  ativo: boolean;
  ultimo_ping_at: string | null;
  created_at: string;
}

// ── Hook de dados ──────────────────────────────────────────────────────────────

function useTokens() {
  const [tokens, setTokens] = useState<WebhookToken[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const res = await fetch("/api/v1/ig-webhook-tokens");
      if (!res.ok) throw new Error("Erro ao carregar tokens");
      const json = await res.json();
      setTokens(json.data?.tokens ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  return { tokens, carregando, erro, recarregar: carregar };
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function WebhooksInstagramPage() {
  const { tokens, carregando, erro, recarregar } = useTokens();
  const [copiado, setCopiado] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [descricaoNova, setDescricaoNova] = useState("");
  const [mostrarFormulario, setMostrarFormulario] = useState(false);

  const urlBase =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/webhooks/instagram-comments`
      : "https://seu-dominio.com/api/v1/webhooks/instagram-comments";

  async function copiar(token: string) {
    const url = `${urlBase}/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(token);
      setTimeout(() => setCopiado(null), 2000);
    } catch {
      // fallback: selecionar o texto
      const el = document.getElementById(`token-${token}`);
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  }

  async function criarToken() {
    setCriando(true);
    try {
      const res = await fetch("/api/v1/ig-webhook-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descricao: descricaoNova || null }),
      });
      if (!res.ok) throw new Error("Erro ao criar token");
      setDescricaoNova("");
      setMostrarFormulario(false);
      await recarregar();
    } finally {
      setCriando(false);
    }
  }

  async function revogar(id: string) {
    if (!confirm("Revogar este token? O webhook do Meta vai parar de funcionar.")) return;
    await fetch(`/api/v1/ig-webhook-tokens/${id}`, { method: "DELETE" });
    await recarregar();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/app/instagram" className="hover:text-foreground transition-colors">
              Instagram
            </Link>
            <span>/</span>
            <span>Tokens de Webhook</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Tokens de Webhook</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure o Instagram Business para entregar eventos aqui via Graph API.
          </p>
        </div>
        <button
          onClick={() => setMostrarFormulario(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <span>＋</span>
          Novo token
        </button>
      </div>

      {/* Formulário de criação */}
      {mostrarFormulario && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h2 className="font-medium">Gerar novo token</h2>
          <input
            type="text"
            placeholder="Descrição (ex: Conta @meupolitico)"
            value={descricaoNova}
            onChange={(e) => setDescricaoNova(e.target.value)}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-2">
            <button
              onClick={criarToken}
              disabled={criando}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {criando ? "Gerando…" : "Gerar token"}
            </button>
            <button
              onClick={() => setMostrarFormulario(false)}
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Instrução de configuração */}
      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm space-y-1">
        <p className="font-medium">Como configurar no Meta</p>
        <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
          <li>Gere um token abaixo e copie a URL completa</li>
          <li>
            No{" "}
            <a
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              Meta for Developers
            </a>
            , vá em seu App → Instagram → Webhooks
          </li>
          <li>Cole a URL como Callback URL e use qualquer string como Verify Token</li>
          <li>Assine os campos: <code className="rounded bg-muted px-1 py-0.5">comments</code> e <code className="rounded bg-muted px-1 py-0.5">mentions</code></li>
        </ol>
      </div>

      {/* Estado de carregamento */}
      {carregando && (
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {/* Erro */}
      {erro && !carregando && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {erro} —{" "}
          <button onClick={recarregar} className="underline underline-offset-4">
            tentar novamente
          </button>
        </div>
      )}

      {/* Lista vazia */}
      {!carregando && !erro && tokens.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="text-4xl">🔗</span>
          <p className="font-medium">Nenhum token gerado ainda</p>
          <p className="text-sm text-muted-foreground">
            Gere um token para começar a receber comentários do Instagram.
          </p>
        </div>
      )}

      {/* Lista de tokens */}
      {!carregando && tokens.length > 0 && (
        <div className="divide-y divide-border rounded-xl border bg-card">
          {tokens.map((token) => {
            const url = `${urlBase}/${token.path_token}`;
            return (
              <div key={token.id} className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        token.ativo ? "bg-emerald-500" : "bg-muted-foreground"
                      }`}
                    />
                    <span className="font-medium text-sm">
                      {token.descricao ?? "Sem descrição"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => copiar(token.path_token)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium border hover:bg-accent transition-colors"
                    >
                      {copiado === token.path_token ? "✓ Copiado!" : "Copiar URL"}
                    </button>
                    <button
                      onClick={() => revogar(token.id)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium text-destructive border border-destructive/20 hover:bg-destructive/10 transition-colors"
                    >
                      Revogar
                    </button>
                  </div>
                </div>

                {/* URL */}
                <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                  <code
                    id={`token-${token.path_token}`}
                    className="flex-1 min-w-0 truncate text-xs text-muted-foreground select-all"
                  >
                    {url}
                  </code>
                </div>

                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>
                    Criado em{" "}
                    {new Date(token.created_at).toLocaleDateString("pt-BR")}
                  </span>
                  {token.ultimo_ping_at && (
                    <span>
                      Último ping:{" "}
                      {new Date(token.ultimo_ping_at).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
