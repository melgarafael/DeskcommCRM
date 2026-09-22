"use client";
import { useMemo } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type OnSelectionChangeFunc,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { cn } from "@/lib/utils";
import type { NexusGraph, NexusGraphNode, NexusNodeKind } from "@/lib/nexus/graph";

/** Cor funcional por tipo de nó — ponto discreto, nunca gradiente. */
const COR_POR_TIPO: Record<NexusNodeKind, string> = {
  cliente: "var(--color-sky)",
  regiao: "var(--color-mint)",
  situacao: "var(--color-amber)",
  risco: "var(--color-ember)",
  insight: "var(--color-iris)",
  conhecimento: "var(--color-lavender)",
  aprendizado: "var(--color-magenta)",
  metrica: "var(--color-text-subtle)",
};

const ORDEM_COLUNAS: NexusNodeKind[] = [
  "situacao",
  "cliente",
  "regiao",
  "risco",
  "insight",
  "conhecimento",
  "aprendizado",
  "metrica",
];

const LARGURA_COLUNA = 250;
const ALTURA_LINHA = 92;

type RFData = { ref: NexusGraphNode; cor: string };

function NoNexus({ data, selected }: { data: RFData; selected?: boolean }) {
  const n = data.ref;
  const t = useT();
  return (
    <div
      className={cn(
        "nexus-transition w-[210px] rounded-lg border bg-surface p-2.5 text-left shadow-xs",
        selected ? "border-accent shadow-md" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: data.cor }}
        />
        <p className="truncate text-xs font-semibold text-text">{n.label}</p>
      </div>
      {n.detail ? (
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {n.detail}
        </p>
      ) : null}
      {n.inferred ? (
        <p className="mt-1 text-[10px] font-medium tracking-wider text-accent-700 uppercase">
          {t("Derivado · ver fonte")}
        </p>
      ) : null}
    </div>
  );
}

const TIPOS_DE_NO = { nexus: NoNexus };

/**
 * Canvas do grafo de inteligência. Seleção (clique/shift) sobe para o painel
 * de contexto via `onSelect`. Carregado com `ssr: false` pela página.
 */
export function NexusGraphCanvas({
  graph,
  selectedIds,
  onSelect,
}: {
  graph: NexusGraph;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
}) {
  const selecionados = useMemo(() => new Set(selectedIds), [selectedIds]);
  const nos: Node<RFData>[] = useMemo(() => {
    const contadores = new Map<NexusNodeKind, number>();
    return graph.nodes.map((n) => {
      const coluna = ORDEM_COLUNAS.indexOf(n.kind);
      const linha = contadores.get(n.kind) ?? 0;
      contadores.set(n.kind, linha + 1);
      return {
        id: n.id,
        type: "nexus",
        position: { x: coluna * LARGURA_COLUNA, y: linha * ALTURA_LINHA },
        data: { ref: n, cor: COR_POR_TIPO[n.kind] },
        selected: selecionados.has(n.id),
      };
    });
  }, [graph, selecionados]);

  const arestas: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: false,
        style: e.inferred ? { strokeDasharray: "5 4" } : undefined,
      })),
    [graph],
  );

  const aoSelecionar: OnSelectionChangeFunc = ({ nodes }) => {
    onSelect(nodes.map((n) => n.id));
  };

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-lg border border-border bg-bg">
      <ReactFlow
        nodes={nos}
        edges={arestas}
        nodeTypes={TIPOS_DE_NO}
        onSelectionChange={aoSelecionar}
        multiSelectionKeyCode="Shift"
        fitView
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
        colorMode="light"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
