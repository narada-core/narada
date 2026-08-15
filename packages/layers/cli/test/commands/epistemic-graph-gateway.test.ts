import { describe, expect, it, vi } from 'vitest';
import {
  OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
  type OperatorEpistemicGraphRequest,
} from '@narada-core/operator-console-contract';
import {
  EpistemicGraphGateway,
  resolveEpistemicGraphPrincipalFromEnvironment,
  type EpistemicGraphSiteResolver,
  type EpistemicGraphSurfaceInvoker,
} from '../../src/commands/epistemic-graph-gateway.js';

function request(overrides: Partial<OperatorEpistemicGraphRequest> = {}): OperatorEpistemicGraphRequest {
  return {
    schema: OPERATOR_CONSOLE_EPISTEMIC_GRAPH_WIRE_SCHEMA,
    site_id: 'site-a',
    command: 'status',
    arguments: {},
    ...overrides,
  };
}

function fixture(site = true) {
  const sites: EpistemicGraphSiteResolver = {
    resolve: vi.fn().mockResolvedValue(site ? { site_id: 'site-a', site_root: 'C:/sites/a' } : null),
  };
  const call = vi.fn().mockResolvedValue({ status: 'ok', ledger_head: 'sha256:head' });
  const invoker: EpistemicGraphSurfaceInvoker = { call };
  return { gateway: new EpistemicGraphGateway(sites, invoker), sites, call };
}

describe('epistemic graph principal resolution', () => {
  it('accepts only a server-side admitted environment assertion', () => {
    expect(resolveEpistemicGraphPrincipalFromEnvironment({ NARADA_OPERATOR_SURFACE_IDENTITY: 'operator-a' }))
      .toEqual({ kind: 'operator', id: 'operator-a' });
    expect(resolveEpistemicGraphPrincipalFromEnvironment({})).toBeNull();
  });
});

describe('EpistemicGraphGateway', () => {
  it('refuses a Site identity mismatch before resolving or invoking authority', async () => {
    const { gateway, sites, call } = fixture();
    const result = await gateway.execute('site-b', request(), { kind: 'operator', id: 'operator-a' });

    expect(result.status).toBe('refused');
    expect(result.error?.code).toBe('epistemic_graph_request_invalid');
    expect(sites.resolve).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('requires an authenticated principal', async () => {
    const { gateway, call } = fixture();
    const result = await gateway.execute('site-a', request(), null);

    expect(result.status).toBe('refused');
    expect(result.error?.code).toBe('epistemic_graph_principal_required');
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses an unregistered Site', async () => {
    const { gateway, call } = fixture(false);
    const result = await gateway.execute('site-a', request(), { kind: 'operator', id: 'operator-a' });

    expect(result.status).toBe('refused');
    expect(result.error?.code).toBe('epistemic_graph_site_not_found');
    expect(call).not.toHaveBeenCalled();
  });

  it('does not forward a ledger head to tools whose schema does not accept it', async () => {
    const { gateway, call } = fixture();
    await gateway.execute('site-a', request({ expected_ledger_head: null }), { kind: 'operator', id: 'operator-a' });

    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'epistemic_graph_status',
      arguments: {},
    }));
  });

  it('maps a read command to the exact Site-bound MCP tool', async () => {
    const { gateway, call } = fixture();
    const result = await gateway.execute('site-a', request({
      command: 'graph-snapshot',
      arguments: { entity_offset: 20, limit: 100 },
      expected_ledger_head: 'sha256:prior',
    }), { kind: 'operator', id: 'operator-a' });

    expect(result.status).toBe('success');
    expect(result.ledger_head).toBe('sha256:head');
    expect(call).toHaveBeenCalledWith({
      siteRoot: 'C:/sites/a',
      surfaceId: 'epistemic-graph',
      toolName: 'epistemic_graph_snapshot',
      arguments: { entity_offset: 20, limit: 100, expected_ledger_head: 'sha256:prior' },
    });
  });

  it('overrides mutation actor and authority with the authenticated principal', async () => {
    const { gateway, call } = fixture();
    await gateway.execute('site-a', request({
      command: 'proposal-submit',
      arguments: { actor: 'spoofed', authority_basis: 'spoofed', proposal: { id: 'p1' } },
    }), { kind: 'operator', id: 'operator-a' });

    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'epistemic_graph_proposal_submit',
      arguments: {
        actor: 'operator-a',
        authority_basis: {
          kind: 'operator-console',
          site_id: 'site-a',
          principal_id: 'operator-a',
        },
        proposal: { id: 'p1' },
      },
    }));
  });

  it('projects only identity fields accepted by each MCP command', async () => {
    const { gateway, call } = fixture();

    await gateway.execute('site-a', request({
      command: 'proposal-review',
      arguments: { proposal_id: 'p1', actor: 'spoofed', authority_basis: 'spoofed' },
    }), { kind: 'operator', id: 'operator-a' });
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: 'epistemic_graph_proposal_review',
      arguments: { proposal_id: 'p1' },
    }));

    await gateway.execute('site-a', request({
      command: 'proposal-reject',
      arguments: { proposal_id: 'p1', actor: 'spoofed', authority_basis: 'not-accepted', reason: 'invalid' },
    }), { kind: 'operator', id: 'operator-a' });
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({
      toolName: 'epistemic_graph_proposal_reject',
      arguments: { proposal_id: 'p1', actor: 'operator-a', reason: 'invalid' },
    }));
  });

  it('returns a failed envelope when the Site authority call fails', async () => {
    const { gateway, call } = fixture();
    call.mockRejectedValue(new Error('authority unavailable'));

    const result = await gateway.execute('site-a', request(), { kind: 'operator', id: 'operator-a' });

    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'epistemic_graph_authority_call_failed',
      message: 'authority unavailable',
    });
  });
});
