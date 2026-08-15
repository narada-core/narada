import {
  OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
  type OperatorEpistemicGraphCommand,
  type OperatorEpistemicGraphRequest,
  type OperatorEpistemicGraphResponse,
} from '@narada-core/operator-console-contract';

export interface EpistemicGraphSiteBinding {
  site_id: string;
  site_root: string;
}

export interface EpistemicGraphSiteResolver {
  resolve(siteId: string): Promise<EpistemicGraphSiteBinding | null>;
}

export interface EpistemicGraphSurfaceInvoker {
  call(input: {
    siteRoot: string;
    surfaceId: 'epistemic-graph';
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface EpistemicGraphPrincipal {
  kind: 'operator';
  id: string;
}

export function resolveEpistemicGraphPrincipalFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EpistemicGraphPrincipal | null {
  const id = environment.NARADA_OPERATOR_SURFACE_IDENTITY
    ?? environment.NARADA_AGENT_ID
    ?? environment.NARADA_PRINCIPAL_ID;
  return id ? { kind: 'operator', id } : null;
}

const COMMAND_TO_TOOL: Readonly<Record<OperatorEpistemicGraphCommand, string>> = {
  status: 'epistemic_graph_status',
  query: 'epistemic_graph_query',
  'query-batch': 'epistemic_graph_query_batch',
  'graph-snapshot': 'epistemic_graph_snapshot',
  neighborhood: 'epistemic_graph_neighborhood',
  'source-inspect': 'epistemic_graph_source_inspect',
  'capture-sources': 'epistemic_graph_capture_sources',
  'proposal-submit': 'epistemic_graph_proposal_submit',
  'proposal-read': 'epistemic_graph_proposal_read',
  'proposal-resubmit': 'epistemic_graph_proposal_resubmit',
  'proposal-review': 'epistemic_graph_proposal_review',
  'proposal-admit': 'epistemic_graph_proposal_admit',
  'proposal-reject': 'epistemic_graph_proposal_reject',
  'submit-review-admit': 'epistemic_graph_submit_review_admit',
  export: 'epistemic_graph_export',
};

const ACTOR_COMMANDS = new Set<OperatorEpistemicGraphCommand>([
  'capture-sources',
  'proposal-submit',
  'proposal-resubmit',
  'proposal-admit',
  'proposal-reject',
  'submit-review-admit',
]);

const AUTHORITY_BASIS_COMMANDS = new Set<OperatorEpistemicGraphCommand>([
  'capture-sources',
  'proposal-submit',
  'proposal-resubmit',
  'proposal-admit',
  'submit-review-admit',
]);

const LEDGER_HEAD_COMMANDS = new Set<OperatorEpistemicGraphCommand>([
  'graph-snapshot',
  'capture-sources',
  'proposal-submit',
  'proposal-resubmit',
  'proposal-admit',
  'submit-review-admit',
]);

function refusal(
  siteId: string,
  command: OperatorEpistemicGraphCommand,
  principal: EpistemicGraphPrincipal | null,
  code: string,
  message: string,
): OperatorEpistemicGraphResponse {
  return {
    schema: OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
    status: 'refused',
    site_id: siteId,
    command,
    authority: { kind: 'site', site_id: siteId },
    principal,
    ledger_head: null,
    result: null,
    error: { code, message },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class EpistemicGraphGateway {
  constructor(
    private readonly sites: EpistemicGraphSiteResolver,
    private readonly invoker: EpistemicGraphSurfaceInvoker,
  ) {}

  async execute(
    pathSiteId: string,
    request: OperatorEpistemicGraphRequest,
    principal: EpistemicGraphPrincipal | null,
  ): Promise<OperatorEpistemicGraphResponse> {
    if (request.schema !== OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA
      || request.site_id !== pathSiteId
      || !isObject(request.arguments)
      || !Object.prototype.hasOwnProperty.call(COMMAND_TO_TOOL, request.command)) {
      return refusal(pathSiteId, request.command, principal, 'epistemic_graph_request_invalid', 'The request does not match the Site-bound epistemic graph contract.');
    }
    if (!principal) {
      return refusal(pathSiteId, request.command, null, 'epistemic_graph_principal_required', 'An authenticated operator principal is required.');
    }
    const site = await this.sites.resolve(pathSiteId);
    if (!site || site.site_id !== pathSiteId) {
      return refusal(pathSiteId, request.command, principal, 'epistemic_graph_site_not_found', 'The requested Site is not registered.');
    }

    const args: Record<string, unknown> = { ...request.arguments };
    delete args.actor;
    delete args.authority_basis;
    if (LEDGER_HEAD_COMMANDS.has(request.command) && request.expected_ledger_head !== undefined) {
      args.expected_ledger_head = request.expected_ledger_head;
    }
    if (ACTOR_COMMANDS.has(request.command)) {
      args.actor = principal.id;
    }
    if (AUTHORITY_BASIS_COMMANDS.has(request.command)) {
      args.authority_basis = {
        kind: 'operator-console',
        site_id: pathSiteId,
        principal_id: principal.id,
      };
    }

    try {
      const result = await this.invoker.call({
        siteRoot: site.site_root,
        surfaceId: 'epistemic-graph',
        toolName: COMMAND_TO_TOOL[request.command],
        arguments: args,
      });
      return {
        schema: OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
        status: 'success',
        site_id: pathSiteId,
        command: request.command,
        authority: { kind: 'site', site_id: pathSiteId },
        principal,
        ledger_head: typeof result.ledger_head === 'string' ? result.ledger_head : null,
        result,
        error: null,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ...refusal(pathSiteId, request.command, principal, 'epistemic_graph_authority_call_failed', message),
        status: 'failed',
      };
    }
  }
}
