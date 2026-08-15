import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.fn();
vi.mock('@narada-core/mcp-runtime-client', () => ({
  SiteFabricClient: { open },
}));

const { createEpistemicGraphGatewayRuntime } = await import('../../src/commands/epistemic-graph-gateway-runtime.js');

describe('EpistemicGraphGatewayRuntime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens an exact Site fabric client, reuses it, and closes it', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'ok', ledger_head: 'head-1' });
    const close = vi.fn().mockResolvedValue(undefined);
    open.mockResolvedValue({ call, close });
    const runtime = createEpistemicGraphGatewayRuntime({
      resolve: vi.fn().mockResolvedValue({ site_id: 'site-a', site_root: 'C:/sites/a' }),
    });

    const request = {
      schema: 'narada.operator_console.epistemic_graph.v1' as const,
      site_id: 'site-a',
      command: 'status' as const,
      arguments: {},
    };
    await runtime.gateway.execute('site-a', request, { kind: 'operator', id: 'operator-a' });
    await runtime.gateway.execute('site-a', request, { kind: 'operator', id: 'operator-a' });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      siteRoot: 'C:/sites/a',
      allowedSurfaceIds: ['epistemic-graph'],
      maxConnections: 1,
    }));
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledWith('epistemic-graph', 'epistemic_graph_status', {}, { timeoutMs: 30_000 });

    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not cache a failed client opening', async () => {
    open.mockRejectedValueOnce(new Error('loader unavailable'));
    open.mockResolvedValueOnce({ call: vi.fn().mockResolvedValue({ status: 'ok' }), close: vi.fn() });
    const runtime = createEpistemicGraphGatewayRuntime({
      resolve: vi.fn().mockResolvedValue({ site_id: 'site-a', site_root: 'C:/sites/a' }),
    });
    const request = {
      schema: 'narada.operator_console.epistemic_graph.v1' as const,
      site_id: 'site-a',
      command: 'status' as const,
      arguments: {},
    };

    expect((await runtime.gateway.execute('site-a', request, { kind: 'operator', id: 'operator-a' })).status).toBe('failed');
    expect((await runtime.gateway.execute('site-a', request, { kind: 'operator', id: 'operator-a' })).status).toBe('success');
    expect(open).toHaveBeenCalledTimes(2);
  });
});
