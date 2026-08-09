#!/usr/bin/env node
// legacy_agent_context_server_retired
//
// Agent Context has one registrar-bound MCP implementation:
// @narada-core/agent-context-mcp in the mcp-surfaces repository.
//
// This path remains only as an explicit refusal for stale Site projections and
// hand-written launch commands. It must not proxy, recompile, or independently
// infer session context because doing so would recreate a second authority
// path.

const refusal = {
  schema: 'narada.agent_context.legacy_server_retired.v1',
  code: 'legacy_agent_context_server_retired',
  message: 'The Narada-local Agent Context MCP server has been retired.',
  canonical_surface: '@narada-core/agent-context-mcp',
  discovery: 'Use the registrar-generated Site MCP fabric entry whose catalog_surface_id is agent-context.',
};

process.stderr.write(`${JSON.stringify(refusal)}\n`);
process.exitCode = 78;
