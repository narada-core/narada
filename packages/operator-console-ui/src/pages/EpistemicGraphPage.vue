<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Button } from '@narada-core/ui-vue';
import type { OperatorEpistemicGraphCommand, OperatorEpistemicGraphResponse } from '@narada-core/operator-console-contract';
import OperatorConsoleShell from '../components/OperatorConsoleShell.vue';
import EpistemicGraphCanvas, { type EpistemicGraphEdge, type EpistemicGraphNode } from '../epistemic-graph/EpistemicGraphCanvas.vue';
import { createEpistemicGraphTransport } from '../epistemic-graph/transport';

const props = defineProps<{ siteId: string }>();
const transport = computed(() => createEpistemicGraphTransport(props.siteId));
const loading = ref(false);
const error = ref<string | null>(null);
const response = ref<OperatorEpistemicGraphResponse | null>(null);
const command = ref<OperatorEpistemicGraphCommand>('query');
const argumentsText = ref('{}');
const ledgerHead = ref<string | null>(null);
const nodes = ref<EpistemicGraphNode[]>([]);
const edges = ref<EpistemicGraphEdge[]>([]);
const selected = ref<EpistemicGraphNode | null>(null);

const commands: Array<{ value: OperatorEpistemicGraphCommand; label: string }> = [
  ['status', 'Status'], ['query', 'Query entities and records'], ['query-batch', 'Batch query'],
  ['neighborhood', 'Neighborhood'], ['source-inspect', 'Inspect sources'], ['capture-sources', 'Capture sources'],
  ['proposal-submit', 'Submit proposal'], ['proposal-read', 'Read proposal'], ['proposal-resubmit', 'Resubmit proposal'],
  ['proposal-review', 'Review proposal'], ['proposal-admit', 'Admit proposal'], ['proposal-reject', 'Reject proposal'],
  ['submit-review-admit', 'Submit, review, and admit'], ['export', 'Export graph'],
].map(([value, label]) => ({ value: value as OperatorEpistemicGraphCommand, label }));

function parsedArguments(): Record<string, unknown> {
  const value = JSON.parse(argumentsText.value) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be a JSON object.');
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function loadGraph(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    let entityOffset: number | null = 0;
    let relationOffset: number | null = 0;
    // The first page establishes a fresh coherent snapshot. Subsequent pages
    // are pinned to that returned head so a concurrent mutation is refused
    // instead of producing a mixed projection.
    let expectedHead: string | null | undefined;
    const nextNodes: EpistemicGraphNode[] = [];
    const nextEdges: EpistemicGraphEdge[] = [];
    while (entityOffset !== null || relationOffset !== null) {
      const result = await transport.value.call('graph-snapshot', {
        entity_offset: entityOffset ?? nextNodes.length,
        relation_offset: relationOffset ?? nextEdges.length,
        limit: 1000,
      }, expectedHead);
      expectedHead = result.ledger_head;
      const snapshot = record(result.result);
      if (!snapshot) throw new Error('epistemic_graph_snapshot_invalid');
      for (const item of Array.isArray(snapshot.entities) ? snapshot.entities : []) {
        const entity = record(item);
        if (entity && typeof entity.entity_id === 'string' && typeof entity.kind === 'string') {
          nextNodes.push({ entity_id: entity.entity_id, kind: entity.kind, title: typeof entity.title === 'string' ? entity.title : null });
        }
      }
      for (const item of Array.isArray(snapshot.relations) ? snapshot.relations : []) {
        const edge = record(item);
        if (edge && typeof edge.relation_id === 'string' && typeof edge.relation_type === 'string'
          && typeof edge.source_id === 'string' && typeof edge.target_id === 'string') {
          nextEdges.push(edge as unknown as EpistemicGraphEdge);
        }
      }
      entityOffset = typeof snapshot.next_entity_offset === 'number' ? snapshot.next_entity_offset : null;
      relationOffset = typeof snapshot.next_relation_offset === 'number' ? snapshot.next_relation_offset : null;
    }
    ledgerHead.value = expectedHead ?? null;
    nodes.value = nextNodes;
    edges.value = nextEdges;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function execute(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await transport.value.call(command.value, parsedArguments(), ledgerHead.value);
    response.value = result;
    ledgerHead.value = result.ledger_head;
    if (['proposal-admit', 'submit-review-admit'].includes(command.value)) await loadGraph();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadGraph());
</script>

<template>
  <OperatorConsoleShell eyebrow="Site authority" :title="`Epistemic Graph · ${siteId}`" back-href="/console/registry" back-label="Back to Sites" navigation-key="epistemic-graph">
    <main class="graph-workspace">
      <header class="authority">
        <div><span>Site</span><strong>{{ siteId }}</strong></div>
        <div><span>Ledger head</span><code>{{ ledgerHead ?? 'empty graph' }}</code></div>
        <div><span>Projection</span><strong>{{ nodes.length }} nodes · {{ edges.length }} edges</strong></div>
        <Button :disabled="loading" @click="loadGraph">{{ loading ? 'Loading…' : 'Refresh graph' }}</Button>
      </header>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>

      <section class="visualization">
        <EpistemicGraphCanvas :nodes="nodes" :edges="edges" @select="selected = $event" />
        <aside class="inspector">
          <h2>Selection</h2>
          <template v-if="selected"><strong>{{ selected.title || selected.entity_id }}</strong><code>{{ selected.entity_id }}</code><p>{{ selected.kind }}</p></template>
          <p v-else class="empty">Select a node to inspect it.</p>
        </aside>
      </section>

      <section class="workbench" aria-label="Epistemic graph authority workbench">
        <aside>
          <h2>Authority workflow</h2>
          <label>Command<select v-model="command"><option v-for="item in commands" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          <label>Arguments<textarea v-model="argumentsText" rows="12" spellcheck="false" /></label>
          <small>Uses the bounded MCP contract. Authenticated Site authority overwrites identity fields and guards ledger mutations.</small>
          <Button :disabled="loading" @click="execute">{{ loading ? 'Executing…' : 'Execute' }}</Button>
        </aside>
        <section class="result"><h2>Authority result</h2><pre v-if="response">{{ JSON.stringify(response.result, null, 2) }}</pre><p v-else class="empty">No command result.</p></section>
      </section>
    </main>
  </OperatorConsoleShell>
</template>

<style scoped>
.graph-workspace { max-width: 1600px; margin: 0 auto; padding: 20px; }
.authority { display:flex; align-items:center; gap:24px; padding:14px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
.authority>div { display:grid; gap:4px; min-width:160px; }.authority span { color:var(--muted); font-size:11px; text-transform:uppercase; }.authority button { margin-left:auto; }
.visualization { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:16px; margin-top:16px; }.inspector,.workbench>aside,.result { padding:16px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
.inspector { display:grid; align-content:start; gap:10px; }.workbench { display:grid; grid-template-columns:360px minmax(0,1fr); gap:16px; margin-top:16px; }.result { min-height:360px; }
h2 { margin:0 0 14px; font-size:14px; } label { display:grid; gap:6px; margin-bottom:14px; color:var(--muted); font-size:12px; }
select,textarea { width:100%; box-sizing:border-box; border:1px solid var(--line-strong); border-radius:var(--radius); background:var(--control-bg); color:var(--text); } select { min-height:36px; padding:6px 9px; } textarea { padding:10px; font:12px/1.45 var(--mono); resize:vertical; }
small,.empty { color:var(--muted); } small { display:block; margin:-6px 0 14px; line-height:1.4; } pre { max-height:500px; overflow:auto; padding:14px; border-radius:var(--radius); background:var(--surface-muted); font:12px/1.5 var(--mono); white-space:pre-wrap; }
.notice.error { padding:12px 14px; color:var(--danger); border:1px solid var(--line); border-radius:var(--radius); } code { font:12px var(--mono); overflow-wrap:anywhere; }
@media(max-width:900px){.authority{align-items:stretch;flex-direction:column}.authority button{margin-left:0}.visualization,.workbench{grid-template-columns:1fr}}
</style>
