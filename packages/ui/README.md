# @narada-core/ui

Shared, renderer-neutral Narada UI foundation and design system.

The package owns the existing application foundation plus the Saffron/evidence design system extracted from Narada Space. The application foundation remains available as `styles.css`; site and experiment surfaces can consume the richer system as `design-system.css`.

```ts
import '@narada-core/ui/styles.css';
import '@narada-core/ui/design-system.css';
```

`tokens.css` and `primitives.css` are also exported for static-scene asset generation. This package does not own Vue components, session transport, operator panels, or site-specific layout. Vue primitives belong in `@narada-core/ui-vue`; a consumer owns its application shell and domain behavior.

The cross-repository consumer and release contract is documented in docs/deployment/site-ui-and-wrangler.md.
