"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionLineType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { estimateNodeSize, layoutFlowGraph, LAYOUT_NODE_WIDTH } from "@/lib/followup/auto-layout";
import { semAresta, semArestasDoNo, semNo } from "@/lib/followup/excluir-do-grafo";
import {
  toReactFlow,
  fromReactFlow,
  graphsEqual,
  toFlowNode,
  type RFNode,
  type RFEdge,
  type RFNodeData,
} from "@/lib/followup/graph-mappers";
import { conditionLabel } from "@/lib/followup/edge-condition-options";
import { nextSequenceId } from "@/lib/followup/next-sequence-id";
import {
  branchIdForCondition,
  conditionForBranch,
  nodeBranches,
  type FlowEdge,
  type FlowGraph,
  type NodeType,
} from "@/lib/followup/graph-schema";
import { rotuloDoRamo } from "@/lib/followup/rotulo-do-ramo";
import { useFollowupFlow, type FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Plus, X } from "@/lib/ui/icons";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EdgeConfigPanel } from "./EdgeConfigPanel";
import { EtapasDoFluxoProvider, useEtapasDoFluxo } from "./EtapasDoFluxo";
import { NodePalette } from "./NodePalette";
import { PublishBar } from "./PublishBar";
import { NODE_VISUALS, configPadraoDaAcao } from "./nodes/nodeVisuals";
import { TriggerNode } from "./nodes/TriggerNode";
import { WaitNode } from "./nodes/WaitNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { ClassifyNode } from "./nodes/ClassifyNode";
import { MatchReplyNode } from "./nodes/MatchReplyNode";
import { RepeatNode } from "./nodes/RepeatNode";
import { ActionNode } from "./nodes/ActionNode";
import { EndNode } from "./nodes/EndNode";
import { CollectNode } from "./nodes/CollectNode";
import { InternalTaskNode } from "./nodes/InternalTaskNode";
import { MoveLeadNode } from "./nodes/MoveLeadNode";
import { EditLeadTagNode } from "./nodes/EditLeadTagNode";
import { DistributeNode } from "./nodes/DistributeNode";
import { SplitNode } from "./nodes/SplitNode";
import { SkillNode } from "./nodes/SkillNode";
import { NotaNode } from "./nodes/NotaNode";
import { AcoesDoMapaContext, type AcoesDoMapa } from "./AcoesDoMapa";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import type { NotaDoMapa } from "@/lib/followup/graph-schema";

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };
const DND_MIME = "application/x-followup-node-type";

// Defined outside the component — React Flow warns (and re-mounts nodes) if
// nodeTypes is a fresh object every render.
const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  wait: WaitNode,
  condition: ConditionNode,
  ai_classify: ClassifyNode,
  match_reply: MatchReplyNode,
  repeat: RepeatNode,
  action: ActionNode,
  // `internal_task` estava na paleta, no schema, no publish e no motor — e não
  // aqui (#1540): o React Flow caía no fallback da caixa desconhecida, sem
  // rótulo e sem formulário. Completar o nó é esta linha mais o formulário do
  // painel (`forms/InternalTaskForm`).
  internal_task: InternalTaskNode,
  // #2065 — as duas caixas novas da issue: sem estas linhas o React Flow cai
  // no fallback da caixa desconhecida (o mesmo defeito do #1540 medido ali em
  // cima), sem rótulo e sem formulário.
  move_lead: MoveLeadNode,
  edit_lead_tag: EditLeadTagNode,
  // Automações (out/2026): distribuição e divisor.
  distribute: DistributeNode,
  split: SplitNode,
  end: EndNode,
  collect: CollectNode,
  skill: SkillNode,
  // Automações: a nota do mapa. Não é tipo do grafo (mora em `settings.notas`).
  nota: NotaNode,
};

/**
 * A nota vive no MESMO estado do React Flow que os blocos (para ser arrastada,
 * selecionada e enquadrada junto), mas não é um `NodeType` do grafo. O tipo do
 * estado é o dos blocos, então a marca é convertida aqui, num lugar só, e todo
 * caminho que monta o grafo filtra por `ehNota` antes de mapear.
 */
const TIPO_NOTA = "nota" as unknown as NodeType;
const ehNota = (n: RFNode): boolean => (n.type as string) === "nota";

function notaParaNo(nota: NotaDoMapa): RFNode {
  return {
    id: nota.id,
    type: TIPO_NOTA,
    position: { x: nota.x, y: nota.y },
    // Atrás dos blocos: uma nota por cima cobria o "+" das saídas (medido no
    // teste — o clique caía no texto da nota, não no botão).
    zIndex: -1,
    data: { label: "Nota", config: { texto: nota.texto } as unknown as RFNode["data"]["config"] },
  };
}

function noParaNota(n: RFNode): NotaDoMapa {
  const texto = (n.data.config as unknown as { texto?: string }).texto ?? "";
  return { id: n.id, texto, x: n.position.x, y: n.position.y };
}

/** As configurações sem as notas — as notas vivem como nós no estado do mapa. */
function semNotas(settings: FlowGraph["settings"]): FlowGraph["settings"] {
  if (!settings) return settings;
  const { notas: _notas, ...resto } = settings;
  return resto as FlowGraph["settings"];
}

interface Props {
  flowId: string;
  initialData: FollowupFlowDetailRow;
}

function FlowCanvasInner({ flowId, initialData }: Props) {
  const t = useT();
  const { nomes } = useEtapasDoFluxo();
  const { data: flow } = useFollowupFlow(flowId, { initialData });
  // `initial` seeds React Flow state ONCE on mount — it must NOT react to
  // `flow` changing on every refetch (that would clobber in-progress edits).
  const initial = useMemo(
    () => {
      const grafo = initialData.draft_graph ?? EMPTY_GRAPH;
      const rf = toReactFlow(grafo);
      return { ...rf, nodes: [...rf.nodes, ...(grafo.settings?.notas ?? []).map(notaParaNo)] };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(initial.edges);
  const [savedGraph, setSavedGraph] = useState<FlowGraph>(initialData.draft_graph ?? EMPTY_GRAPH);
  // As configurações do GRAFO (palavras-gatilho, teto de tentativas, prazo do
  // roteiro) não vivem em nó nenhum: sem este estado, salvar o rascunho as
  // apagava — `fromReactFlow` só conhece nós e arestas.
  const [settings, setSettings] = useState<FlowGraph["settings"]>(semNotas(initialData.draft_graph?.settings));
  // `settings` começou com alguma chave? Sem isso, um fluxo sem configurações
  // ganharia `settings: {}` ao abrir e o editor acusaria "alterações não salvas".
  const tinhaSettings = useRef(initialData.draft_graph?.settings !== undefined);
  const surface = initialData.surface ?? "followup";
  // Continue after the largest persisted suffix. Starting again at 1 makes a
  // newly-created node/edge reuse an existing React Flow key and visually
  // replace a connection in older drafts.
  const nextId = useRef(nextSequenceId(initial.nodes.map((node) => node.id)));
  const nextEdgeId = useRef(nextSequenceId(initial.edges.map((edge) => edge.id)));
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const liveGraph = useMemo(() => {
    const base = fromReactFlow(
      nodes.filter((n) => !ehNota(n)),
      edges,
    );
    const notas = nodes.filter(ehNota).map(noParaNota);
    const combinadas = { ...(settings ?? {}), ...(notas.length > 0 ? { notas } : {}) };
    const vazias = Object.keys(combinadas).length === 0;
    if (vazias && !tinhaSettings.current) return base;
    return { ...base, settings: combinadas as FlowGraph["settings"] };
  }, [nodes, edges, settings]);
  const dirty = useMemo(() => !graphsEqual(liveGraph, savedGraph), [liveGraph, savedGraph]);

  const markNodeErrors = useCallback(
    (errorsByNode: Record<string, string[]>) => {
      setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, errors: errorsByNode[n.id] } })));
    },
    [setNodes],
  );
  const clearNodeErrors = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.data.errors ? { ...n, data: { ...n.data, errors: undefined } } : n)));
  }, [setNodes]);

  // Node and edge selection are mutually exclusive — opening one panel closes the other's.
  const onNodeClick = useCallback<NodeMouseHandler<RFNode>>((_, node) => {
    // A nota se edita no próprio cartão; não há painel de configuração para ela.
    if (ehNota(node)) return;
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);
  const onEdgeClick = useCallback<EdgeMouseHandler<RFEdge>>((_, edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  const updateNodeData = useCallback(
    (id: string, patch: Partial<RFNodeData>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes],
  );
  const updateEdgeCondition = useCallback(
    (id: string, condition: FlowEdge["condition"]) => {
      setEdges((eds) =>
        eds.map((e) => (e.id === id ? { ...e, data: { priority: e.data?.priority ?? 0, condition } } : e)),
      );
    },
    [setEdges],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedEdgeSource = selectedEdge ? (nodes.find((n) => n.id === selectedEdge.source) ?? null) : null;
  const selectedEdgeTarget = selectedEdge ? (nodes.find((n) => n.id === selectedEdge.target) ?? null) : null;

  // Wire label: derived at render time from `data.condition`, never persisted on the edge
  // itself — `condition` alone stays the source of truth the mapper round-trips.
  // Num nó que ramifica o texto vem do RAMO (o rótulo que o usuário leu na
  // bolinha de onde arrastou), não da condição crua: `conditionLabel` sozinho
  // mostraria o id do ramo, que não é palavra nenhuma para quem não programa.
  const edgesForRender = useMemo(
    () =>
      edges.map((e) => {
        const condition = e.data?.condition ?? { type: "always" as const };
        const source = nodes.find((n) => n.id === e.source);
        const branch = source
          ? nodeBranches(toFlowNode(source)).find(
              (b) => b.id === branchIdForCondition(toFlowNode(source), condition),
            )
          : undefined;
        return {
          ...e,
          type: "smoothstep" as const,
          label: branch ? t(rotuloDoRamo(branch, nomes)) : t(conditionLabel(condition)),
          selected: e.id === selectedEdgeId,
        };
      }),
    [edges, nodes, selectedEdgeId, t, nomes],
  );

  // Quais saídas do nó selecionado já têm aresta. Quem sabe isso é o canvas —
  // o formulário não vê o grafo, e sem esse dado ele trocaria o modo do nó
  // deixando ligações órfãs sem conseguir dizer quantas.
  const ramosLigadosDoSelecionado = useMemo(() => {
    if (!selectedNode) return [];
    const source = toFlowNode(selectedNode);
    return edges
      .filter((e) => e.source === selectedNode.id)
      .map((e) => branchIdForCondition(source, e.data?.condition ?? { type: "always" }))
      .filter((id): id is string => id !== null);
  }, [selectedNode, edges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      // A bolinha de onde o usuário arrastou É a saída escolhida: o React Flow
      // devolve o id do ramo em `sourceHandle`. Antes a aresta nascia sempre
      // `always` e o usuário tinha que ir ao painel dizer de novo, de qual regra
      // ela saía — o que, com uma bolinha só, era impossível de expressar.
      const source = nodes.find((n) => n.id === connection.source);
      const fromBranch =
        source && connection.sourceHandle
          ? conditionForBranch(toFlowNode(source), connection.sourceHandle)
          : null;
      const newEdge: RFEdge = {
        id: `edge-${nextEdgeId.current++}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        data: { priority: 0, condition: fromBranch ?? { type: "always" } },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, nodes],
  );

  // O nó de ação nasce com o padrão do gatilho do fluxo. O callback depende só
  // do `kind` (string), não do objeto `trigger_config`, que é novo a cada refetch.
  const triggerKindRaw = flow?.trigger_config?.kind;
  const triggerKind = typeof triggerKindRaw === "string" ? triggerKindRaw : undefined;

  const addNodeAt = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      const visual = NODE_VISUALS[type];
      const id = `${type}-${nextId.current++}`;
      const config = type === "action" ? configPadraoDaAcao(triggerKind) : visual.defaultConfig();
      const newNode: RFNode = {
        id,
        type,
        position,
        data: { label: t(visual.defaultLabel), config },
      };
      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes, t, triggerKind],
  );

  const onPaletteAdd = useCallback(
    (type: NodeType) => {
      const index = nodes.length;
      addNodeAt(type, { x: 80 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 150 });
    },
    [nodes.length, addNodeAt],
  );

  // ── Automações (estilo ManyChat) ────────────────────────────────────────
  // O "+" de uma saída cria o próximo bloco ao lado, já ligado a ela, e abre o
  // painel dele — o arrasto de seta deixa de ser o único jeito de montar.
  const adicionarDepois = useCallback(
    (nodeId: string, ramo: string | null, tipo: NodeType) => {
      const origem = nodes.find((n) => n.id === nodeId);
      if (!origem) return;
      const ramos = nodeBranches(toFlowNode(origem));
      const indice = ramo === null ? 0 : Math.max(0, ramos.findIndex((b) => b.id === ramo));
      const altura = origem.measured?.height ?? estimateNodeSize(toFlowNode(origem)).height;
      const position = {
        x: origem.position.x + (ramo === null ? 0 : LAYOUT_NODE_WIDTH + 60),
        y: origem.position.y + (ramo === null ? altura + 60 : indice * 140),
      };
      const visual = NODE_VISUALS[tipo];
      const id = `${tipo}-${nextId.current++}`;
      const config = tipo === "action" ? configPadraoDaAcao(triggerKind) : visual.defaultConfig();
      setNodes((nds) => nds.concat({ id, type: tipo, position, data: { label: t(visual.defaultLabel), config } }));
      const condition =
        ramo === null
          ? { type: "always" as const }
          : (conditionForBranch(toFlowNode(origem), ramo) ?? { type: "always" as const });
      setEdges((eds) =>
        addEdge(
          {
            id: `edge-${nextEdgeId.current++}`,
            source: nodeId,
            target: id,
            sourceHandle: ramo ?? null,
            targetHandle: null,
            data: { priority: 0, condition },
          },
          eds,
        ),
      );
      setSelectedNodeId(id);
      setSelectedEdgeId(null);
    },
    [nodes, setNodes, setEdges, t, triggerKind],
  );

  // Duplicar copia o bloco com a configuração, sem as setas — ligar a cópia é
  // decisão de quem monta, e copiar setas criaria saídas duplicadas no original.
  const duplicarBloco = useCallback(
    (nodeId: string) => {
      const origem = nodes.find((n) => n.id === nodeId);
      if (!origem || ehNota(origem) || origem.type === "trigger") return;
      const id = `${origem.type}-${nextId.current++}`;
      const copia: RFNode = {
        id,
        type: origem.type,
        position: { x: origem.position.x + 40, y: origem.position.y + 40 },
        data: {
          label: `${origem.data.label} (${t("cópia")})`.slice(0, 60),
          config: structuredClone(origem.data.config),
        },
      };
      setNodes((nds) => nds.concat(copia));
      setSelectedNodeId(id);
    },
    [nodes, setNodes, t],
  );

  const adicionarNota = useCallback(() => {
    const id = `nota-${nextId.current++}`;
    const centro = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    setNodes((nds) => nds.concat(notaParaNo({ id, texto: "", x: centro.x, y: centro.y })));
  }, [setNodes, screenToFlowPosition]);

  const editarNota = useCallback(
    (id: string, texto: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, config: { texto } as unknown as RFNode["data"]["config"] } } : n,
        ),
      );
    },
    [setNodes],
  );

  const removerNota = useCallback((id: string) => setNodes((nds) => nds.filter((n) => n.id !== id)), [setNodes]);

  const acoesDoMapa = useMemo<AcoesDoMapa>(
    () => ({
      adicionarDepois,
      tipos: NOS_DA_SUPERFICIE[surface].map((tipo) => NODE_VISUALS[tipo]),
      editarNota,
      removerNota,
    }),
    [adicionarDepois, surface, editarNota, removerNota],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => semNo(nds, id));
      setEdges((eds) => semArestasDoNo(eds, id));
      setSelectedNodeId((cur) => (cur === id ? null : cur));
    },
    [setNodes, setEdges],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((eds) => semAresta(eds, id));
      setSelectedEdgeId((cur) => (cur === id ? null : cur));
    },
    [setEdges],
  );

  const onDeleteSelection = useCallback(() => {
    if (selectedNodeId) deleteNode(selectedNodeId);
    else if (selectedEdgeId) deleteEdge(selectedEdgeId);
  }, [selectedNodeId, selectedEdgeId, deleteNode, deleteEdge]);

  const onAutoFit = useCallback(() => {
    if (nodes.length === 0) return;
    const sizes = new Map<string, { width: number; height: number }>();
    for (const n of nodes) {
      if (ehNota(n)) continue;
      sizes.set(n.id, {
        width: n.measured?.width ?? LAYOUT_NODE_WIDTH,
        height: n.measured?.height ?? estimateNodeSize(toFlowNode(n)).height,
      });
    }
    const laid = layoutFlowGraph(liveGraph, sizes, nomes);
    const pos = new Map(laid.nodes.map((n) => [n.id, n.position]));
    setNodes((nds) =>
      nds.map((n) => {
        const p = pos.get(n.id);
        return p ? { ...n, position: p } : n;
      }),
    );
    window.setTimeout(() => {
      void fitView({ padding: 0.2, duration: 200 });
    }, 0);
  }, [nodes, liveGraph, setNodes, fitView]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData(DND_MIME) as NodeType | "";
      if (!type) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNodeAt(type, position);
    },
    [screenToFlowPosition, addNodeAt],
  );

  return (
    <div className="flex h-full min-h-[600px] w-full flex-col">
      {flow && (
        <PublishBar
          flowId={flowId}
          flow={flow}
          graph={liveGraph}
          dirty={dirty}
          selection={selectedNode ? "node" : selectedEdge ? "edge" : null}
          onDeleteSelection={onDeleteSelection}
          onSaved={setSavedGraph}
          onPublishErrors={markNodeErrors}
          onPublishSuccess={clearNodeErrors}
          onAutoFit={onAutoFit}
          canAutoFit={nodes.length > 0}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAdd={onPaletteAdd} surface={surface} />
        {/* Abaixo de `lg` a paleta fixa de 224px não cabe do lado do canvas —
            vira um drawer, disparado por este botão flutuante. */}
        <Sheet open={paletteOpen} onOpenChange={setPaletteOpen}>
          <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0 lg:hidden">
            <SheetTitle className="sr-only">{t("Adicionar nó")}</SheetTitle>
            <NodePalette
              variant="mobile"
              surface={surface}
              onAdd={(type) => {
                onPaletteAdd(type);
                setPaletteOpen(false);
              }}
            />
          </SheetContent>
        </Sheet>

        <div className="relative h-full flex-1" data-testid="flow-canvas" onDragOver={onDragOver} onDrop={onDrop}>
          <AcoesDoMapaContext.Provider value={acoesDoMapa}>
          <ReactFlow
            nodes={nodes}
            edges={edgesForRender}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            defaultEdgeOptions={{ type: "smoothstep" }}
            connectionLineType={ConnectionLineType.SmoothStep}
            // Enquadrar só o que já existia ao abrir. Num fluxo vazio o XYFlow
            // guarda o enquadramento para quando o PRIMEIRO nó for medido — e
            // enquadrar um nó só é ampliá-lo ao zoom máximo (2x): quem acabou de
            // criar o fluxo clica em "Gatilho" e a tela salta para 200%, com os
            // nós seguintes nascendo fora da vista (medido no trace do e2e
            // followup-cartoes: scale 1 → 2 logo após o primeiro clique).
            fitView={initial.nodes.length > 0}
          >
            <Background />
            <Controls />
            {/* Minimapa, como no ManyChat: em fluxo grande, mostra onde você está. */}
            <MiniMap pannable zoomable className="hidden lg:block" />
          </ReactFlow>
          </AcoesDoMapaContext.Provider>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute right-4 top-4 z-10 shadow-md"
            onClick={adicionarNota}
            data-testid="adicionar-nota"
          >
            <Plus size={14} aria-hidden /> {t("Nota")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-4 left-4 z-10 shadow-md lg:hidden"
            onClick={() => setPaletteOpen(true)}
          >
            <Plus size={14} aria-hidden /> {t("Adicionar nó")}
          </Button>
        </div>

        {/*
          Docked panel em telas grandes (`lg:`) — NÃO é overlay ali: o canvas
          continua clicável, então trocar de nó/aresta selecionado funciona com
          o painel aberto. Abaixo de `lg` os 384px (`w-96`) sozinhos já passavam
          da largura de QUALQUER celular, e como o pai é `overflow-hidden`, o
          painel não ganhava scroll — ficava certo, cortado, inacessível. Vira
          bottom sheet (`fixed`, ancorado embaixo, com teto de altura e X pra
          fechar) só nesse intervalo de tela.
        */}
        {selectedNode && (
          <aside
            className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col overflow-hidden rounded-t-lg border-t border-border bg-surface shadow-lg lg:static lg:z-auto lg:h-full lg:w-96 lg:max-h-none lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
            data-testid="node-config-sheet"
          >
            {/* Barra própria pro X, não sobreposta ao conteúdo — um botão
                flutuante por cima do cabeçalho do painel colidiria com rótulo
                comprido (texto sobre texto). */}
            <div className="flex shrink-0 justify-end p-2 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelectedNodeId(null)}
                aria-label={t("Fechar")}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-0 lg:pt-4">
              <NodeConfigPanel
                key={selectedNode.id}
                node={selectedNode}
                onChange={(patch) => updateNodeData(selectedNode.id, patch)}
                onDelete={() => deleteNode(selectedNode.id)}
                onDuplicate={() => duplicarBloco(selectedNode.id)}
                ramosLigados={ramosLigadosDoSelecionado}
                surface={surface}
                flowId={flowId}
                settings={settings}
                onSettingsChange={setSettings}
              />
            </div>
          </aside>
        )}

        {selectedEdge && (
          <aside
            className="fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col overflow-hidden rounded-t-lg border-t border-border bg-surface shadow-lg lg:static lg:z-auto lg:h-full lg:w-96 lg:max-h-none lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
            data-testid="edge-config-sheet"
          >
            <div className="flex shrink-0 justify-end p-2 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelectedEdgeId(null)}
                aria-label={t("Fechar")}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-0 lg:pt-4">
              <EdgeConfigPanel
                key={selectedEdge.id}
                sourceNode={selectedEdgeSource ? toFlowNode(selectedEdgeSource) : undefined}
                targetNode={selectedEdgeTarget ? toFlowNode(selectedEdgeTarget) : undefined}
                condition={selectedEdge.data?.condition ?? { type: "always" }}
                onChange={(condition) => updateEdgeCondition(selectedEdge.id, condition)}
                onDelete={() => deleteEdge(selectedEdge.id)}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <EtapasDoFluxoProvider>
        <FlowCanvasInner {...props} />
      </EtapasDoFluxoProvider>
    </ReactFlowProvider>
  );
}
