import { SiteFabricClient, type JsonRecord } from '@narada-core/mcp-runtime-client';
import {
  EpistemicGraphGateway,
  type EpistemicGraphSiteResolver,
  type EpistemicGraphSurfaceInvoker,
} from './epistemic-graph-gateway.js';

export interface EpistemicGraphGatewayRuntime {
  gateway: EpistemicGraphGateway;
  close(): Promise<void>;
}

export function createEpistemicGraphGatewayRuntime(
  sites: EpistemicGraphSiteResolver,
): EpistemicGraphGatewayRuntime {
  const clients = new Map<string, Promise<SiteFabricClient>>();

  async function clientFor(siteRoot: string): Promise<SiteFabricClient> {
    const existing = clients.get(siteRoot);
    if (existing) return await existing;
    const opening = SiteFabricClient.open({
      siteRoot,
      allowedSurfaceIds: ['epistemic-graph'],
      maxConnections: 1,
      requestTimeoutMs: 30_000,
      closeTimeoutMs: 5_000,
    });
    clients.set(siteRoot, opening);
    try {
      return await opening;
    } catch (cause) {
      clients.delete(siteRoot);
      throw cause;
    }
  }

  const invoker: EpistemicGraphSurfaceInvoker = {
    async call(input) {
      const client = await clientFor(input.siteRoot);
      return await client.call(
        input.surfaceId,
        input.toolName,
        input.arguments as JsonRecord,
        { timeoutMs: 30_000 },
      );
    },
  };

  return {
    gateway: new EpistemicGraphGateway(sites, invoker),
    async close() {
      const settled = await Promise.allSettled([...clients.values()]);
      clients.clear();
      await Promise.allSettled(settled
        .filter((item): item is PromiseFulfilledResult<SiteFabricClient> => item.status === 'fulfilled')
        .map((item) => item.value.close()));
    },
  };
}
