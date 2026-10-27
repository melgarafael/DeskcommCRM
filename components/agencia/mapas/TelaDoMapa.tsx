"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createElement,
  useMemo,
  useState,
  useTransition,
  type ComponentType,
  type DragEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { aplicarPropostaDaIa, proporBlocosComIa } from "@/app/actions/agencia/ia";
import {
  adicionarBloco,
  arquivarMapa,
  concluirMarco,
  desligarBlocos,
  excluirBloco,
  ligarBlocos,
  moverBloco,
  publicarOMapa,
  salvarBloco,
} from "@/app/actions/agencia/mapas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { diaDe, horaLocal, instanteDoDia } from "@/lib/agencia/calendario/regras";
import { ACOES_DA_IA, ROTULO_DA_ACAO_DA_IA, type AcaoDaIa } from "@/lib/agencia/ia/catalogo";
import type { Proposta } from "@/lib/agencia/ia/proposta";
import {
  ESPECIES_DE_BLOCO,
  GRUPOS_DE_BLOCO,
  especieDe,
  type GrupoDeBloco,
  type TipoDeBloco,
} from "@/lib/agencia/mapas/blocos";
import { CORES_DO_BLOCO } from "@/lib/agencia/mapas/regras";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import * as Icones from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O mapa mental no motor do Fluxo das organizações (plano de 27/10, item 5): a
 * mesma tela que se movimenta (React Flow), paleta de blocos que já fazem a sua
 * função, "+" que cria o próximo já ligado e painel lateral. Criação (rascunho) e
 * Ao vivo (publicado) continuam; no celular, lista com o mesmo painel.
 */
export interface BlocoDaTela {
  id: string;
  especie: string;
  titulo: string;
  descricao: string | null;
  cor: string;
  x: number;
  y: number;
  tipo: TipoDeBloco;
  config: { texto?: string; rede?: string; formato?: string };
  funcaoId: string | null;
  responsavelId: string | null;
  prazo: string | null;
  checklist: string[];
  links: string[];
  executor: "humano" | "ia";
  acaoIa: string | null;
  situacao: "bloqueado" | "liberado" | "em_andamento" | "concluido";
  tarefaId: string | null;
  envioId: string | null;
  publicacaoId: string | null;
}

const ROTULO_DA_SITUACAO: Record<BlocoDaTela["situacao"], string> = {
  bloqueado: "Bloqueado",
  liberado: "Liberado",
  em_andamento: "Em andamento",
  concluido: "Concluído",
};

const REDES = [
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["tiktok", "TikTok"],
  ["youtube", "YouTube"],
  ["outra", "Outra"],
] as const;
const FORMATOS = [
  ["feed", "Feed"],
  ["reels", "Reels"],
  ["story", "Story"],
  ["carrossel", "Carrossel"],
  ["video", "Vídeo"],
] as const;

type Icone = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
function iconeDe(nome: string): Icone {
  return ((Icones as unknown as Record<string, Icone>)[nome] ?? Icones.ListChecks) as Icone;
}

/** O ícone da espécie pelo nome — componente estável, declarado fora da renderização. */
function IconeDoBloco({ nome, size }: { nome: string; size: number }) {
  return createElement(iconeDe(nome), { size, "aria-hidden": true });
}

interface Rascunho {
  id: string;
  especie: string;
  titulo: string;
  descricao: string;
  cor: string;
  funcaoId: string;
  responsavelId: string;
  dia: string;
  hora: string;
  checklist: string;
  links: string;
  executor: "humano" | "ia";
  acaoIa: AcaoDaIa;
  texto: string;
  rede: string;
  formato: string;
}

function deBloco(b: BlocoDaTela): Rascunho {
  return {
    id: b.id,
    especie: b.especie,
    titulo: b.titulo,
    descricao: b.descricao ?? "",
    cor: b.cor,
    funcaoId: b.funcaoId ?? "",
    responsavelId: b.responsavelId ?? "",
    dia: b.prazo ? diaDe(b.prazo) : "",
    hora: b.prazo ? horaLocal(b.prazo) : "18:00",
    checklist: b.checklist.join("\n"),
    links: b.links.join("\n"),
    executor: b.executor,
    acaoIa: (ACOES_DA_IA as readonly string[]).includes(b.acaoIa ?? "")
      ? (b.acaoIa as AcaoDaIa)
      : "roteiro",
    texto: b.config.texto ?? "",
    rede: b.config.rede ?? "instagram",
    formato: b.config.formato ?? "feed",
  };
}

// ── O cartão do bloco (mesma casca do Fluxo: chip, título, subtítulo, alças e "+") ──

interface DadosDoNo extends Record<string, unknown> {
  b: BlocoDaTela;
  criacao: boolean;
  editavel: boolean;
  subtitulo: string;
  aoMais: (id: string) => void;
}

function estiloDoEstado(criacao: boolean, s: BlocoDaTela["situacao"]): string {
  if (criacao) return "";
  if (s === "bloqueado") return "opacity-55";
  if (s === "concluido") return "ring-2 ring-emerald-500/60";
  if (s === "em_andamento") return "ring-2 ring-amber-500/70";
  return "ring-2 ring-primary/70";
}

function NoDoBloco({ data, selected }: NodeProps<Node<DadosDoNo>>) {
  const { b, criacao, editavel, subtitulo, aoMais } = data;
  const e = especieDe(b.especie);
  const nota = b.tipo === "nota";
  const ligavel = criacao && editavel;
  return (
    <div
      data-testid="bloco-do-mapa"
      data-situacao={b.situacao}
      data-especie={b.especie}
      className={cn(
        "w-56 rounded-md border border-l-4 shadow-sm",
        nota ? "bg-amber-50 dark:bg-amber-950/40" : "bg-card",
        selected && "outline outline-2 outline-offset-1 outline-foreground",
        estiloDoEstado(criacao, b.situacao),
      )}
      style={{ borderLeftColor: b.cor }}
    >
      {!nota && <Handle type="target" position={Position.Top} isConnectable={ligavel} />}
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: b.cor }}
        >
          <IconeDoBloco nome={e.icone} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={b.titulo}>
            {b.titulo || e.rotulo}
          </p>
          <p className="line-clamp-2 text-xs break-words text-muted-foreground" title={subtitulo}>
            {subtitulo}
          </p>
        </div>
        {!criacao &&
          !nota &&
          (b.situacao === "bloqueado" ? (
            <Icones.Lock size={13} aria-hidden />
          ) : b.situacao === "concluido" ? (
            <Icones.Check size={13} aria-hidden />
          ) : null)}
      </div>
      {!nota && ligavel && (
        <div className="flex justify-center pb-1">
          <button
            type="button"
            className="nodrag flex h-5 w-5 items-center justify-center rounded-full border bg-background text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Próximo bloco depois de ${b.titulo || e.rotulo}`}
            data-testid="mais-do-bloco"
            onClick={(ev) => {
              ev.stopPropagation();
              aoMais(b.id);
            }}
          >
            +
          </button>
        </div>
      )}
      {!nota && <Handle type="source" position={Position.Bottom} isConnectable={ligavel} />}
    </div>
  );
}

const tiposDeNo = { bloco: NoDoBloco };

// ── A paleta (agrupada, como a do Fluxo; clicar acrescenta, arrastar solta onde quiser) ──

function Paleta({
  aoEscolher,
  depoisDe,
  aoCancelarDepois,
  className,
}: {
  aoEscolher: (especie: string) => void;
  depoisDe: string | null;
  aoCancelarDepois: () => void;
  className?: string;
}) {
  return (
    <aside
      className={cn("flex flex-col gap-3 overflow-y-auto border-r bg-muted/20 p-3", className)}
      data-testid="paleta-do-mapa"
    >
      {depoisDe && (
        <p className="rounded-md border border-primary/50 bg-primary/5 p-2 text-xs">
          Escolha o próximo bloco.{" "}
          <button type="button" className="underline" onClick={aoCancelarDepois}>
            Cancelar
          </button>
        </p>
      )}
      {(Object.keys(GRUPOS_DE_BLOCO) as GrupoDeBloco[]).map((g) => (
        <div key={g} className="space-y-1">
          <h3 className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {GRUPOS_DE_BLOCO[g]}
          </h3>
          {ESPECIES_DE_BLOCO.filter((e) => e.grupo === g).map((e) => {
            return (
              <button
                key={e.especie}
                type="button"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("application/x-agencia-bloco", e.especie);
                  ev.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => aoEscolher(e.especie)}
                title={e.faz}
                data-testid={`paleta-${e.especie}`}
                className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-xs hover:bg-accent/50"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: e.cor }}
                >
                  <IconeDoBloco nome={e.icone} size={12} />
                </span>
                <span className="truncate">{e.rotulo}</span>
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

// ── O desenho (React Flow) ──

function Desenho(p: {
  mapaId: string;
  blocos: BlocoDaTela[];
  ligacoes: Array<{ de_id: string; para_id: string }>;
  criacao: boolean;
  editavel: boolean;
  selecionado: string | null;
  subtitulo: (b: BlocoDaTela) => string;
  aoAbrir: (b: BlocoDaTela) => void;
  agir: (acao: () => Promise<{ ok: boolean; erro?: string }>, sucesso?: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [depoisDe, setDepoisDe] = useState<string | null>(null);

  const base = useMemo<Node<DadosDoNo>[]>(
    () =>
      p.blocos.map((b) => ({
        id: b.id,
        type: "bloco",
        position: { x: b.x, y: b.y },
        selected: p.selecionado === b.id,
        draggable: p.editavel,
        zIndex: b.tipo === "nota" ? -1 : 0,
        data: {
          b,
          criacao: p.criacao,
          editavel: p.editavel,
          subtitulo: p.subtitulo(b),
          aoMais: setDepoisDe,
        },
      })),
    [p],
  );
  const [nos, setNos, aoMudarNos] = useNodesState(base);
  // Estado derivado (padrão do React, sem efeito): quando o servidor manda blocos novos,
  // os nós se refazem — mantendo a medida que o React Flow já tomou de cada um.
  const [origem, setOrigem] = useState(base);
  if (origem !== base) {
    setOrigem(base);
    setNos(base.map((n) => ({ ...n, measured: nos.find((x) => x.id === n.id)?.measured })));
  }

  // Os primeiros blocos (de cima para baixo): a vista abre neles, legível; o resto se percorre arrastando.
  const comeco = useMemo(
    () =>
      [...p.blocos]
        .filter((b) => b.tipo !== "nota")
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .slice(0, 5)
        .map((b) => ({ id: b.id })),
    // Só na abertura: mudar o enquadramento a cada salvar faria a tela pular.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const setas = useMemo<Edge[]>(
    () =>
      p.ligacoes.map((l) => {
        const destino = p.blocos.find((b) => b.id === l.para_id);
        return {
          id: `${l.de_id}->${l.para_id}`,
          source: l.de_id,
          target: l.para_id,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          animated:
            !p.criacao &&
            (destino?.situacao === "liberado" || destino?.situacao === "em_andamento"),
        };
      }),
    [p.ligacoes, p.blocos, p.criacao],
  );

  function acrescentar(especie: string, pos?: { x: number; y: number }) {
    const pai = depoisDe ? p.blocos.find((b) => b.id === depoisDe) : null;
    const onde =
      pos ??
      (pai
        ? { x: pai.x, y: pai.y + 140 }
        : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const de = pai?.id ?? null;
    setDepoisDe(null);
    p.agir(() => adicionarBloco(p.mapaId, especie, onde.x, onde.y, de), "Bloco acrescentado.");
  }

  return (
    <div
      className="flex h-[calc(100vh-15rem)] min-h-[560px] overflow-hidden rounded-md border max-md:hidden"
      data-testid="desenho-do-mapa"
    >
      {p.criacao && p.editavel && (
        <Paleta
          className="w-60 shrink-0"
          aoEscolher={(e) => acrescentar(e)}
          depoisDe={depoisDe}
          aoCancelarDepois={() => setDepoisDe(null)}
        />
      )}
      <div
        className="relative flex-1"
        onDragOver={(e: DragEvent) => {
          if (p.criacao && p.editavel) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e: DragEvent) => {
          const especie = e.dataTransfer.getData("application/x-agencia-bloco");
          if (!especie || !p.criacao || !p.editavel) return;
          e.preventDefault();
          acrescentar(especie, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
      >
        <ReactFlow
          nodes={nos}
          edges={setas}
          nodeTypes={tiposDeNo}
          onNodesChange={aoMudarNos}
          onNodeClick={(_, n) => {
            const b = p.blocos.find((x) => x.id === n.id);
            if (b) p.aoAbrir(b);
          }}
          onNodeDragStop={(_, n) => p.agir(() => moverBloco(n.id, n.position.x, n.position.y))}
          onConnect={(c: Connection) =>
            c.source &&
            c.target &&
            p.agir(() => ligarBlocos(p.mapaId, c.source, c.target), "Seta criada.")
          }
          onEdgeClick={(_, e) => {
            if (p.criacao && p.editavel && window.confirm("Tirar esta seta?"))
              p.agir(() => desligarBlocos(p.mapaId, e.source, e.target));
          }}
          nodesConnectable={p.criacao && p.editavel}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{
            padding: 0.3,
            maxZoom: 1,
            minZoom: 0.55,
            nodes: comeco.length ? comeco : undefined,
          }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.data as DadosDoNo).b.cor} />
        </ReactFlow>
      </div>
    </div>
  );
}

// ── A tela ──

export function TelaDoMapa(p: {
  mapa: {
    id: string;
    titulo: string;
    situacao: "rascunho" | "publicado" | "arquivado";
    clienteNome: string;
  };
  blocos: BlocoDaTela[];
  ligacoes: Array<{ de_id: string; para_id: string }>;
  membros: Array<{ id: string; nome: string }>;
  funcoes: Array<{ id: string; nome: string }>;
  podeEditar: boolean;
  iaDisponivel: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null);
  const [pedidoIa, setPedidoIa] = useState("");
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [especieNoCelular, setEspecieNoCelular] = useState("tarefa");

  const criacao = p.mapa.situacao === "rascunho";
  const editavel = p.podeEditar && p.mapa.situacao !== "arquivado";
  const noCaminho = p.blocos.filter((b) => b.tipo !== "nota");
  const feitos = noCaminho.filter((b) => b.situacao === "concluido").length;
  const dependenciasDe = (id: string) =>
    p.ligacoes.filter((l) => l.para_id === id).map((l) => l.de_id);
  const tituloDe = (id: string) => p.blocos.find((b) => b.id === id)?.titulo ?? "?";
  const selecionadoBloco = p.blocos.find((b) => b.id === selecionado) ?? null;

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
    setSelecionado(b.id);
    setRascunho(deBloco(b));
  }

  const subtitulo = (b: BlocoDaTela) =>
    [
      especieDe(b.especie).rotulo,
      b.executor === "ia" && b.tipo === "tarefa" ? "IA" : null,
      p.membros.find((m) => m.id === b.responsavelId)?.nome ??
        p.funcoes.find((f) => f.id === b.funcaoId)?.nome,
      b.prazo ? formatarDataHora(b.prazo) : null,
      !criacao && b.tipo !== "nota" ? ROTULO_DA_SITUACAO[b.situacao] : null,
    ]
      .filter(Boolean)
      .join(" · ");

  function salvar() {
    if (!rascunho) return;
    const r = rascunho;
    const b = p.blocos.find((x) => x.id === r.id);
    if (!b) return;
    const tipo = especieDe(r.especie).tipo;
    startTransition(async () => {
      const res = await salvarBloco({
        id: r.id,
        mapaId: p.mapa.id,
        especie: r.especie,
        titulo: r.titulo,
        descricao: r.descricao || null,
        cor: r.cor,
        x: b.x,
        y: b.y,
        funcaoId: r.responsavelId ? null : r.funcaoId || null,
        responsavelId: r.responsavelId || null,
        prazo: r.dia ? instanteDoDia(r.dia, r.hora || "18:00").toISOString() : null,
        checklist: r.checklist
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        links: r.links
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        executor: tipo === "tarefa" ? r.executor : "humano",
        acaoIa: r.executor === "ia" ? r.acaoIa : null,
        config:
          tipo === "aviso"
            ? { texto: r.texto }
            : tipo === "publicacao"
              ? { rede: r.rede as "instagram", formato: r.formato as "feed" }
              : {},
        // As setas mudam no desenho; aqui elas vão como estão.
        dependeDe: dependenciasDe(r.id),
      });
      if (!res.ok) return setMsg({ ok: false, texto: res.erro });
      setMsg({ ok: true, texto: "Bloco salvo." });
      router.refresh();
    });
  }

  const especieDoRascunho = rascunho ? especieDe(rascunho.especie) : null;
  const tipoDoRascunho = especieDoRascunho?.tipo ?? "tarefa";

  return (
    <div
      className="space-y-4"
      data-testid="tela-do-mapa"
      data-modo={criacao ? "criacao" : "ao-vivo"}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Link
            href="/agencia/mapas"
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            ← Mapas
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{p.mapa.titulo}</h1>
          <p className="text-sm text-muted-foreground">
            {p.mapa.clienteNome} ·{" "}
            {criacao
              ? "Criação (rascunho — nada vira tarefa ainda)"
              : p.mapa.situacao === "arquivado"
                ? "Arquivado"
                : `Ao vivo · ${feitos} de ${noCaminho.length} concluídos`}
          </p>
        </div>
        {editavel && (
          <div className="flex flex-wrap gap-2">
            {criacao && (
              <Button
                type="button"
                disabled={pendente}
                onClick={() =>
                  window.confirm(
                    "Publicar o mapa? Depois disso as setas não mudam, e os blocos sem dependência começam agora.",
                  ) &&
                  agir(
                    () => publicarOMapa(p.mapa.id),
                    "Mapa publicado: os primeiros blocos já começaram.",
                  )
                }
              >
                Publicar
              </Button>
            )}
            {!criacao && (
              <Button
                type="button"
                variant="ghost"
                disabled={pendente}
                onClick={() =>
                  window.confirm("Arquivar este mapa?") &&
                  agir(() => arquivarMapa(p.mapa.id), "Mapa arquivado.")
                }
              >
                Arquivar
              </Button>
            )}
          </div>
        )}
      </div>

      {!criacao && (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={feitos}
          aria-valuemax={noCaminho.length}
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${noCaminho.length ? (feitos / noCaminho.length) * 100 : 0}%` }}
          />
        </div>
      )}
      {msg && (
        <p
          role="status"
          className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
          data-testid="mensagem-do-mapa"
        >
          {msg.texto}
        </p>
      )}

      {criacao && editavel && (
        <section className="space-y-2 rounded-md border p-3" data-testid="pedir-a-ia">
          <Label htmlFor="pedido-ia">Pedir à IA</Label>
          {!p.iaDisponivel ? (
            <p className="text-sm text-muted-foreground">
              A instalação não tem chave de IA configurada. Peça a quem administra a instalação.
            </p>
          ) : (
            <>
              <textarea
                id="pedido-ia"
                value={pedidoIa}
                onChange={(e) => setPedidoIa(e.target.value)}
                rows={2}
                placeholder="Ex.: plano de dezembro com 8 Reels: roteiros, gravação em 2 dias, edição e aprovação do cliente antes do dia 20"
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                disabled={pendente || pedidoIa.trim().length < 10}
                onClick={() => {
                  setMsg(null);
                  setProposta(null);
                  startTransition(async () => {
                    const r = await proporBlocosComIa(p.mapa.id, pedidoIa);
                    if (!r.ok) return setMsg({ ok: false, texto: r.erro });
                    setProposta(r.dados.proposta);
                  });
                }}
              >
                {pendente && !proposta ? "Pensando…" : "Propor blocos"}
              </Button>
            </>
          )}
          {proposta && (
            <div
              className="space-y-2 rounded-md bg-muted/40 p-3 text-sm"
              data-testid="proposta-da-ia"
            >
              <p>{proposta.resumo}</p>
              <ol className="list-decimal space-y-0.5 pl-5">
                {proposta.blocos.map((b) => (
                  <li key={b.chave} data-testid="bloco-proposto">
                    <strong>{b.titulo}</strong>
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {b.tipo === "marco"
                        ? "Marco"
                        : b.executor === "ia"
                          ? `IA: ${ROTULO_DA_ACAO_DA_IA[b.acao_ia ?? "roteiro"]}`
                          : "Pessoa"}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={pendente}
                  onClick={() =>
                    agir(async () => {
                      const r = await aplicarPropostaDaIa(p.mapa.id, proposta);
                      if (r.ok) {
                        setProposta(null);
                        setPedidoIa("");
                      }
                      return r;
                    }, `${proposta.blocos.length} blocos entraram no mapa.`)
                  }
                >
                  Aplicar no mapa
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pendente}
                  onClick={() => setProposta(null)}
                >
                  Descartar
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {criacao && editavel && !rascunho && (
        <p className="text-xs text-muted-foreground max-md:hidden" data-testid="dica-do-mapa">
          Escolha um bloco na paleta (ou arraste para o mapa). O + embaixo de um bloco cria o
          próximo já ligado; para ligar dois blocos, puxe da bolinha de baixo até a de cima. Clique
          num bloco para editar.
        </p>
      )}
      <div className={cn("grid gap-4", rascunho && "lg:grid-cols-[1fr_20rem]")}>
        <ReactFlowProvider>
          <Desenho
            mapaId={p.mapa.id}
            blocos={p.blocos}
            ligacoes={p.ligacoes}
            criacao={criacao}
            editavel={editavel}
            selecionado={selecionado}
            subtitulo={subtitulo}
            aoAbrir={abrir}
            agir={agir}
          />
        </ReactFlowProvider>

        {/* Lista (celular) */}
        <div className="space-y-2 md:hidden">
          {criacao && editavel && (
            <div className="flex gap-2">
              <select
                aria-label="Bloco para acrescentar"
                value={especieNoCelular}
                onChange={(e) => setEspecieNoCelular(e.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
              >
                {ESPECIES_DE_BLOCO.map((e) => (
                  <option key={e.especie} value={e.especie}>
                    {e.rotulo}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                disabled={pendente}
                onClick={() => {
                  const ultimo = p.blocos[p.blocos.length - 1];
                  agir(
                    () =>
                      adicionarBloco(
                        p.mapa.id,
                        especieNoCelular,
                        ultimo?.x ?? 0,
                        (ultimo?.y ?? -140) + 140,
                        ultimo && ultimo.tipo !== "nota" ? ultimo.id : null,
                      ),
                    "Bloco acrescentado.",
                  );
                }}
              >
                Acrescentar
              </Button>
            </div>
          )}
          <ul className="space-y-2" data-testid="lista-do-mapa">
            {p.blocos.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => abrir(b)}
                  className={cn(
                    "w-full rounded-md border bg-card p-3 text-left",
                    estiloDoEstado(criacao, b.situacao),
                  )}
                  style={{ borderLeft: `6px solid ${b.cor}` }}
                >
                  <span className="block truncate text-sm font-medium">
                    {b.titulo || especieDe(b.especie).rotulo}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{subtitulo(b)}</span>
                  {dependenciasDe(b.id).length > 0 && (
                    <span className="block text-[11px] text-muted-foreground">
                      Depois de: {dependenciasDe(b.id).map(tituloDe).join(", ")}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {p.blocos.length === 0 && (
              <li className="text-sm text-muted-foreground">Nenhum bloco ainda.</li>
            )}
          </ul>
        </div>

        {/* Painel */}
        {rascunho && especieDoRascunho && (
          <aside className="space-y-3 rounded-md border p-4" data-testid="painel-do-bloco">
            <>
              <div className="flex items-start gap-2">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: rascunho.cor }}
                >
                  <IconeDoBloco nome={especieDoRascunho.icone} size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">{especieDoRascunho.rotulo}</h2>
                  <p className="text-xs text-muted-foreground">{especieDoRascunho.faz}</p>
                </div>
                <button
                  type="button"
                  aria-label="Fechar o painel"
                  className="rounded-sm px-1 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setRascunho(null);
                    setSelecionado(null);
                  }}
                >
                  ✕
                </button>
              </div>
              {!criacao && selecionadoBloco && selecionadoBloco.tipo !== "nota" && (
                <div className="space-y-2 text-sm">
                  <p>
                    <strong>{ROTULO_DA_SITUACAO[selecionadoBloco.situacao]}</strong>
                    {selecionadoBloco.situacao === "bloqueado" &&
                      dependenciasDe(selecionadoBloco.id).length > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Espera:{" "}
                          {dependenciasDe(selecionadoBloco.id)
                            .filter(
                              (d) => p.blocos.find((x) => x.id === d)?.situacao !== "concluido",
                            )
                            .map(tituloDe)
                            .join(", ")}
                        </span>
                      )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selecionadoBloco.tarefaId && (
                      <Link
                        href={`/agencia/tarefas?abrir=${selecionadoBloco.tarefaId}`}
                        className="inline-block rounded-md border px-2 py-1 text-xs"
                      >
                        Abrir tarefa
                      </Link>
                    )}
                    {selecionadoBloco.envioId && (
                      <Link
                        href={`/agencia/envios?abrir=${selecionadoBloco.envioId}`}
                        className="inline-block rounded-md border px-2 py-1 text-xs"
                      >
                        Ver o aviso
                      </Link>
                    )}
                    {selecionadoBloco.publicacaoId && (
                      <Link
                        href={`/agencia/publicacoes?abrir=${selecionadoBloco.publicacaoId}`}
                        className="inline-block rounded-md border px-2 py-1 text-xs"
                      >
                        Ver o post
                      </Link>
                    )}
                  </div>
                  {editavel &&
                    (selecionadoBloco.tipo === "marco" ||
                      (selecionadoBloco.tipo === "aviso" && !selecionadoBloco.envioId) ||
                      (selecionadoBloco.tipo === "publicacao" && !selecionadoBloco.publicacaoId)) &&
                    selecionadoBloco.situacao !== "bloqueado" &&
                    selecionadoBloco.situacao !== "concluido" && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={pendente}
                        onClick={() =>
                          agir(() => concluirMarco(selecionadoBloco.id), "Bloco concluído.")
                        }
                      >
                        Concluir
                      </Button>
                    )}
                </div>
              )}
              <fieldset disabled={!editavel || pendente} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="bloco-titulo">
                    {tipoDoRascunho === "nota" ? "Texto da nota" : "Título"}
                  </Label>
                  <Input
                    id="bloco-titulo"
                    value={rascunho.titulo}
                    onChange={(e) => setRascunho({ ...rascunho, titulo: e.target.value })}
                  />
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
                      className={cn(
                        "h-6 w-6 rounded-full border",
                        rascunho.cor === c && "ring-2 ring-foreground ring-offset-1",
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                {tipoDoRascunho !== "nota" && (
                  <>
                    {tipoDoRascunho === "aviso" && (
                      <div className="space-y-1">
                        <Label htmlFor="bloco-texto">Texto do aviso ao cliente</Label>
                        <textarea
                          id="bloco-texto"
                          rows={4}
                          value={rascunho.texto}
                          onChange={(e) => setRascunho({ ...rascunho, texto: e.target.value })}
                          className="w-full rounded-md border bg-background p-2 text-sm"
                        />
                      </div>
                    )}
                    {tipoDoRascunho === "publicacao" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="bloco-rede">Rede</Label>
                          <select
                            id="bloco-rede"
                            value={rascunho.rede}
                            onChange={(e) => setRascunho({ ...rascunho, rede: e.target.value })}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {REDES.map(([v, r]) => (
                              <option key={v} value={v}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="bloco-formato">Formato</Label>
                          <select
                            id="bloco-formato"
                            value={rascunho.formato}
                            onChange={(e) => setRascunho({ ...rascunho, formato: e.target.value })}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {FORMATOS.map(([v, r]) => (
                              <option key={v} value={v}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                    {tipoDoRascunho === "tarefa" && (
                      <div className="space-y-1">
                        <Label htmlFor="bloco-executor">Quem executa</Label>
                        <select
                          id="bloco-executor"
                          value={rascunho.executor}
                          onChange={(e) =>
                            setRascunho({
                              ...rascunho,
                              executor: e.target.value as "humano" | "ia",
                            })
                          }
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        >
                          <option value="humano">Pessoa</option>
                          <option value="ia">IA</option>
                        </select>
                      </div>
                    )}
                    {tipoDoRascunho === "tarefa" && rascunho.executor === "ia" && (
                      <div className="space-y-1">
                        <Label htmlFor="bloco-acao-ia">O que a IA faz</Label>
                        <select
                          id="bloco-acao-ia"
                          value={rascunho.acaoIa}
                          onChange={(e) =>
                            setRascunho({ ...rascunho, acaoIa: e.target.value as AcaoDaIa })
                          }
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        >
                          {ACOES_DA_IA.map((a) => (
                            <option key={a} value={a}>
                              {ROTULO_DA_ACAO_DA_IA[a]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label htmlFor="bloco-responsavel">Responsável</Label>
                      <select
                        id="bloco-responsavel"
                        value={rascunho.responsavelId}
                        onChange={(e) =>
                          setRascunho({ ...rascunho, responsavelId: e.target.value })
                        }
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
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
                        <select
                          id="bloco-funcao"
                          value={rascunho.funcaoId}
                          onChange={(e) => setRascunho({ ...rascunho, funcaoId: e.target.value })}
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        >
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
                        <Label htmlFor="bloco-dia">
                          {tipoDoRascunho === "espera"
                            ? "Esperar até"
                            : tipoDoRascunho === "publicacao"
                              ? "Dia do post"
                              : "Prazo"}
                        </Label>
                        <Input
                          id="bloco-dia"
                          type="date"
                          value={rascunho.dia}
                          onChange={(e) => setRascunho({ ...rascunho, dia: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="bloco-hora">Hora</Label>
                        <Input
                          id="bloco-hora"
                          type="time"
                          value={rascunho.hora}
                          onChange={(e) => setRascunho({ ...rascunho, hora: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="bloco-descricao">
                        {tipoDoRascunho === "publicacao" ? "Legenda (rascunho)" : "Descrição"}
                      </Label>
                      <textarea
                        id="bloco-descricao"
                        rows={2}
                        value={rascunho.descricao}
                        onChange={(e) => setRascunho({ ...rascunho, descricao: e.target.value })}
                        className="w-full rounded-md border bg-background p-2 text-sm"
                      />
                    </div>
                    {tipoDoRascunho === "tarefa" && (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="bloco-checklist">Checklist (um por linha)</Label>
                          <textarea
                            id="bloco-checklist"
                            rows={3}
                            value={rascunho.checklist}
                            onChange={(e) =>
                              setRascunho({ ...rascunho, checklist: e.target.value })
                            }
                            className="w-full rounded-md border bg-background p-2 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="bloco-links">Links e anexos (um por linha)</Label>
                          <textarea
                            id="bloco-links"
                            rows={2}
                            value={rascunho.links}
                            onChange={(e) => setRascunho({ ...rascunho, links: e.target.value })}
                            placeholder="https://…"
                            className="w-full rounded-md border bg-background p-2 text-sm"
                          />
                        </div>
                      </>
                    )}
                  </>
                )}
              </fieldset>
              {editavel && (
                <div className="flex flex-wrap justify-between gap-2">
                  <Button
                    type="button"
                    onClick={salvar}
                    disabled={pendente || rascunho.titulo.trim().length < 1}
                  >
                    Salvar bloco
                  </Button>
                  {criacao && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      disabled={pendente}
                      onClick={() => {
                        const id = rascunho.id;
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
          </aside>
        )}
      </div>
    </div>
  );
}
