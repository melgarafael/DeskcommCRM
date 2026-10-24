"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { iniciarCronometro, moverTarefa, pegarTarefa } from "@/app/actions/agencia/tarefas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TarefaDoQuadro } from "@/lib/agencia/tarefas/consultas";
import { estaAtrasada, formatarDataHora, formatarDuracao } from "@/lib/agencia/tarefas/regras";
import { COLUNAS, ROTULO_DA_COLUNA, ROTULO_DA_PRIORIDADE, type Coluna } from "@/lib/agencia/tarefas/vocabulario";
import { cn } from "@/lib/utils";

import { ModalDaTarefa, type ApoioDoQuadro } from "./ModalDaTarefa";

/**
 * O quadro de tarefas da agência (docs/agencia/SPEC-tarefas.md › Telas).
 * Três visões — Quadro, Lista (padrão no celular) e Ranking — sobre o MESMO
 * conjunto, que já chega filtrado pelo servidor (T11).
 */
type Visao = "quadro" | "lista" | "ranking";

const COR_DA_COLUNA: Record<Coluna, string> = {
  backlog: "border-t-slate-400",
  a_fazer: "border-t-blue-500",
  em_andamento: "border-t-orange-500",
  revisao: "border-t-rose-500",
  concluido: "border-t-emerald-500",
};

function iniciais(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function prazoCurto(iso: string): string {
  return formatarDataHora(iso);
}

export function QuadroDeTarefas({
  tarefas,
  apoio,
  meuMembroId,
  podeCriar,
  podeAtribuir,
  clienteFixo = null,
}: {
  tarefas: TarefaDoQuadro[];
  apoio: ApoioDoQuadro;
  meuMembroId: string | null;
  podeCriar: boolean;
  podeAtribuir: boolean;
  /** Na ficha do cliente: filtra e já cria para ele. */
  clienteFixo?: string | null;
}) {
  const router = useRouter();
  const busca = useSearchParams();
  const [visao, setVisao] = useState<Visao>("quadro");
  const [modal, setModal] = useState<{ id: string | null; coluna?: Coluna } | null>(null);
  const [filtro, setFiltro] = useState({ texto: "", cliente: clienteFixo ?? "", responsavel: "", etiqueta: "", minhas: false, atrasadas: false });
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [agora] = useState(() => new Date());

  // Celular: começa na Lista.
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setVisao("lista");
  }, []);

  // `?abrir=<id>` (link do aviso) abre o modal da tarefa.
  useEffect(() => {
    const abrir = busca.get("abrir");
    if (abrir) setModal({ id: abrir });
  }, [busca]);

  const porMembro = useMemo(() => new Map(apoio.membros.map((m) => [m.id, m.nome])), [apoio.membros]);
  const porEtiqueta = useMemo(() => new Map(apoio.etiquetas.map((e) => [e.id, e])), [apoio.etiquetas]);
  const porFuncao = useMemo(() => new Map(apoio.funcoes.map((f) => [f.id, f])), [apoio.funcoes]);

  const visiveis = tarefas.filter((t) => {
    if (filtro.texto && !t.titulo.toLowerCase().includes(filtro.texto.toLowerCase())) return false;
    if (filtro.cliente && t.clienteId !== filtro.cliente) return false;
    if (filtro.responsavel && !t.responsaveis.includes(filtro.responsavel)) return false;
    if (filtro.etiqueta && !t.etiquetas.includes(filtro.etiqueta)) return false;
    if (filtro.minhas && !(meuMembroId && t.responsaveis.includes(meuMembroId)) && !t.podePegar) return false;
    if (filtro.atrasadas && !estaAtrasada(t, agora)) return false;
    return true;
  });

  function mover(id: string, coluna: Coluna, antesDeId: string | null) {
    const daColuna = visiveis.filter((t) => t.coluna === coluna && t.id !== id).sort((a, b) => a.posicao - b.posicao);
    const idx = antesDeId ? daColuna.findIndex((t) => t.id === antesDeId) : daColuna.length;
    const anterior = idx > 0 ? daColuna[idx - 1]!.id : null;
    const seguinte = idx >= 0 && idx < daColuna.length ? daColuna[idx]!.id : null;
    const t = tarefas.find((x) => x.id === id);
    const perguntar =
      coluna === "em_andamento" && t?.coluna !== "em_andamento" && meuMembroId && t?.responsaveis.includes(meuMembroId) && t.rodandoPor.length === 0;
    startTransition(async () => {
      const r = await moverTarefa(id, coluna, { anterior, seguinte });
      if (!r.ok) setErro(r.erro);
      router.refresh();
      // T4: mover para "Em andamento" pergunta se quer iniciar o cronômetro.
      if (r.ok && perguntar && window.confirm("Iniciar o cronômetro desta tarefa agora?")) {
        const c = await iniciarCronometro(id);
        if (!c.ok) setErro(c.erro);
        router.refresh();
      }
    });
  }

  // Função de render (não componente): o React Compiler recusa componente criado durante o render.
  function cartao(t: TarefaDoQuadro) {
    const atrasada = estaAtrasada(t, agora);
    const concluida = t.coluna === "concluido";
    const funcao = t.funcaoId ? porFuncao.get(t.funcaoId) : undefined;
    return (
      <article
        key={t.id}
        draggable
        onDragStart={() => setArrastando(t.id)}
        onDragEnd={() => setArrastando(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (arrastando && arrastando !== t.id) mover(arrastando, t.coluna, t.id);
        }}
        data-testid="cartao-da-tarefa"
        className={cn(
          "cursor-pointer space-y-2 rounded-md border bg-card p-3 text-left shadow-sm transition hover:border-foreground/30",
          atrasada && "border-destructive",
          concluida && "border-emerald-500/60",
          arrastando === t.id && "opacity-50",
        )}
        onClick={() => setModal({ id: t.id })}
      >
        <p className={cn("text-sm font-medium", concluida && "text-muted-foreground line-through")}>{t.titulo}</p>
        {t.clienteNome && <p className="text-xs text-muted-foreground">{t.clienteNome}</p>}
        <div className="flex flex-wrap gap-1">
          {t.etiquetas.map((id) => {
            const e = porEtiqueta.get(id);
            return e ? (
              <span key={id} className="rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: e.cor }}>
                {e.nome}
              </span>
            ) : null;
          })}
          {t.prioridade === "alta" || t.prioridade === "urgente" ? (
            <span className="rounded-sm border border-destructive px-1.5 py-0.5 text-[11px] text-destructive">
              {ROTULO_DA_PRIORIDADE[t.prioridade]}
            </span>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex -space-x-1">
            {t.responsaveis.map((id) => (
              <span
                key={id}
                title={porMembro.get(id)}
                className="flex h-6 w-6 items-center justify-center rounded-full border bg-muted text-[10px] font-semibold text-foreground"
              >
                {iniciais(porMembro.get(id) ?? "?")}
              </span>
            ))}
            {t.responsaveis.length === 0 && funcao && <span>Função: {funcao.nome}</span>}
          </div>
          <div className="flex items-center gap-2">
            {t.checklistTotal > 0 && (
              <span>
                {t.checklistFeitos}/{t.checklistTotal}
              </span>
            )}
            {t.prazo && <span className={cn(atrasada && "font-semibold text-destructive")}>{prazoCurto(t.prazo)}</span>}
            <span className={cn("font-mono", t.rodandoPor.length > 0 && "text-emerald-600")}>{formatarDuracao(t.tempoSegundos)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {t.podePegar && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                startTransition(async () => {
                  const r = await pegarTarefa(t.id);
                  if (!r.ok) setErro(r.erro);
                  router.refresh();
                })
              }
            >
              Pegar
            </Button>
          )}
          <select
            aria-label="Mover para"
            value={t.coluna}
            onChange={(e) => mover(t.id, e.target.value as Coluna, null)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {COLUNAS.map((c) => (
              <option key={c} value={c}>
                {ROTULO_DA_COLUNA[c]}
              </option>
            ))}
          </select>
        </div>
      </article>
    );
  }

  const ranking = (() => {
    const abertos = new Map<string, { nome: string; tarefas: TarefaDoQuadro[] }>();
    for (const t of visiveis) {
      if (t.coluna === "concluido") continue;
      const chave = t.clienteId ?? "interna";
      const grupo = abertos.get(chave) ?? { nome: t.clienteNome ?? "Tarefas internas", tarefas: [] };
      grupo.tarefas.push(t);
      abertos.set(chave, grupo);
    }
    return [...abertos.values()].sort((a, b) => b.tarefas.length - a.tarefas.length);
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Visão">
          {(["quadro", "lista", "ranking"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={visao === v}
              onClick={() => setVisao(v)}
              className={cn("min-h-9 rounded-sm px-3 text-sm", visao === v ? "bg-foreground text-background" : "text-muted-foreground")}
            >
              {v === "quadro" ? "Quadro" : v === "lista" ? "Lista" : "Ranking"}
            </button>
          ))}
        </div>
        <Input
          className="h-9 w-full sm:w-56"
          placeholder="Buscar tarefas"
          value={filtro.texto}
          onChange={(e) => setFiltro({ ...filtro, texto: e.target.value })}
        />
        {!clienteFixo && (
          <select
            aria-label="Cliente"
            value={filtro.cliente}
            onChange={(e) => setFiltro({ ...filtro, cliente: e.target.value })}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Todos os clientes</option>
            {apoio.clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Responsável"
          value={filtro.responsavel}
          onChange={(e) => setFiltro({ ...filtro, responsavel: e.target.value })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos os responsáveis</option>
          {apoio.membros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nome}
            </option>
          ))}
        </select>
        <select
          aria-label="Etiqueta"
          value={filtro.etiqueta}
          onChange={(e) => setFiltro({ ...filtro, etiqueta: e.target.value })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todas as etiquetas</option>
          {apoio.etiquetas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
        <label className="flex min-h-9 items-center gap-1.5 text-sm">
          <input type="checkbox" checked={filtro.minhas} onChange={(e) => setFiltro({ ...filtro, minhas: e.target.checked })} />
          Só as minhas
        </label>
        <label className="flex min-h-9 items-center gap-1.5 text-sm">
          <input type="checkbox" checked={filtro.atrasadas} onChange={(e) => setFiltro({ ...filtro, atrasadas: e.target.checked })} />
          Atrasadas
        </label>
        {podeCriar && (
          <Button className="ml-auto" onClick={() => setModal({ id: null })} data-testid="nova-tarefa">
            Nova tarefa
          </Button>
        )}
      </div>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}

      {visao === "quadro" && (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          <div className="grid min-w-[1100px] grid-cols-5 gap-3">
            {COLUNAS.map((c) => {
              const daColuna = visiveis.filter((t) => t.coluna === c).sort((a, b) => a.posicao - b.posicao);
              return (
                <section
                  key={c}
                  aria-label={ROTULO_DA_COLUNA[c]}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (arrastando) mover(arrastando, c, null);
                  }}
                  className={cn("flex min-h-64 flex-col gap-2 rounded-md border border-t-4 bg-muted/30 p-2", COR_DA_COLUNA[c])}
                >
                  <header className="flex items-center justify-between px-1 py-1">
                    <h2 className="text-sm font-semibold">{ROTULO_DA_COLUNA[c]}</h2>
                    <span className="text-xs text-muted-foreground">{daColuna.length}</span>
                  </header>
                  {daColuna.map((t) => cartao(t))}
                  {podeCriar && (
                    <button
                      type="button"
                      onClick={() => setModal({ id: null, coluna: c })}
                      className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
                    >
                      + Adicionar
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {visao === "lista" && (
        <div className="space-y-4">
          {COLUNAS.map((c) => {
            const daColuna = visiveis.filter((t) => t.coluna === c).sort((a, b) => a.posicao - b.posicao);
            if (daColuna.length === 0) return null;
            return (
              <section key={c} className="space-y-2">
                <h2 className="text-sm font-semibold">
                  {ROTULO_DA_COLUNA[c]} <span className="font-normal text-muted-foreground">({daColuna.length})</span>
                </h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {daColuna.map((t) => (
                    cartao(t)
                  ))}
                </div>
              </section>
            );
          })}
          {visiveis.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma tarefa por aqui.</p>}
        </div>
      )}

      {visao === "ranking" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ranking.map((g) => (
            <section key={g.nome} className="space-y-2 rounded-md border p-3">
              <header className="flex items-center justify-between">
                <h2 className="truncate text-sm font-semibold">{g.nome}</h2>
                <span className="rounded-full bg-muted px-2 text-xs">{g.tarefas.length}</span>
              </header>
              {g.tarefas.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setModal({ id: t.id })}
                  className={cn(
                    "block w-full truncate rounded-sm border px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                    estaAtrasada(t, agora) && "border-destructive text-destructive",
                  )}
                >
                  {t.titulo}
                </button>
              ))}
            </section>
          ))}
          {ranking.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma tarefa aberta.</p>}
        </div>
      )}

      <ModalDaTarefa
        aberto={modal !== null}
        tarefaId={modal?.id ?? null}
        colunaInicial={modal?.coluna}
        clienteInicial={clienteFixo}
        apoio={apoio}
        meuMembroId={meuMembroId}
        podeAtribuir={podeAtribuir}
        podeExcluir={podeAtribuir}
        aoFechar={(mudou) => {
          setModal(null);
          if (busca.get("abrir")) router.replace(window.location.pathname);
          if (mudou) router.refresh();
        }}
      />
    </div>
  );
}
