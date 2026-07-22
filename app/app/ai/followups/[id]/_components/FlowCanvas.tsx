"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
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
import type { FlowEdge, FlowGraph, NodeType } from "@/lib/followup/graph-schema";
import { useFollowupFlow, type FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EdgeConfigPanel } from "./EdgeConfigPanel";
import { NodePalette } from "./NodePalette";
import { PublishBar } from "./PublishBar";
import { NODE_VISUALS } from "./nodes/nodeVisuals";
import { TriggerNode } from "./nodes/TriggerNode";
import { WaitNode } from "./nodes/WaitNode";
import { ConditionNode } from "./nodes/ConditionNode";
import { ClassifyNode } from "./nodes/ClassifyNode";
import { ActionNode } from "./nodes/ActionNode";
import { EndNode } from "./nodes/EndNode";

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };
const DND_MIME = "application/x-followup-node-type";

// Defined outside the component — React Flow warns (and re-mounts nodes) if
// nodeTypes is a fresh object every render.
const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  wait: WaitNode,
  condition: ConditionNode,
  ai_classify: ClassifyNode,
  action: ActionNode,
  end: EndNode,
};

interface Props {
  flowId: string;
  initialData: FollowupFlowDetailRow;
}

function FlowCanvasInner({ flowId, initialData }: Props) {
  const { data: flow } = useFollowupFlow(flowId, { initialData });
  // `initial` seeds React Flow state ONCE on mount — it must NOT react to
  // `flow` changing on every refetch (that would clobber in-progress edits).
  const initial = useMemo(
    () => toReactFlow(initialData.draft_graph ?? EMPTY_GRAPH),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(initial.edges);
  const [savedGraph, setSavedGraph] = useState<FlowGraph>(initialData.draft_graph ?? EMPTY_GRAPH);
  const nextId = useRef(1);
  const nextEdgeId = useRef(1);
  const { screenToFlowPosition } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const liveGraph = useMemo(() => fromReactFlow(nodes, edges), [nodes, edges]);
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
  const edgesForRender = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        label: conditionLabel(e.data?.condition ?? { type: "always" }),
        selected: e.id === selectedEdgeId,
      })),
    [edges, selectedEdgeId],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: RFEdge = {
        id: `edge-${nextEdgeId.current++}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        data: { priority: 0, condition: { type: "always" } },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges],
  );

  const addNodeAt = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      const visual = NODE_VISUALS[type];
      const id = `${type}-${nextId.current++}`;
      const newNode: RFNode = {
        id,
        type,
        position,
        data: { label: visual.defaultLabel, config: visual.defaultConfig() },
      };
      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes],
  );

  const onPaletteAdd = useCallback(
    (type: NodeType) => {
      const index = nodes.length;
      addNodeAt(type, { x: 80 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 150 });
    },
    [nodes.length, addNodeAt],
  );

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
          onSaved={setSavedGraph}
          onPublishErrors={markNodeErrors}
          onPublishSuccess={clearNodeErrors}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAdd={onPaletteAdd} />
        <div className="relative h-full flex-1" data-testid="flow-canvas" onDragOver={onDragOver} onDrop={onDrop}>
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
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {selectedNode && (
          // Docked panel, NOT a modal overlay — the canvas stays fully clickable
          // so switching node selection (or dragging edges) works while it's open.
          <aside
            className="h-full w-96 shrink-0 overflow-y-auto border-l border-border bg-surface p-4"
            data-testid="node-config-sheet"
          >
            <NodeConfigPanel
              key={selectedNode.id}
              node={selectedNode}
              onChange={(patch) => updateNodeData(selectedNode.id, patch)}
            />
          </aside>
        )}

        {selectedEdge && (
          <aside
            className="h-full w-96 shrink-0 overflow-y-auto border-l border-border bg-surface p-4"
            data-testid="edge-config-sheet"
          >
            <EdgeConfigPanel
              key={selectedEdge.id}
              sourceNode={selectedEdgeSource ? toFlowNode(selectedEdgeSource) : undefined}
              targetNode={selectedEdgeTarget ? toFlowNode(selectedEdgeTarget) : undefined}
              condition={selectedEdge.data?.condition ?? { type: "always" }}
              onChange={(condition) => updateEdgeCondition(selectedEdge.id, condition)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
