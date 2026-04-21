import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { FileText, Tag, Network, Layers, Search, Filter, X, StickyNote } from "lucide-react";
import { api } from "@/lib/api";
import type { GraphNodeDTO, GraphSnapshot } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { cn, truncate } from "@/lib/utils";

const elk = new ELK();

const EDGE_STYLES: Record<string, { stroke: string; width: number; dashed: boolean; label: string }> = {
  MENTIONS: { stroke: "#f59e0b", width: 1.2, dashed: false, label: "mentions" },
  ABOUT: { stroke: "#10b981", width: 1.4, dashed: false, label: "about" },
  CONTAINS: { stroke: "#cbd5e1", width: 1, dashed: false, label: "contains" },
  IN_DOMAIN: { stroke: "#8b5cf6", width: 1.2, dashed: false, label: "in domain" },
  TAGGED: { stroke: "#94a3b8", width: 1, dashed: false, label: "tagged" },
  RELATED: { stroke: "#6366f1", width: 1.8, dashed: false, label: "related" },
  PART_OF: { stroke: "#0ea5e9", width: 1.6, dashed: true, label: "part of" },
  REFERENCES_DOC: { stroke: "#e11d48", width: 1.8, dashed: false, label: "references" },
  SIMILAR_TO: { stroke: "#d946ef", width: 1.4, dashed: true, label: "similar" },
  DERIVED_FROM_DOC: { stroke: "#f97316", width: 1.2, dashed: true, label: "derived" },
};

const NODE_COLORS: Record<GraphNodeDTO["type"], string> = {
  Document: "#6366f1",
  Entity: "#f59e0b",
  Topic: "#10b981",
  Domain: "#8b5cf6",
  Keyword: "#64748b",
  Chunk: "#94a3b8",
  AgentNote: "#ec4899",
};

const NODE_ICON: Record<GraphNodeDTO["type"], React.ReactNode> = {
  Document: <FileText className="h-3.5 w-3.5" />,
  Entity: <Tag className="h-3.5 w-3.5" />,
  Topic: <Network className="h-3.5 w-3.5" />,
  Domain: <Layers className="h-3.5 w-3.5" />,
  Keyword: <Tag className="h-3.5 w-3.5" />,
  Chunk: <FileText className="h-3.5 w-3.5" />,
  AgentNote: <StickyNote className="h-3.5 w-3.5" />,
};

type GNode = Node<{ label: string; type: GraphNodeDTO["type"]; properties: Record<string, unknown> }>;

function CustomNode({ data, selected }: NodeProps<GNode>) {
  const color = NODE_COLORS[data.type];
  return (
    <div
      className={cn(
        "rounded-xl bg-white border shadow-sm px-3 py-2 min-w-[120px] max-w-[220px] transition-all",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border/70",
      )}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {NODE_ICON[data.type]}
        {data.type}
      </div>
      <div className="text-[13px] font-semibold leading-tight mt-0.5 line-clamp-2">
        {truncate(data.label, 64)}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { ragNode: CustomNode };

async function layoutGraph(snapshot: GraphSnapshot): Promise<{ nodes: GNode[]; edges: Edge[] }> {
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    },
    children: snapshot.nodes.map((n) => ({ id: n.id, width: 180, height: 58 })),
    edges: snapshot.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const result = await elk.layout(elkGraph);
  const posById = new Map<string, { x: number; y: number }>();
  for (const c of result.children ?? []) posById.set(c.id!, { x: c.x ?? 0, y: c.y ?? 0 });

  const nodes: GNode[] = snapshot.nodes.map((n) => ({
    id: n.id,
    type: "ragNode",
    data: { label: n.label, type: n.type, properties: n.properties },
    position: posById.get(n.id) ?? { x: 0, y: 0 },
  }));

  const edges: Edge[] = snapshot.edges.map((e) => {
    const style = EDGE_STYLES[e.label] ?? { stroke: "#cbd5e1", width: 1.2, dashed: false, label: e.label };
    // For RELATED edges, prefer the typed predicate over the generic label so
    // the graph actually reads like a knowledge graph ("works_at" vs "related").
    const predicate = e.label === "RELATED" && typeof e.properties?.predicate === "string"
      ? String(e.properties.predicate)
      : null;
    const renderedLabel = predicate ?? style.label;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: renderedLabel,
      labelStyle: { fontSize: 10, fill: "#64748b" },
      style: {
        stroke: style.stroke,
        strokeWidth: style.width,
        strokeDasharray: style.dashed ? "4 4" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
    };
  });

  return { nodes, edges };
}

export function GraphBrowser({ universeId }: { universeId: string }) {
  const { t } = useTranslation();
  const { data: snapshot } = useQuery({
    queryKey: ["graph", "overview", universeId],
    queryFn: () => api.graph.overview(universeId),
  });

  const [visibleTypes, setVisibleTypes] = useState<Set<GraphNodeDTO["type"]>>(
    new Set(["Document", "Entity", "Topic", "Domain"]),
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<GNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);

  const filtered = useMemo(() => {
    if (!snapshot) return null;
    const needle = searchTerm.trim().toLowerCase();
    const keep = new Set(
      snapshot.nodes
        .filter((n) => visibleTypes.has(n.type) && (!needle || n.label.toLowerCase().includes(needle)))
        .map((n) => n.id),
    );
    return {
      nodes: snapshot.nodes.filter((n) => keep.has(n.id)),
      edges: snapshot.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    } as GraphSnapshot;
  }, [snapshot, visibleTypes, searchTerm]);

  useEffect(() => {
    let cancel = false;
    if (!filtered) return;
    void (async () => {
      const laid = await layoutGraph(filtered);
      if (cancel) return;
      setNodes(laid.nodes);
      setEdges(laid.edges);
    })();
    return () => {
      cancel = true;
    };
  }, [filtered, setNodes, setEdges]);

  const handleSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: Node[] }) => {
      setSelectedNode((selected[0] as GNode) ?? null);
    },
    [],
  );

  const expandNeighborhood = useCallback(
    async (nodeId: string) => {
      const neighborhood = await api.graph.neighborhood(universeId, nodeId, 1);
      const merged: GraphSnapshot = {
        nodes: [
          ...(snapshot?.nodes ?? []),
          ...neighborhood.nodes.filter((n) => !(snapshot?.nodes ?? []).some((x) => x.id === n.id)),
        ],
        edges: [
          ...(snapshot?.edges ?? []),
          ...neighborhood.edges.filter((e) => !(snapshot?.edges ?? []).some((x) => x.id === e.id)),
        ],
      };
      const laid = await layoutGraph(merged);
      setNodes(laid.nodes);
      setEdges(laid.edges);
    },
    [snapshot, universeId, setNodes, setEdges],
  );

  if (!snapshot || snapshot.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground max-w-sm">
          <Network className="h-10 w-10 mx-auto mb-3 opacity-60" />
          <div className="text-base font-medium text-foreground">{t("graph.empty")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <aside className="w-[260px] flex-shrink-0 border-r border-border/60 bg-white/40 p-3 space-y-3 overflow-y-auto">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5" /> {t("graph.search")}
          </div>
          <Input
            placeholder={t("graph.search") as string}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5" /> {t("graph.filters")}
          </div>
          <div className="space-y-1">
            {(Object.keys(NODE_COLORS) as GraphNodeDTO["type"][]).map((type) => {
              const active = visibleTypes.has(type);
              const count = snapshot.nodes.filter((n) => n.type === type).length;
              return (
                <button
                  key={type}
                  onClick={() =>
                    setVisibleTypes((prev) => {
                      const next = new Set(prev);
                      if (active) next.delete(type);
                      else next.add(type);
                      return next;
                    })
                  }
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors",
                    active ? "bg-primary/10 text-primary" : "hover:bg-secondary text-muted-foreground",
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: NODE_COLORS[type] }} />
                  <span className="flex-1 text-left">{t(`graph.types.${type}`)}</span>
                  <Badge variant="secondary">{count}</Badge>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onSelectionChange={handleSelectionChange}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e2e8f0" gap={16} />
          <MiniMap
            nodeStrokeColor={(n) => NODE_COLORS[(n.data as { type: GraphNodeDTO["type"] })?.type ?? "Document"]}
            nodeColor={(n) => NODE_COLORS[(n.data as { type: GraphNodeDTO["type"] })?.type ?? "Document"]}
            maskColor="rgba(241, 245, 249, 0.6)"
            pannable
            zoomable
          />
          <Controls showInteractive={false} />
        </ReactFlow>

        {selectedNode && (
          <div className="absolute top-4 right-4 w-[320px] card-elevated p-4 max-h-[80%] overflow-y-auto">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-[11px] text-muted-foreground font-medium">{selectedNode.data.type}</div>
                <div className="text-sm font-semibold">{selectedNode.data.label}</div>
              </div>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedNode(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <Button size="sm" variant="outline" className="w-full" onClick={() => expandNeighborhood(selectedNode.id)}>
              {t("graph.expand")}
            </Button>
            <NodeAliases properties={selectedNode.data.properties} />
            <NodeCentrality properties={selectedNode.data.properties} />
            {Object.keys(selectedNode.data.properties || {}).length > 0 && (
              <div className="mt-3 space-y-1 text-xs">
                {Object.entries(selectedNode.data.properties)
                  .filter(([k]) => k !== "aliases" && k !== "centrality")
                  .slice(0, 10)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-muted-foreground min-w-[80px]">{k}</span>
                      <span className="truncate">{String(v)}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NodeAliases({ properties }: { properties: Record<string, unknown> }) {
  const aliases = Array.isArray(properties.aliases) ? (properties.aliases as string[]) : [];
  if (aliases.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Aliases</div>
      <div className="flex flex-wrap gap-1">
        {aliases.map((a) => (
          <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>
        ))}
      </div>
    </div>
  );
}

function NodeCentrality({ properties }: { properties: Record<string, unknown> }) {
  const raw = properties.centrality;
  if (typeof raw !== "number") return null;
  const pct = Math.max(0, Math.min(1, raw));
  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Centrality</div>
      <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
        <div className="h-full bg-indigo-500" style={{ width: `${(pct * 100).toFixed(0)}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{(pct * 100).toFixed(1)}%</div>
    </div>
  );
}
