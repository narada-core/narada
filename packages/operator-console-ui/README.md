# Operator Console UI

The Operator Console UI is a Vue projection over Narada's existing Site
authorities. It does not own filesystem, task, registry, or epistemic-graph
state and it must not reconstruct those authorities in the browser.

## Epistemic Graph

`/console/sites/<site-id>/epistemic-graph` provides an interactive graph,
selection inspector, and the proposal/review/admission workbench. The browser
posts typed commands to the same-origin Site endpoint. It never supplies an
actor, authority basis, principal, Site root, or MCP entrypoint.

The server resolves the exact registered Site, derives the authenticated
operator principal from server-owned launch context, overwrites identity
fields, and invokes only that Site's admitted `epistemic-graph` MCP surface.
Mutations carry the observed ledger head. Graph snapshot paging pins all pages
to the head returned by the first page and refuses a concurrent mixed view.

Cloudflare serves the same route through the Access-gated, origin-pinned
Operator Console gateway. Cloudflare remains a projection and transport
boundary; the Site MCP surface remains the graph authority.
