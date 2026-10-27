"use client";

import { useEffect, useState, useTransition } from "react";

import { definirAcaoDaIa, executarTarefaComIa } from "@/app/actions/agencia/ia";
import {
  abrirTarefa,
  criarEmLote,
  criarEtiqueta,
  excluirTarefa,
  iniciarCronometro,
  lancarTempo,
  pausarCronometro,
  salvarTarefa,
} from "@/app/actions/agencia/tarefas";
import { EnvioParaODrive } from "@/components/agencia/EnvioParaODrive";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACOES_DA_IA, ROTULO_DA_ACAO_DA_IA } from "@/lib/agencia/ia/catalogo";
import type { TarefaCompleta } from "@/lib/agencia/tarefas/consultas";
import { formatarDuracao, tempoTotalSegundos } from "@/lib/agencia/tarefas/regras";
import {
  COLUNAS,
  PRIORIDADES,
  ROTULO_DA_COLUNA,
  ROTULO_DA_PRIORIDADE,
  type Coluna,
  type Prioridade,
} from "@/lib/agencia/tarefas/vocabulario";
import { cn } from "@/lib/utils";

export interface ApoioDoQuadro {
  membros: Array<{ id: string; nome: string }>;
  funcoes: Array<{ id: string; nome: string; cor: string }>;
  etiquetas: Array<{ id: string; nome: string; cor: string }>;
  clientes: Array<{ id: string; nome: string }>;
}

interface Rascunho {
  titulo: string;
  descricao: string;
  coluna: Coluna;
  prioridade: Prioridade;
  prazo: string; // datetime-local
  clienteId: string;
  funcaoId: string;
  responsaveis: string[];
  etiquetas: string[];
  checklist: Array<{ texto: string; feito: boolean }>;
  links: Array<{ titulo: string; url: string }>;
}

function paraLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function vazio(coluna: Coluna, clienteId: string | null, membroId: string | null): Rascunho {
  return {
    titulo: "",
    descricao: "",
    coluna,
    prioridade: "media",
    prazo: "",
    clienteId: clienteId ?? "",
    funcaoId: "",
    responsaveis: membroId ? [membroId] : [],
    etiquetas: [],
    checklist: [],
    links: [],
  };
}

function deTarefa(t: TarefaCompleta): Rascunho {
  return {
    titulo: t.titulo,
    descricao: t.descricao ?? "",
    coluna: t.coluna,
    prioridade: t.prioridade,
    prazo: paraLocal(t.prazo),
    clienteId: t.clienteId ?? "",
    funcaoId: t.funcaoId ?? "",
    responsaveis: t.responsaveis,
    etiquetas: t.etiquetas,
    checklist: t.checklist.map((c) => ({ texto: c.texto, feito: c.feito })),
    links: t.links.map((l) => ({ titulo: l.titulo, url: l.url })),
  };
}

export function ModalDaTarefa({
  aberto,
  tarefaId,
  colunaInicial = "a_fazer",
  clienteInicial = null,
  apoio,
  meuMembroId,
  podeAtribuir,
  podeExcluir,
  aoFechar,
}: {
  aberto: boolean;
  tarefaId: string | null;
  colunaInicial?: Coluna;
  clienteInicial?: string | null;
  apoio: ApoioDoQuadro;
  meuMembroId: string | null;
  podeAtribuir: boolean;
  podeExcluir: boolean;
  aoFechar: (mudou: boolean) => void;
}) {
  const [tarefa, setTarefa] = useState<TarefaCompleta | null>(null);
  const [r, setR] = useState<Rascunho>(() => vazio(colunaInicial, clienteInicial, meuMembroId));
  const [etiquetas, setEtiquetas] = useState(apoio.etiquetas);
  const [novoItem, setNovoItem] = useState("");
  const [novoLink, setNovoLink] = useState({ titulo: "", url: "" });
  const [novaEtiqueta, setNovaEtiqueta] = useState({ nome: "", cor: "#2563eb" });
  const [minutos, setMinutos] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // O que a IA respondeu (erro ou pronto) aparece na própria caixa da IA, à vista de quem clicou.
  const [falaDaIa, setFalaDaIa] = useState<{ ok: boolean; texto: string } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [pendente, startTransition] = useTransition();
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    setAviso(null);
    setFalaDaIa(null);
    if (!tarefaId) {
      setTarefa(null);
      setR(vazio(colunaInicial, clienteInicial, meuMembroId));
      return;
    }
    setCarregando(true);
    void abrirTarefa(tarefaId).then((t) => {
      setCarregando(false);
      if (!t) {
        setErro("Tarefa não encontrada.");
        return;
      }
      setTarefa(t);
      setR(deTarefa(t));
    });
  }, [aberto, tarefaId, colunaInicial, clienteInicial, meuMembroId]);

  const rodandoAqui = !!tarefa && !!meuMembroId && tarefa.rodandoPor.includes(meuMembroId);
  useEffect(() => {
    if (!rodandoAqui) return;
    const relogio = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(relogio);
  }, [rodandoAqui]);

  const recarregar = async () => {
    if (!tarefa) return;
    const t = await abrirTarefa(tarefa.id);
    if (t) setTarefa(t);
  };

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    startTransition(async () => {
      const res = await salvarTarefa({
        id: tarefa?.id,
        titulo: r.titulo,
        descricao: r.descricao || null,
        coluna: r.coluna,
        prioridade: r.prioridade,
        prazo: r.prazo ? new Date(r.prazo).toISOString() : null,
        clienteId: r.clienteId || null,
        funcaoId: r.funcaoId || null,
        responsaveis: r.responsaveis,
        etiquetas: r.etiquetas,
        checklist: r.checklist,
        links: r.links,
        // Tarefa da IA continua da IA: quem escolhe é o seletor "O que a IA faz".
        executor: tarefa?.executor ?? "humano",
      });
      if (res.ok) aoFechar(true);
      else setErro(res.erro);
    });
  }

  function alternar<K extends "responsaveis" | "etiquetas">(campo: K, id: string) {
    setR((a) => ({ ...a, [campo]: a[campo].includes(id) ? a[campo].filter((x) => x !== id) : [...a[campo], id] }));
  }

  const tempoTotal = tarefa ? tempoTotalSegundos(tarefa.sessoes, new Date(agora)) : 0;

  /** Depois da IA a tarefa muda no servidor (coluna, checklist): o formulário relê, senão o Salvar desfaria. */
  async function reler() {
    if (!tarefa) return;
    const t = await abrirTarefa(tarefa.id);
    if (t) {
      setTarefa(t);
      setR(deTarefa(t));
    }
  }
  function escolherAcaoDaIa(valor: string) {
    if (!tarefa) return;
    setFalaDaIa(null);
    startTransition(async () => {
      const res = await definirAcaoDaIa(tarefa.id, valor || null);
      if (!res.ok) return setFalaDaIa({ ok: false, texto: res.erro });
      await reler();
    });
  }
  function executarComIa() {
    if (!tarefa) return;
    setFalaDaIa(null);
    startTransition(async () => {
      const res = await executarTarefaComIa(tarefa.id);
      if (!res.ok) return setFalaDaIa({ ok: false, texto: res.erro });
      setFalaDaIa({ ok: true, texto: "A IA terminou: confira o resultado. A tarefa foi para Revisão." });
      await reler();
    });
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar(false)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={salvar} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{tarefa ? "Editar tarefa" : "Nova tarefa"}</DialogTitle>
            <DialogDescription>{carregando ? "Carregando…" : "Quem for responsável recebe o aviso no sininho e no WhatsApp."}</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="tarefa-titulo">Título</Label>
            <Input id="tarefa-titulo" value={r.titulo} onChange={(e) => setR({ ...r, titulo: e.target.value })} required />
          </div>

          {tarefa && (
            <div className="space-y-2 rounded-md border p-3" data-testid="ia-da-tarefa">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[14rem] flex-1 space-y-1">
                  <Label htmlFor="tarefa-acao-ia">IA</Label>
                  <select id="tarefa-acao-ia" value={tarefa.acaoIa ?? ""} disabled={pendente} onChange={(e) => escolherAcaoDaIa(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                    <option value="">Sem IA (feita por pessoa)</option>
                    {ACOES_DA_IA.map((a) => (
                      <option key={a} value={a}>
                        {ROTULO_DA_ACAO_DA_IA[a]}
                      </option>
                    ))}
                  </select>
                </div>
                {tarefa.acaoIa && (
                  <Button type="button" variant="outline" disabled={pendente || tarefa.coluna === "concluido"} onClick={executarComIa}>
                    {pendente ? "Trabalhando…" : tarefa.resultadoIa ? "Executar de novo" : "Executar com IA"}
                  </Button>
                )}
              </div>
              {falaDaIa && (
                <p role={falaDaIa.ok ? "status" : "alert"} data-testid="fala-da-ia" className={cn("text-sm", falaDaIa.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
                  {falaDaIa.texto}
                </p>
              )}
              {tarefa.resultadoIa && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Resultado da IA (confira antes de usar)</span>
                    <button type="button" className="text-xs underline" onClick={() => void navigator.clipboard?.writeText(tarefa.resultadoIa ?? "")}>
                      Copiar
                    </button>
                  </div>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-sans text-sm" data-testid="resultado-da-ia">
                    {tarefa.resultadoIa}
                  </pre>
                </div>
              )}
            </div>
          )}

          {tarefa?.clienteId && (
            <a
              href={`/agencia/envios?novo=1&cliente=${tarefa.clienteId}&tarefa=${tarefa.id}&titulo=${encodeURIComponent(tarefa.titulo)}`}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent/40"
              data-testid="enviar-para-aprovar"
            >
              Enviar para o cliente aprovar
            </a>
          )}

          <div className="space-y-2">
            <Label>Checklist</Label>
            {r.checklist.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={c.feito}
                  aria-label={`Feito: ${c.texto}`}
                  onChange={() => setR({ ...r, checklist: r.checklist.map((x, j) => (j === i ? { ...x, feito: !x.feito } : x)) })}
                />
                <span className={cn("flex-1", c.feito && "text-muted-foreground line-through")}>{c.texto}</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => setR({ ...r, checklist: r.checklist.filter((_, j) => j !== i) })}
                >
                  remover
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                placeholder="Adicionar um item"
                value={novoItem}
                onChange={(e) => setNovoItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (novoItem.trim()) {
                      setR({ ...r, checklist: [...r.checklist, { texto: novoItem.trim(), feito: false }] });
                      setNovoItem("");
                    }
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!novoItem.trim()) return;
                  setR({ ...r, checklist: [...r.checklist, { texto: novoItem.trim(), feito: false }] });
                  setNovoItem("");
                }}
              >
                Adicionar
              </Button>
            </div>
            {tarefa && tarefa.checklist.some((c) => !c.feito) && (
              <button
                type="button"
                className="text-xs underline underline-offset-4"
                disabled={pendente}
                onClick={() =>
                  startTransition(async () => {
                    const res = await criarEmLote(tarefa.id);
                    setAviso(res.ok ? `${res.dados.criadas} tarefa(s) criada(s) a partir do checklist.` : res.erro);
                  })
                }
              >
                Criar tarefas em lote — uma por item em aberto
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tarefa-descricao">Descrição</Label>
            <textarea
              id="tarefa-descricao"
              rows={3}
              value={r.descricao}
              onChange={(e) => setR({ ...r, descricao: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-coluna">Status</Label>
              <select
                id="tarefa-coluna"
                value={r.coluna}
                onChange={(e) => setR({ ...r, coluna: e.target.value as Coluna })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {COLUNAS.map((c) => (
                  <option key={c} value={c}>
                    {ROTULO_DA_COLUNA[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-prioridade">Prioridade</Label>
              <select
                id="tarefa-prioridade"
                value={r.prioridade}
                onChange={(e) => setR({ ...r, prioridade: e.target.value as Prioridade })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {PRIORIDADES.map((p) => (
                  <option key={p} value={p}>
                    {ROTULO_DA_PRIORIDADE[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-prazo">Data limite</Label>
              <Input id="tarefa-prazo" type="datetime-local" value={r.prazo} onChange={(e) => setR({ ...r, prazo: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tarefa-cliente">Cliente</Label>
              <select
                id="tarefa-cliente"
                value={r.clienteId}
                onChange={(e) => setR({ ...r, clienteId: e.target.value })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Tarefa interna (sem cliente)</option>
                {apoio.clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Responsáveis</legend>
            <div className="flex flex-wrap gap-2">
              {apoio.membros
                .filter((m) => podeAtribuir || m.id === meuMembroId || r.responsaveis.includes(m.id))
                .map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={r.responsaveis.includes(m.id)}
                    onClick={() => alternar("responsaveis", m.id)}
                    className={cn(
                      "min-h-9 rounded-full border px-3 text-sm",
                      r.responsaveis.includes(m.id) ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
                    )}
                  >
                    {m.nome}
                  </button>
                ))}
            </div>
            {podeAtribuir && (
              <div className="space-y-1.5">
                <Label htmlFor="tarefa-funcao">Ou mandar para uma função</Label>
                <select
                  id="tarefa-funcao"
                  value={r.funcaoId}
                  onChange={(e) => setR({ ...r, funcaoId: e.target.value })}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Nenhuma</option>
                  {apoio.funcoes.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nome} — todos da função veem, e quem pegar fica com ela
                    </option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Etiquetas</legend>
            <div className="flex flex-wrap gap-2">
              {etiquetas.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={r.etiquetas.includes(e.id)}
                  onClick={() => alternar("etiquetas", e.id)}
                  className="min-h-8 rounded-full border px-2.5 text-xs"
                  style={r.etiquetas.includes(e.id) ? { background: e.cor, borderColor: e.cor, color: "#fff" } : { borderColor: e.cor, color: e.cor }}
                >
                  {e.nome}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Nova etiqueta"
                value={novaEtiqueta.nome}
                onChange={(e) => setNovaEtiqueta({ ...novaEtiqueta, nome: e.target.value })}
              />
              <input
                type="color"
                aria-label="Cor da nova etiqueta"
                value={novaEtiqueta.cor}
                onChange={(e) => setNovaEtiqueta({ ...novaEtiqueta, cor: e.target.value })}
                className="h-10 w-12 rounded-md border bg-background"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!novaEtiqueta.nome.trim() || pendente}
                onClick={() =>
                  startTransition(async () => {
                    const res = await criarEtiqueta(novaEtiqueta.nome, novaEtiqueta.cor);
                    if (!res.ok) return setErro(res.erro);
                    setEtiquetas((l) => (l.some((x) => x.id === res.dados.id) ? l : [...l, { id: res.dados.id, ...novaEtiqueta }]));
                    setR((a) => ({ ...a, etiquetas: [...new Set([...a.etiquetas, res.dados.id])] }));
                    setNovaEtiqueta({ nome: "", cor: novaEtiqueta.cor });
                  })
                }
              >
                Criar
              </Button>
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Links</legend>
            {r.links.map((l, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <a href={l.url} target="_blank" rel="noreferrer" className="flex-1 truncate underline underline-offset-4">
                  {l.titulo}
                </a>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => setR({ ...r, links: r.links.filter((_, j) => j !== i) })}
                >
                  remover
                </button>
              </div>
            ))}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input placeholder="Título" value={novoLink.titulo} onChange={(e) => setNovoLink({ ...novoLink, titulo: e.target.value })} />
              <Input placeholder="https://" value={novoLink.url} onChange={(e) => setNovoLink({ ...novoLink, url: e.target.value })} />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!novoLink.titulo.trim() || !/^https?:\/\//i.test(novoLink.url.trim())) {
                    setErro("O link precisa de um título e começar com http.");
                    return;
                  }
                  setR({ ...r, links: [...r.links, { titulo: novoLink.titulo.trim(), url: novoLink.url.trim() }] });
                  setNovoLink({ titulo: "", url: "" });
                }}
              >
                Adicionar
              </Button>
            </div>
          </fieldset>

          {tarefa && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Anexos no Google Drive</legend>
              {tarefa.arquivos.map((a) => (
                <a key={a.id} href={a.link} target="_blank" rel="noreferrer" className="block truncate text-sm underline underline-offset-4">
                  {a.nome}
                </a>
              ))}
              {tarefa.clienteId ? (
                <EnvioParaODrive clienteId={tarefa.clienteId} tarefaId={tarefa.id} aoTerminar={() => void recarregar()} />
              ) : (
                <p className="text-xs text-muted-foreground">Escolha um cliente e salve para anexar arquivos na pasta dele.</p>
              )}
            </fieldset>
          )}

          {tarefa && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Tempo</legend>
              <p className="font-mono text-lg" data-testid="tempo-da-tarefa">
                {formatarDuracao(tempoTotal)}
              </p>
              {meuMembroId ? (
                <div className="flex flex-wrap items-center gap-2">
                  {rodandoAqui ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pendente}
                      onClick={() => startTransition(async () => { await pausarCronometro(); await recarregar(); })}
                    >
                      Pausar
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pendente}
                      onClick={() => startTransition(async () => { const res = await iniciarCronometro(tarefa.id); if (!res.ok) setErro(res.erro); await recarregar(); })}
                    >
                      Iniciar
                    </Button>
                  )}
                  <Input
                    className="w-28"
                    inputMode="numeric"
                    placeholder="minutos"
                    value={minutos}
                    onChange={(e) => setMinutos(e.target.value.replace(/\D/g, ""))}
                    aria-label="Minutos para lançar"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={!minutos || pendente}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await lancarTempo(tarefa.id, Number(minutos));
                        if (!res.ok) setErro(res.erro);
                        setMinutos("");
                        await recarregar();
                      })
                    }
                  >
                    Lançar
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Ative seu perfil em Perfil para usar o cronômetro.</p>
              )}
            </fieldset>
          )}

          <div className="space-y-1.5">
            <Label>Quem executa</Label>
            <p className="text-sm text-muted-foreground">Humano. A execução pela IA chega numa próxima etapa.</p>
          </div>

          {aviso && (
            <p role="status" className="text-sm text-muted-foreground">
              {aviso}
            </p>
          )}
          {erro && (
            <p role="alert" className="text-sm text-destructive">
              {erro}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {tarefa && podeExcluir ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={pendente}
                onClick={() =>
                  startTransition(async () => {
                    if (!window.confirm("Excluir esta tarefa? Não dá para desfazer.")) return;
                    const res = await excluirTarefa(tarefa.id);
                    if (res.ok) aoFechar(true);
                    else setErro(res.erro);
                  })
                }
              >
                Excluir
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pendente || carregando}>
              {pendente ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
