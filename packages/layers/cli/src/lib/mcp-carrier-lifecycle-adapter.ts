import { discoverNarsSessions } from '@narada-core/nars-session-core/session-index';
export const MCP_CARRIER_LIFECYCLE_ADAPTERS = {
  'nars-successor-v1': {
    adapter_id: 'nars-successor-v1',
    activation_authority: 'nars_session_authority_handoff',
    activation_mechanism: 'pc_owned_successor_drain_supervisor',
    requires_managed_nars_session: true,
    identity_contract: 'materialized_carrier_id_required',
    unbound_session_posture: 'refuse',
    supported_materialized_carrier_ids: ['codex-andrey', 'kimi-andrey', 'opencode-andrey'],
    postcondition: 'successor_ready_source_retired',
  },
} as const;

export type McpCarrierLifecycleAdapterId = keyof typeof MCP_CARRIER_LIFECYCLE_ADAPTERS;
export type McpCarrierLifecycleAdapter = typeof MCP_CARRIER_LIFECYCLE_ADAPTERS[McpCarrierLifecycleAdapterId];

export function resolveMcpCarrierLifecycleAdapter(
  adapterId: string | undefined,
  carrierId: string,
): McpCarrierLifecycleAdapter {
  if (!adapterId) throw new Error('mcp_carrier_lifecycle_adapter_required');
  if (!(adapterId in MCP_CARRIER_LIFECYCLE_ADAPTERS)) {
    throw new Error('mcp_carrier_lifecycle_adapter_unknown:' + adapterId);
  }
  const adapter = MCP_CARRIER_LIFECYCLE_ADAPTERS[adapterId as McpCarrierLifecycleAdapterId];
  if (!(adapter.supported_materialized_carrier_ids as readonly string[]).includes(carrierId)) {
    throw new Error('mcp_carrier_lifecycle_adapter_carrier_unsupported:' + adapterId + ':' + carrierId);
  }
  return adapter;
}
export function assertMcpCarrierSessionBinding(siteRoot: string, sessionId: string, carrierId: string): Record<string, unknown> {
  const discovery = discoverNarsSessions({ siteRoot });
  const session = discovery.sessions.find((candidate) => candidate.session_id === sessionId || candidate.carrier_session_id === sessionId);
  if (!session) throw new Error('mcp_carrier_session_not_found:' + sessionId);
  const boundCarrierId = typeof session.materialized_carrier_id === 'string' ? session.materialized_carrier_id.trim() : '';
  if (!boundCarrierId) throw new Error('mcp_carrier_session_binding_missing:' + sessionId);
  if (boundCarrierId !== carrierId) {
    throw new Error('mcp_carrier_session_binding_mismatch:' + sessionId + ':expected=' + carrierId + ':actual=' + boundCarrierId);
  }
  return { session_id: session.session_id ?? sessionId, materialized_carrier_id: boundCarrierId, identity_contract: 'materialized_carrier_id_required', record_path: session.record_path ?? null };
}