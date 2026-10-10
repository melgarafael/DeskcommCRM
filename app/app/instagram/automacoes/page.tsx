/**
 * /app/instagram/automacoes — Lista e gestão dos flows de automação Instagram
 *
 * Lista todos os flows de automação (triggers + ações) da organização.
 * Permite criar, ativar/desativar e editar flows via modal.
 *
 * Acesso: manager+
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

// ── Tipos ──────────────────────────────────────────────────────────────────────

type TriggerTipo =
  | "comment_keyword"
  | "comment_no_post"
  | "dm_keyword"
  | "novo_seguidor"
  | "story_reply"
  | "novo_comentario";

type AcaoTipo =
  | "enviar_dm"
  | "responder_comentario"
  | "add_etiqueta"
  | "criar_contato"
  | "notificar_equipe"
  | "add_funil_politico";

interface AcaoConfig {
  tipo: AcaoTipo;
  texto?: string;
  etiqueta?: string;
  nivel?: string;
  mensagem?: string;
}

interface FlowRow {
  id: string;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  trigger_tipo: TriggerTipo;
  trigger_config: Record<string, unknown>;
  acoes: AcaoConfig[];
  ultima_ativacao_at: string | null;
  created_at: string;
}

// ── Labels de display ──────────────────────────────────────────────────────────

const TRIGGER_LABEL: Record<TriggerTipo, string> = {
  comment_keyword: "Palavra-chave no comentário",
  comment_no_post: "Qualquer comentário no post",
  dm_keyword: "Palavra-chave em DM",
  novo_seguidor: "Novo seguidor",
  story_reply: "Resposta de Story",
  novo_comentario: "Qualquer comentário (catch-all)",
};

const ACAO_LABEL: Record<AcaoTipo, string> = {
  enviar_dm: "Enviar DM",
  responder_comentario: "Responder comentário",
  add_etiqueta: "Adicionar etiqueta",
  criar_contato: "Criar contato",
  notificar_equipe: "Notificar equipe",
  add_funil_politico: "Funil político",
};

const TRIGGER_ICON: Record<TriggerTipo, string> = {
  comment_keyword: "🔍",
  comment_no_post: "📝",
  dm_keyword: "💌",
  novo_seguidor: "👤",
  story_reply: "📸",
  novo_comentario: "⚡",
};

// ── Hook de dados ──────────────────────────────────────────────────────────────

function useFlows() {
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const res = await fetch("/api/v1/ig-automation-flows?limit=100");
      if (!res.ok) throw new Error("Erro ao carregar flows");
      const json = await res.json();
      setFlows(json.data?.flows ?? []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  return { flows, carregando, erro, recarregar: carregar };
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function AutomacoesInstagramPage() {
  const { flows, carregando, erro, recarregar } = useFlows();
  const [alterandoId, setAlterandoId] = useState<string | null>(null);

  async function toggleAtivo(flow: FlowRow) {
    setAlterandoId(flow.id);
    try {
      await fetch(`/api/v1/ig-automation-flows/${flow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: !flow.ativo }),
      });
      await recarregar();
    } finally {
      setAlterandoId(null);
    }
  }

  async function excluir(flow: FlowRow) {
    if (!confirm(`Desativar flow "${flow.nome}"?`)) return;
    setAlterandoId(flow.id);
    try {
      await fetch(`/api/v1/ig-automation-flows/${flow.id}`, {
        method: "DELETE",
      });
      await recarregar();
    } finally {
      setAlterandoId(null);
    }
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
            <span>Automações</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Automações</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Flows de trigger + ação para comentários e DMs — primeiro que bater executa.
          </p>
        </div>
        <Link
          href="/app/instagram/automacoes/novo"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <span>＋</span>
          Novo flow
        </Link>
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
      {!carregando && !erro && flows.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="text-4xl">⚡</span>
          <p className="font-medium">Nenhuma automação criada ainda</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Crie um flow para responder comentários automaticamente ou enviar DMs quando alguém
            usar uma palavra-chave.
          </p>
          <Link
            href="/app/instagram/automacoes/novo"
            className="mt-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Criar primeiro flow
          </Link>
        </div>
      )}

      {/* Lista de flows */}
      {!carregando && flows.length > 0 && (
        <div className="divide-y divide-border rounded-xl border bg-card">
          {flows.map((flow) => (
            <div key={flow.id} className="flex items-start gap-4 p-4">
              {/* Ícone do trigger */}
              <span className="mt-0.5 text-xl shrink-0">
                {TRIGGER_ICON[flow.trigger_tipo] ?? "⚡"}
              </span>

              {/* Info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{flow.nome}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      flow.ativo
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {flow.ativo ? "Ativo" : "Inativo"}
                  </span>
                </div>

                <p className="mt-0.5 text-xs text-muted-foreground">
                  {TRIGGER_LABEL[flow.trigger_tipo]}
                  {(flow.trigger_config as { keywords?: string[] }).keywords?.length
                    ? ` — "${(flow.trigger_config as { keywords: string[] }).keywords.slice(0, 2).join('", "')}"`
                    : ""}
                </p>

                {/* Ações */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {flow.acoes.map((acao, i) => (
                    <span
                      key={i}
                      className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                    >
                      {ACAO_LABEL[acao.tipo] ?? acao.tipo}
                    </span>
                  ))}
                </div>

                {flow.ultima_ativacao_at && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Última ativação:{" "}
                    {new Date(flow.ultima_ativacao_at).toLocaleString("pt-BR", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </p>
                )}
              </div>

              {/* Ações */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleAtivo(flow)}
                  disabled={alterandoId === flow.id}
                  className="rounded-md px-3 py-1.5 text-xs font-medium border hover:bg-accent transition-colors disabled:opacity-50"
                  title={flow.ativo ? "Desativar" : "Ativar"}
                >
                  {alterandoId === flow.id ? "…" : flow.ativo ? "Desativar" : "Ativar"}
                </button>
                <Link
                  href={`/app/instagram/automacoes/${flow.id}`}
                  className="rounded-md px-3 py-1.5 text-xs font-medium border hover:bg-accent transition-colors"
                >
                  Editar
                </Link>
                <button
                  onClick={() => excluir(flow)}
                  disabled={alterandoId === flow.id}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-destructive border border-destructive/20 hover:bg-destructive/10 transition-colors disabled:opacity-50"
                  title="Excluir"
                >
                  Excluir
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Info de semântica first-match */}
      {flows.length > 1 && (
        <p className="text-xs text-muted-foreground text-center">
          Os flows são avaliados em ordem de criação. O <strong>primeiro que bater</strong> executa
          — os demais são ignorados para o mesmo comentário.
        </p>
      )}
    </div>
  );
}
