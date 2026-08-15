<script setup lang="ts">
import { computed } from 'vue';

export interface EpistemicGraphNode {
  entity_id: string;
  kind: string;
  title?: string | null;
}

export interface EpistemicGraphEdge {
  relation_id: string;
  relation_type: string;
  source_id: string;
  target_id: string;
}

const props = defineProps<{
  nodes: readonly EpistemicGraphNode[];
  edges: readonly EpistemicGraphEdge[];
}>();
const emit = defineEmits<{ select: [node: EpistemicGraphNode | null] }>();

const colors: Record<string, string> = {
  problem: '#f59e0b',
  conjecture: '#8b5cf6',
  claim: '#3b82f6',
  criticism: '#ef4444',
  test: '#10b981',
  source: '#64748b',
};

const positionedNodes = computed(() => {
  const count = Math.max(props.nodes.length, 1);
  return props.nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const ring = 34 + (index % 5) * 7;
    return {
      ...node,
      x: 50 + Math.cos(angle) * ring,
      y: 50 + Math.sin(angle) * ring,
      radius: node.kind === 'problem' ? 1.8 : 1.25,
      color: colors[node.kind] ?? '#94a3b8',
    };
  });
});

const nodeById = computed(() => new Map(positionedNodes.value.map((node) => [node.entity_id, node])));
const positionedEdges = computed(() => props.edges.flatMap((edge) => {
  const source = nodeById.value.get(edge.source_id);
  const target = nodeById.value.get(edge.target_id);
  return source && target ? [{ ...edge, source, target }] : [];
}));

function select(node: EpistemicGraphNode): void {
  emit('select', node);
}
</script>

<template>
  <div class="graph-canvas">
    <svg
      v-if="nodes.length > 0"
      viewBox="0 0 100 100"
      role="img"
      aria-label="Interactive epistemic graph visualization"
      @click.self="emit('select', null)"
    >
      <defs>
        <marker id="epistemic-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <g class="edges">
        <line
          v-for="edge in positionedEdges"
          :key="edge.relation_id"
          :x1="edge.source.x"
          :y1="edge.source.y"
          :x2="edge.target.x"
          :y2="edge.target.y"
          marker-end="url(#epistemic-arrow)"
        >
          <title>{{ edge.relation_type }}</title>
        </line>
      </g>
      <g
        v-for="node in positionedNodes"
        :key="node.entity_id"
        class="node"
        role="button"
        tabindex="0"
        :aria-label="`${node.kind}: ${node.title || node.entity_id}`"
        :transform="`translate(${node.x} ${node.y})`"
        @click.stop="select(node)"
        @keydown.enter.prevent="select(node)"
        @keydown.space.prevent="select(node)"
      >
        <circle :r="node.radius" :fill="node.color" />
        <text v-if="nodes.length <= 80" y="3.5">{{ node.title || node.entity_id }}</text>
      </g>
    </svg>
    <p v-else class="empty">No admitted graph entities.</p>
  </div>
</template>

<style scoped>
.graph-canvas { position:relative; min-height:560px; overflow:hidden; border-radius:var(--radius); background:var(--surface-muted); }
svg { display:block; width:100%; height:560px; }
.edges line { stroke:#64748b; stroke-width:.22; opacity:.58; vector-effect:non-scaling-stroke; }
.edges marker path { fill:#64748b; }
.node { cursor:pointer; outline:none; }
.node circle { stroke:var(--surface); stroke-width:.35; transition:stroke-width .12s,filter .12s; }
.node:hover circle,.node:focus circle { stroke:var(--text); stroke-width:.7; filter:brightness(1.15); }
.node text { fill:var(--text); font:1.6px var(--font-sans); text-anchor:middle; pointer-events:none; paint-order:stroke; stroke:var(--surface-muted); stroke-width:.45px; }
.empty { position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); pointer-events:none; }
</style>
