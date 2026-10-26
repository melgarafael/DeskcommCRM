"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type PointerEvent as EventoDePonteiro } from "react";

import { arquivarMapa, concluirMarco, desligarBlocos, excluirBloco, ligarBlocos, moverBloco, publicarOMapa, salvarBloco } from "@/app/actions/agencia/mapas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { diaDe, horaLocal, instanteDoDia } from "@/lib/agencia/calendario/regras";
import { CORES_DO_BLOCO } from "@/lib/agencia/mapas/regras";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { Check, Lock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O mapa mental (docs/agencia/SPEC-mapa-mental.md): Criação em rascunho, Ao vivo
 * depois de publicado. HTML + SVG com arrastar por ponteiro (M7: sem biblioteca
 * nova); no celular, lista com o mesmo painel.
 */
export interface BlocoDaTela {
  id: string;
  titulo: string;
  descricao: string | null;
  cor: string;
  x: number;
  y: number;
  tipo: "tarefa" | "marco";
  funcaoId: string | null;
  responsavelId: string | null;
  prazo: string | null;
  checklist: string[];
  links: string[];
  executor: "humano" | "ia";
  situacao: "bloqueado" | "liberado" | "em_andamento" | "concluido";
  tarefaId: string | null;
}

const LARGURA = 210;
const ALTURA = 64;
const AREA = { w: 2400, h: 1400 };

const ROTULO_DA_SITUACAO: Record<BlocoDaTela["situacao"], string> = {
  bloqueado: "Bloqueado",
  liberado: "Liberado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
};

interface Rascunho {
  id?: string;
  titulo: string;
  descricao: string;
  cor: string;
  tipo: "tarefa" | "marco";
  funcaoId: string;
  responsavelId: string;
  dia: string;
  hora: string;
  checklist: string;
  links: string;
  executor: "humano" | "ia";
  dependeDe: string[];
  x: number;
  y: number;
}

function deBloco(b: BlocoDaTela, dependeDe: string[]): Rascunho {
  return {
    id: b.id,
    titulo: b.titulo,
    descricao: b.descricao ?? "",
    cor: b.cor,
    tipo: b.tipo,
    funcaoId: b.funcaoId ?? "",
    responsavelId: b.responsavelId ?? "",
    dia: b.prazo ? diaDe(b.prazo) : "",
    hora: b.prazo ? horaLocal(b.prazo) : "18:00",
    checklist: b.checklist.join("\n"),
    links: b.links.join("\n"),
    executor: b.executor,
    dependeDe,
    x: b.x,
    y: b.y,
  };
}

export function TelaDoMapa(p: {
  mapa: { id: string; titulo: string; situacao: "rascunho" | "publicado" | "arquivado"; clienteNome: string };
  blocos: BlocoDaTela[];
  ligacoes: Array<{ de_id: string; para_id: string }>;
  membros: Array<{ id: string; nome: string }>;
  funcoes: Array<{ id: string; nome: string }>;
  podeEditar: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [posicoes, setPosicoes] = useState<Record<string, { x: number; y: number }>>({});
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [ligandoDe, setLigandoDe] = useState<string | null>(null);
  const arraste = useRef<{ id: string; dx: number; dy: number; moveu: boolean } | null>(null);
  const area = useRef<HTMLDivElement>(null);

  const criacao = p.mapa.situacao === "rascunho";
  const editavel = p.podeEditar && p.mapa.situacao !== "arquivado";
  const pos = (b: BlocoDaTela) => posicoes[b.id] ?? { x: b.x, y: b.y };
  const dependenciasDe = (id: string) => p.ligacoes.filter((l) => l.para_id === id).map((l) => l.de_id);
  const feitos = p.blocos.filter((b) => b.situacao === "concluido").length;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setLigandoDe(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  function agir(acao: () => Promise<{ ok: boolean; erro?: string }>, sucesso?: string) {
    setMsg(null);
    startTransition(async () => {
      const r = await acao();
      if (!r.ok) setMsg({ ok: false, texto: r.erro ?? "Algo deu errado." });
      else if (sucesso) setMsg({ ok: true, texto: sucesso });
      router.refresh();
    });
  }

  function abrir(b: BlocoDaTela) {
    if (ligandoDe && ligandoDe !== b.id) {
      const de = ligandoDe;
      setLigandoDe(null);
      agir(() => ligarBlocos(p.mapa.id, de, b.id));
      return;
    }
    setSelecionado(b.id);
    setRascunho(deBloco(b, dependenciasDe(b.id)));
  }

  /** O primeiro lugar livre: à direita do bloco escolhido, ou na próxima casa da grade. Bloco novo nunca cobre outro. */
  function lugarLivre(): { x: number; y: number } {
    const ocupa = (x: number, y: number) =>
      p.blocos.some((b) => {
        const q = pos(b);
        return Math.abs(q.x - x) < LARGURA + 20 && Math.abs(q.y - y) < ALTURA + 20;
      });
    // Só a parte visível do desenho conta: bloco criado fora dela parece não ter sido criado.
    const visivel = Math.min(AREA.w, (area.current?.clientWidth ?? 800) + (area.current?.scrollLeft ?? 0));
    const cabe = (x: number) => x + LARGURA <= visivel;
    const origem = selecionado ? p.blocos.find((b) => b.id === selecionado) : null;
    if (origem) {
      const q = pos(origem);
      const candidatos = [q.x + LARGURA + 70, q.x].filter(cabe);
      for (const x of candidatos) {
        for (let dy = x === q.x ? 1 : 0; dy < 8; dy++) {
          const y = Math.min(AREA.h - ALTURA, q.y + dy * (ALTURA + 30));
          if (!ocupa(x, y)) return { x, y };
        }
      }
    }
    const colunas = Math.max(1, Math.floor((visivel - 40) / (LARGURA + 70)));
    for (let i = 0; i < 400; i++) {
      const x = 40 + (i % colunas) * (LARGURA + 70);
      const y = 40 + Math.floor(i / colunas) * (ALTURA + 60);
      if (!ocupa(x, y)) return { x, y };
    }
    return { x: 40, y: 40 };
  }

  function novoBloco() {
    const { x, y } = lugarLivre();
    const el = area.current;
    if (el && (y < el.scrollTop || y + ALTURA > el.scrollTop + el.clientHeight)) el.scrollTo({ top: Math.max(0, y - 40), behavior: "smooth" });
    setSelecionado(null);
    setRascunho({
      titulo: "",
      descricao: "",
      cor: CORES_DO_BLOCO[p.blocos.length % CORES_DO_BLOCO.length]!,
      tipo: "tarefa",
      funcaoId: "",
      responsavelId: "",
      dia: "",
      hora: "18:00",
      checklist: "",
      links: "",
      executor: "humano",
      dependeDe: selecionado ? [selecionado] : [],
      x,
      y,
    });
  }

  function salvar() {
    if (!rascunho) return;
    const r = rascunho;
    startTransition(async () => {
      const res = await salvarBloco({
        ...(r.id ? { id: r.id } : {}),
        mapaId: p.mapa.id,
        titulo: r.titulo,
        descricao: r.descricao || null,
        cor: r.cor,
        x: r.x,
        y: r.y,
        tipo: r.tipo,
        funcaoId: r.responsavelId ? null : r.funcaoId || null,
        responsavelId: r.responsavelId || null,
        prazo: r.dia ? instanteDoDia(r.dia, r.hora || "18:00").toISOString() : null,
        checklist: r.checklist.split("\n").map((x) => x.trim()).filter(Boolean),
        links: r.links.split("\n").map((x) => x.trim()).filter(Boolean),
        executor: r.executor,
        dependeDe: r.dependeDe,
      });
      if (!res.ok) return setMsg({ ok: false, texto: res.erro });
      setMsg({ ok: true, texto: "Bloco salvo." });
      setSelecionado(res.dados.id);
      setRascunho((x) => (x ? { ...x, id: res.dados.id } : x));
      router.refresh();
    });
  }

  // ── Arrastar ──
  function aoApertar(e: EventoDePonteiro<HTMLDivElement>, b: BlocoDaTela) {
    if (!editavel || ligandoDe) return;
    const atual = pos(b);
    const caixa = area.current?.getBoundingClientRect();
    if (!caixa) return;
    arraste.current = { id: b.id, dx: e.clientX - caixa.left + (area.current?.scrollLeft ?? 0) - atual.x, dy: e.clientY - caixa.top + (area.current?.scrollTop ?? 0) - atual.y, moveu: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function aoMover(e: EventoDePonteiro<HTMLDivElement>) {
    const a = arraste.current;
    const caixa = area.current?.getBoundingClientRect();
    if (!a || !caixa) return;
    const x = Math.min(AREA.w - LARGURA, Math.max(0, e.clientX - caixa.left + (area.current?.scrollLeft ?? 0) - a.dx));
    const y = Math.min(AREA.h - ALTURA, Math.max(0, e.clientY - caixa.top + (area.current?.scrollTop ?? 0) - a.dy));
    a.moveu = true;
    setPosicoes((s) => ({ ...s, [a.id]: { x, y } }));
  }
  function aoSoltar(b: BlocoDaTela) {
    const a = arraste.current;
    arraste.current = null;
    if (!a) return;
    if (!a.moveu) return abrir(b);
    const final = posicoes[a.id];
    if (final) startTransition(async () => void (await moverBloco(a.id, final.x, final.y)));
  }

  const cartaoDoBloco = (b: BlocoDaTela) => (
    <>
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-sm font-medium">{b.titulo || "Sem título"}</span>
        {!criacao && (b.situacao === "bloqueado" ? <Lock size={13} aria-hidden /> : b.situacao === "concluido" ? <Check size={13} aria-hidden /> : null)}
      </div>
      <span className="block truncate text-[11px] text-muted-foreground">
        {[
          b.tipo === "marco" ? "Marco" : null,
          b.executor === "ia" ? "IA" : null,
          p.membros.find((m) => m.id === b.responsavelId)?.nome ?? p.funcoes.find((f) => f.id === b.funcaoId)?.nome,
          b.prazo ? formatarDataHora(b.prazo) : null,
          !criacao ? ROTULO_DA_SITUACAO[b.situacao] : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </>
  );

  const estiloDoEstado = (b: BlocoDaTela) =>
    criacao
      ? ""
      : b.situacao === "bloqueado"
        ? "opacity-55"
        : b.situacao === "concluido"
          ? "ring-2 ring-emerald-500/60"
          : b.situacao === "em_andamento"
            ? "ring-2 ring-amber-500/70"
            : "ring-2 ring-primary/70";

  const selecionadoBloco = p.blocos.find((b) => b.id === selecionado) ?? null;
  const tituloDe = (id: string) => p.blocos.find((b) => b.id === id)?.titulo ?? "?";

  return (
    <div className="space-y-4" data-testid="tela-do-mapa" data-modo={criacao ? "criacao" : "ao-vivo"}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Link href="/agencia/mapas" className="text-sm text-muted-foreground underline underline-offset-4">
            ← Mapas
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{p.mapa.titulo}</h1>
          <p className="text-sm text-muted-foreground">
            {p.mapa.clienteNome} ·{" "}
            {criacao ? "Criação (rascunho — nada vira tarefa ainda)" : p.mapa.situacao === "arquivado" ? "Arquivado" : `Ao vivo · ${feitos} de ${p.blocos.length} concluídos`}
          </p>
        </div>
        {editavel && (
          <div className="flex flex-wrap gap-2">
            {criacao && (
              <Button type="button" variant="outline" onClick={novoBloco} disabled={pendente}>
                Novo bloco
              </Button>
            )}
            {criacao && (
              <Button
                type="button"
                disabled={pendente}
                onClick={() =>
                  window.confirm("Publicar o mapa? Depois disso as setas não mudam, e os blocos sem dependência viram tarefas agora.") &&
                  agir(() => publicarOMapa(p.mapa.id), "Mapa publicado: os primeiros blocos viraram tarefas.")
                }
              >
                Publicar
              </Button>
            )}
            {!criacao && (
              <Button type="button" variant="ghost" disabled={pendente} onClick={() => window.confirm("Arquivar este mapa?") && agir(() => arquivarMapa(p.mapa.id), "Mapa arquivado.")}>
                Arquivar
              </Button>
            )}
          </div>
        )}
      </div>

      {!criacao && (
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={feitos} aria-valuemax={p.blocos.length}>
          <div className="h-full bg-primary transition-all" style={{ width: `${p.blocos.length ? (feitos / p.blocos.length) * 100 : 0}%` }} />
        </div>
      )}
      {ligandoDe && (
        <p className="rounded-md border border-primary/50 bg-primary/5 p-2 text-sm" role="status">
          Clique no bloco que depende de <strong>{tituloDe(ligandoDe)}</strong> (Esc cancela).
        </p>
      )}
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="mensagem-do-mapa">
          {msg.texto}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        {/* Desenho (computador) */}
        <div ref={area} className="relative max-h-[70vh] overflow-auto rounded-md border bg-muted/20 max-md:hidden" data-testid="desenho-do-mapa">
          <div className="relative" style={{ width: AREA.w, height: AREA.h }}>
            <svg className="pointer-events-none absolute inset-0" width={AREA.w} height={AREA.h} aria-hidden>
              <defs>
                <marker id="seta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
                </marker>
              </defs>
              {p.ligacoes.map((l) => {
                const de = p.blocos.find((b) => b.id === l.de_id);
                const para = p.blocos.find((b) => b.id === l.para_id);
                if (!de || !para) return null;
                const a = pos(de);
                const b = pos(para);
                return (
                  <line
                    key={`${l.de_id}-${l.para_id}`}
                    x1={a.x + LARGURA}
                    y1={a.y + ALTURA / 2}
                    x2={b.x}
                    y2={b.y + ALTURA / 2}
                    className="stroke-muted-foreground"
                    strokeWidth={1.5}
                    markerEnd="url(#seta)"
                  />
                );
              })}
            </svg>
            {criacao &&
              editavel &&
              p.ligacoes.map((l) => {
                const de = p.blocos.find((b) => b.id === l.de_id);
                const para = p.blocos.find((b) => b.id === l.para_id);
                if (!de || !para) return null;
                const a = pos(de);
                const b = pos(para);
                return (
                  <button
                    key={`x-${l.de_id}-${l.para_id}`}
                    type="button"
                    title="Tirar esta seta"
                    aria-label={`Tirar a seta de ${de.titulo} para ${para.titulo}`}
                    onClick={() => agir(() => desligarBlocos(p.mapa.id, l.de_id, l.para_id))}
                    className="absolute flex h-5 w-5 items-center justify-center rounded-full border bg-background text-[10px] text-muted-foreground hover:text-destructive"
                    style={{ left: (a.x + LARGURA + b.x) / 2 - 10, top: (a.y + b.y + ALTURA) / 2 - 10 }}
                  >
                    ×
                  </button>
                );
              })}
            {p.blocos.map((b) => {
              const { x, y } = pos(b);
              return (
                <div
                  key={b.id}
                  data-testid="bloco-do-mapa"
                  data-situacao={b.situacao}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => aoApertar(e, b)}
                  onPointerMove={aoMover}
                  onPointerUp={() => (editavel && !ligandoDe ? aoSoltar(b) : abrir(b))}
                  onKeyDown={(e) => e.key === "Enter" && abrir(b)}
                  className={cn(
                    "absolute flex touch-none select-none flex-col justify-center rounded-md border bg-card px-3 shadow-sm",
                    editavel ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    selecionado === b.id && "outline outline-2 outline-foreground",
                    estiloDoEstado(b),
                  )}
                  style={{ left: x, top: y, width: LARGURA, height: ALTURA, borderLeft: `6px solid ${b.cor}` }}
                >
                  {cartaoDoBloco(b)}
                  {criacao && editavel && (
                    <button
                      type="button"
                      title="Ligar a outro bloco"
                      aria-label={`Ligar ${b.titulo} a outro bloco`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLigandoDe(b.id);
                      }}
                      className="absolute -right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-xs"
                    >
                      →
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Lista (celular) */}
        <ul className="space-y-2 md:hidden" data-testid="lista-do-mapa">
          {p.blocos.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => abrir(b)} className={cn("w-full rounded-md border bg-card p-3 text-left", estiloDoEstado(b))} style={{ borderLeft: `6px solid ${b.cor}` }}>
                {cartaoDoBloco(b)}
                {dependenciasDe(b.id).length > 0 && <span className="block text-[11px] text-muted-foreground">Depois de: {dependenciasDe(b.id).map(tituloDe).join(", ")}</span>}
              </button>
            </li>
          ))}
          {p.blocos.length === 0 && <li className="text-sm text-muted-foreground">Nenhum bloco ainda.</li>}
        </ul>

        {/* Painel */}
        <aside className="space-y-3 rounded-md border p-4" data-testid="painel-do-bloco">
          {!rascunho ? (
            <p className="text-sm text-muted-foreground">
              {criacao ? "Clique num bloco para editar, ou crie um novo. A seta → liga um bloco ao que vem depois." : "Clique num bloco para ver os detalhes."}
            </p>
          ) : (
            <>
              <h2 className="font-semibold">{rascunho.id ? "Bloco" : "Novo bloco"}</h2>
              {!criacao && selecionadoBloco && (
                <div className="space-y-2 text-sm">
                  <p>
                    <strong>{ROTULO_DA_SITUACAO[selecionadoBloco.situacao]}</strong>
                    {selecionadoBloco.situacao === "bloqueado" && dependenciasDe(selecionadoBloco.id).length > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        Espera: {dependenciasDe(selecionadoBloco.id).filter((d) => p.blocos.find((x) => x.id === d)?.situacao !== "concluido").map(tituloDe).join(", ")}
                      </span>
                    )}
                  </p>
                  {selecionadoBloco.tarefaId && (
                    <Link href={`/agencia/tarefas?abrir=${selecionadoBloco.tarefaId}`} className="inline-block rounded-md border px-2 py-1 text-xs">
                      Abrir tarefa
                    </Link>
                  )}
                  {editavel && selecionadoBloco.tipo === "marco" && (selecionadoBloco.situacao === "liberado" || selecionadoBloco.situacao === "em_andamento") && (
                    <Button type="button" size="sm" disabled={pendente} onClick={() => agir(() => concluirMarco(selecionadoBloco.id), "Marco concluído.")}>
                      Concluir marco
                    </Button>
                  )}
                </div>
              )}
              <fieldset disabled={!editavel || pendente} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="bloco-titulo">Título</Label>
                  <Input id="bloco-titulo" value={rascunho.titulo} onChange={(e) => setRascunho({ ...rascunho, titulo: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Cor">
                  {CORES_DO_BLOCO.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Cor ${c}`}
                      aria-checked={rascunho.cor === c}
                      role="radio"
                      onClick={() => setRascunho({ ...rascunho, cor: c })}
                      className={cn("h-6 w-6 rounded-full border", rascunho.cor === c && "ring-2 ring-foreground ring-offset-1")}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="bloco-tipo">Tipo</Label>
                    <select id="bloco-tipo" value={rascunho.tipo} disabled={!criacao} onChange={(e) => setRascunho({ ...rascunho, tipo: e.target.value as "tarefa" | "marco" })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                      <option value="tarefa">Tarefa</option>
                      <option value="marco">Marco</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="bloco-executor">Quem executa</Label>
                    <select id="bloco-executor" value={rascunho.executor} onChange={(e) => setRascunho({ ...rascunho, executor: e.target.value as "humano" | "ia" })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                      <option value="humano">Pessoa</option>
                      <option value="ia">IA</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bloco-responsavel">Responsável</Label>
                  <select id="bloco-responsavel" value={rascunho.responsavelId} onChange={(e) => setRascunho({ ...rascunho, responsavelId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                    <option value="">Ninguém (vai para a função)</option>
                    {p.membros.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.nome}
                      </option>
                    ))}
                  </select>
                </div>
                {!rascunho.responsavelId && (
                  <div className="space-y-1">
                    <Label htmlFor="bloco-funcao">Função</Label>
                    <select id="bloco-funcao" value={rascunho.funcaoId} onChange={(e) => setRascunho({ ...rascunho, funcaoId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                      <option value="">Nenhuma</option>
                      {p.funcoes.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.nome}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="grid grid-cols-[1fr_6rem] gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="bloco-dia">Prazo</Label>
                    <Input id="bloco-dia" type="date" value={rascunho.dia} onChange={(e) => setRascunho({ ...rascunho, dia: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="bloco-hora">Hora</Label>
                    <Input id="bloco-hora" type="time" value={rascunho.hora} onChange={(e) => setRascunho({ ...rascunho, hora: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bloco-descricao">Descrição</Label>
                  <textarea id="bloco-descricao" rows={2} value={rascunho.descricao} onChange={(e) => setRascunho({ ...rascunho, descricao: e.target.value })} className="w-full rounded-md border bg-background p-2 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bloco-checklist">Checklist (um por linha)</Label>
                  <textarea id="bloco-checklist" rows={3} value={rascunho.checklist} onChange={(e) => setRascunho({ ...rascunho, checklist: e.target.value })} className="w-full rounded-md border bg-background p-2 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bloco-links">Links e anexos (um por linha)</Label>
                  <textarea id="bloco-links" rows={2} value={rascunho.links} onChange={(e) => setRascunho({ ...rascunho, links: e.target.value })} placeholder="https://…" className="w-full rounded-md border bg-background p-2 text-sm" />
                </div>
                <fieldset className="space-y-1" disabled={!criacao}>
                  <legend className="text-sm font-medium">Depois de</legend>
                  <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {p.blocos
                      .filter((b) => b.id !== rascunho.id)
                      .map((b) => (
                        <label key={b.id} className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                          <input
                            type="checkbox"
                            checked={rascunho.dependeDe.includes(b.id)}
                            onChange={(e) =>
                              setRascunho({ ...rascunho, dependeDe: e.target.checked ? [...rascunho.dependeDe, b.id] : rascunho.dependeDe.filter((d) => d !== b.id) })
                            }
                          />
                          {b.titulo || "Sem título"}
                        </label>
                      ))}
                  </div>
                </fieldset>
              </fieldset>
              {editavel && (
                <div className="flex flex-wrap justify-between gap-2">
                  <Button type="button" onClick={salvar} disabled={pendente || rascunho.titulo.trim().length < 1}>
                    Salvar bloco
                  </Button>
                  {criacao && rascunho.id && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pendente}
                      onClick={() => {
                        const id = rascunho.id!;
                        setRascunho(null);
                        setSelecionado(null);
                        agir(() => excluirBloco(id));
                      }}
                    >
                      Apagar
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
