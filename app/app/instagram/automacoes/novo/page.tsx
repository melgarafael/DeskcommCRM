/**
 * /app/instagram/automacoes/novo — Criação de novo flow de automação Instagram
 *
 * Formulário completo para criar um flow de automação: trigger + lista de ações.
 * Arquitetura ManyChat: trigger dispara, ações executam em ordem, first-match wins.
 *
 * Acesso: manager+
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

// ── Labels ─────────────────────────────────────────────────────────────────────

const TRIGGER_OPTIONS: { value: TriggerTipo; label: string; descricao: string }[] = [
  { value: "comment_keyword", label: "Palavra-chave no comentário", descricao: "Dispara quando o comentário contém uma ou mais palavras-chave." },
  { value: "comment_no_post", label: "Qualquer comentário em post específico", descricao: "Dispara em qualquer comentário num post específico." },
  { value: "dm_keyword", label: "Palavra-chave em DM", descricao: "Dispara quando a DM contém uma palavra-chave." },
  { value: "novo_seguidor", label: "Novo seguidor", descricao: "Dispara quando alguém segue o perfil." },
  { value: "story_reply", label: "Resposta de Story", descricao: "Dispara quando alguém responde um Story." },
  { value: "novo_comentario", label: "Qualquer comentário (catch-all)", descricao: "Dispara em qualquer comentário — use como fallback no final da lista." },
];

const ACAO_OPTIONS: { value: AcaoTipo; label: string; descricao: string }[] = [
  { value: "enviar_dm", label: "Enviar DM", descricao: "Envia mensagem direta para quem comentou. Variáveis: {{username}}, {{comentario}}" },
  { value: "responder_comentario", label: "Responder comentário", descricao: "Responde publicamente ao comentário. Variáveis: {{username}}, {{comentario}}" },
  { value: "add_etiqueta", label: "Adicionar etiqueta", descricao: "Adiciona uma etiqueta ao contato no CRM." },
  { value: "criar_contato", label: "Criar contato", descricao: "Cria ou atualiza o contato no CRM com dados do Instagram." },
  { value: "notificar_equipe", label: "Notificar equipe", descricao: "Envia notificação para a equipe no canal de atendimento." },
  { value: "add_funil_politico", label: "Funil político", descricao: "Classifica o contato no funil: Simpatizante, Apoiador ou Embaixador." },
];

const NIVEIS_FUNIL = ["Simpatizante", "Apoiador", "Embaixador"];

// ── Componente de ação ─────────────────────────────────────────────────────────

function AcaoEditor({
  acao,
  index,
  onChange,
  onRemove,
}: {
  acao: AcaoConfig;
  index: number;
  onChange: (acao: AcaoConfig) => void;
  onRemove: () => void;
}) {
  const info = ACAO_OPTIONS.find((o) => o.value === acao.tipo);

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <select
          value={acao.tipo}
          onChange={(e) => onChange({ tipo: e.target.value as AcaoTipo })}
          className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {ACAO_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          onClick={onRemove}
          className="rounded-md px-2 py-1.5 text-xs text-destructive border border-destructive/20 hover:bg-destructive/10 transition-colors shrink-0"
        >
          Remover
        </button>
      </div>

      {info && (
        <p className="text-xs text-muted-foreground">{info.descricao}</p>
      )}

      {(acao.tipo === "enviar_dm" || acao.tipo === "responder_comentario") && (
        <textarea
          value={acao.texto ?? ""}
          onChange={(e) => onChange({ ...acao, texto: e.target.value })}
          placeholder="Texto da mensagem (use {{username}} e {{comentario}})"
          rows={3}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
        />
      )}

      {acao.tipo === "add_etiqueta" && (
        <input
          type="text"
          value={acao.etiqueta ?? ""}
          onChange={(e) => onChange({ ...acao, etiqueta: e.target.value })}
          placeholder="Nome da etiqueta (ex: Lead Quente)"
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      )}

      {acao.tipo === "notificar_equipe" && (
        <input
          type="text"
          value={acao.mensagem ?? ""}
          onChange={(e) => onChange({ ...acao, mensagem: e.target.value })}
          placeholder="Mensagem para a equipe (use {{username}} e {{comentario}})"
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      )}

      {acao.tipo === "add_funil_politico" && (
        <select
          value={acao.nivel ?? "Simpatizante"}
          onChange={(e) => onChange({ ...acao, nivel: e.target.value })}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {NIVEIS_FUNIL.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function NovoFlowPage() {
  const router = useRouter();

  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [triggerTipo, setTriggerTipo] = useState<TriggerTipo>("comment_keyword");
  const [keywords, setKeywords] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [postIds, setPostIds] = useState("");
  const [acoes, setAcoes] = useState<AcaoConfig[]>([{ tipo: "enviar_dm", texto: "" }]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const triggerInfo = TRIGGER_OPTIONS.find((o) => o.value === triggerTipo);

  function addAcao() {
    setAcoes((prev) => [...prev, { tipo: "criar_contato" }]);
  }

  function updateAcao(i: number, acao: AcaoConfig) {
    setAcoes((prev) => prev.map((a, idx) => (idx === i ? acao : a)));
  }

  function removeAcao(i: number) {
    setAcoes((prev) => prev.filter((_, idx) => idx !== i));
  }

  function buildTriggerConfig() {
    const cfg: Record<string, unknown> = {};
    if (triggerTipo === "comment_keyword" || triggerTipo === "dm_keyword") {
      cfg.keywords = keywords.split(",").map((k) => k.trim()).filter(Boolean);
      cfg.case_sensitive = caseSensitive;
    }
    if (triggerTipo === "comment_no_post") {
      cfg.post_ids = postIds.split(",").map((p) => p.trim()).filter(Boolean);
    }
    return cfg;
  }

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);

    if (!nome.trim()) { setErro("Nome é obrigatório."); return; }
    if (acoes.length === 0) { setErro("Adicione pelo menos uma ação."); return; }

    const body = {
      nome: nome.trim(),
      descricao: descricao.trim() || null,
      trigger_tipo: triggerTipo,
      trigger_config: buildTriggerConfig(),
      acoes,
      ativo: true,
    };

    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ig-automation-flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error?.message ?? "Erro ao salvar");
      }
      router.push("/app/instagram/automacoes");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao salvar");
      setSalvando(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Cabeçalho */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link href="/app/instagram" className="hover:text-foreground transition-colors">Instagram</Link>
          <span>/</span>
          <Link href="/app/instagram/automacoes" className="hover:text-foreground transition-colors">Automações</Link>
          <span>/</span>
          <span>Novo flow</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Novo flow</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Defina o gatilho e as ações. O primeiro flow que bater executa — os demais são ignorados.
        </p>
      </div>

      <form onSubmit={salvar} className="space-y-6">
        {/* Dados básicos */}
        <div className="space-y-3">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Identificação</h2>
          <div>
            <label className="block text-sm font-medium mb-1">Nome do flow *</label>
            <input
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder='Ex: "Responde palavra INFO"'
              required
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Descrição (opcional)</label>
            <input
              type="text"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Explique brevemente o que este flow faz"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Trigger */}
        <div className="space-y-3">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Gatilho</h2>
          <select
            value={triggerTipo}
            onChange={(e) => setTriggerTipo(e.target.value as TriggerTipo)}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {TRIGGER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {triggerInfo && (
            <p className="text-xs text-muted-foreground">{triggerInfo.descricao}</p>
          )}

          {(triggerTipo === "comment_keyword" || triggerTipo === "dm_keyword") && (
            <div className="space-y-2">
              <div>
                <label className="block text-sm font-medium mb-1">Palavras-chave (separadas por vírgula)</label>
                <input
                  type="text"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="INFO, quero saber, saiba mais"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={caseSensitive}
                  onChange={(e) => setCaseSensitive(e.target.checked)}
                  className="rounded"
                />
                <span className="text-sm">Case sensitive (diferencia maiúsculas)</span>
              </label>
            </div>
          )}

          {triggerTipo === "comment_no_post" && (
            <div>
              <label className="block text-sm font-medium mb-1">IDs dos posts (separados por vírgula)</label>
              <input
                type="text"
                value={postIds}
                onChange={(e) => setPostIds(e.target.value)}
                placeholder="17891234567, 17898765432 (deixe vazio para qualquer post)"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Deixe em branco para disparar em qualquer comentário em qualquer post.
              </p>
            </div>
          )}
        </div>

        {/* Ações */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Ações</h2>
            <button
              type="button"
              onClick={addAcao}
              className="text-xs font-medium text-primary hover:underline"
            >
              + Adicionar ação
            </button>
          </div>

          {acoes.length === 0 && (
            <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
              Nenhuma ação. Adicione pelo menos uma.
            </div>
          )}

          <div className="space-y-2">
            {acoes.map((acao, i) => (
              <AcaoEditor
                key={i}
                acao={acao}
                index={i}
                onChange={(a) => updateAcao(i, a)}
                onRemove={() => removeAcao(i)}
              />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            As ações executam em ordem. Todas são executadas (best-effort), mesmo que uma falhe.
          </p>
        </div>

        {/* Erro */}
        {erro && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {erro}
          </div>
        )}

        {/* Botões */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={salvando}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {salvando ? "Salvando…" : "Criar flow"}
          </button>
          <Link
            href="/app/instagram/automacoes"
            className="rounded-lg border px-5 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
