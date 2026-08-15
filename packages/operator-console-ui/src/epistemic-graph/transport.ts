import {
  OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
  type OperatorEpistemicGraphCommand,
  type OperatorEpistemicGraphRequest,
  type OperatorEpistemicGraphResponse,
} from '@narada-core/operator-console-contract';

export interface EpistemicGraphTransport {
  call(command: OperatorEpistemicGraphCommand, args?: Record<string, unknown>, expectedLedgerHead?: string | null): Promise<OperatorEpistemicGraphResponse>;
}

export function createEpistemicGraphTransport(siteId: string, fetchImpl: typeof fetch = fetch): EpistemicGraphTransport {
  const encodedSiteId = encodeURIComponent(siteId);
  const endpoint = `/console/sites/${encodedSiteId}/epistemic-graph/api`;
  return {
    async call(command, args = {}, expectedLedgerHead) {
      const request: OperatorEpistemicGraphRequest = {
        schema: OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
        site_id: siteId,
        command,
        arguments: args,
        ...(expectedLedgerHead === undefined ? {} : { expected_ledger_head: expectedLedgerHead }),
      };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as OperatorEpistemicGraphResponse;
      if (payload.schema !== OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA || payload.site_id !== siteId) {
        throw new Error('epistemic_graph_authority_response_mismatch');
      }
      if (!response.ok || payload.status !== 'success') {
        throw new Error(payload.error?.message ?? `epistemic_graph_http_${response.status}`);
      }
      return payload;
    },
  };
}
