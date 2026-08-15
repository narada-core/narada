# Shared UI and Wrangler release contract

Narada proper owns the canonical renderer-neutral design system in
packages/ui. Narada Space is the visual reference and specimen source;
Marici and Cintamani consume the published @narada-core/ui package rather
than maintaining copied tokens or primitives.

## Site release matrix

| Site | Shared UI step | Release command | Cloudflare surface |
| --- | --- | --- | --- |
| narada.space | pnpm run sync:design-system | pnpm ship | The local Wrangler configuration for Narada Space |
| marici | pnpm run build:ui (included by build) | pnpm run ship | Worker marici, with assets from dist |
| cintamani | pnpm site:ship from the repository root | pnpm site:ship | Worker cintamani, with assets from dist and its D1 binding |

Each site owns its Wrangler configuration and deploys its own built assets.
The shared UI ownership is centralized in Narada; a site-specific visual
change belongs in Narada packages/ui unless it is deliberately an
application-level composition.

## Mathematical notation

Marici and Cintamani use the same Astro Markdown pipeline:
remark-math, remark-narada-math, and rehype-katex. Use \(...\) for inline
TeX and a standalone \[...\] paragraph for display TeX. Keep commands such
as \mathrm{NLSM} inside those delimiters so they reach KaTeX as TeX instead
of being rendered as ordinary text.

## Marici ledger identity

The public Marici ledger uses qualified author names. Ordinary entries
default to marici.Nima. All Cosmology entries published so far are
attributed to marici.Benincasa. The content schema also accepts explicit
authors metadata for future genuinely multi-author entries. Ledger list and
detail views use the qualified name in the attribution sentence.

## Wrangler invocation

The normal release commands above are the source-of-truth gates: build the
site first, run any required database migration, and then deploy through
the repository's local Wrangler configuration.

When a governed MCP or scheduled Windows environment cannot resolve a
package shim, invoke the project-local Wrangler entrypoint with the active
Node executable from the site root:

    node node_modules/wrangler/bin/wrangler.js deploy

This preserves the same Wrangler configuration and authentication path while
avoiding dependence on a shell-specific .cmd or package-manager shim. Do
not use the direct deploy shortcut in place of a required build or Cintamani
remote D1 migration.

The Marici and Cintamani Wrangler publishes were directly verified with this
mechanism on 2026-08-14; both completed successfully.
