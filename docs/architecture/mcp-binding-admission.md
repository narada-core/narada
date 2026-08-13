# MCP binding admission

MCP surfaces provide mechanism; a Narada site configuration supplies authority. Merely discovering a surface, knowing its identifier, or receiving a site root does not grant authority to activate it.

At session admission, the authority owner compiles the selected binding class into a finite set of exact materialized binding identities. It records a `narada.mcp.binding_admission_envelope.v1` envelope in the same transaction as the session admission. The envelope binds each permitted `binding_id` to its surface, projection, authority locus, launch identity, operations, principal, site, session, carrier, runtime, authority epoch, and current fabric digest.

An admitted carrier session has at most one binding for each `surface_id`. The model-facing server name is exactly that generic `surface_id`; it is a reference to the selected mechanism, not an authority token. Site-qualified `server_key` values remain private provenance in registries and materialization sidecars. If two bindings would project the same surface into one carrier, admission and materialization fail with both conflicting identities; they do not overwrite, suffix, or expose aliases.

The set is non-expanding. A binding added to the site fabric after admission is unavailable to the running session until the authority owner issues a new admission. An agent can request or activate only a binding already named by the envelope; it cannot convert discovery, a surface class, or site configuration access into a grant.

A governed binding has exactly one executable representation: the envelope's canonical `binding_identity`. Only the fabric compiler may translate a declaration into that identity. Admission, digest verification, and process launch consume the same object; downstream components must not reconstruct defaults or reread executable fields from mutable Site configuration. Changing a declaration therefore requires compilation and a new admission rather than changing a running session's launch.

Agent start projects only the owner-produced envelope path and digest into the carrier. It does not mint authority. Dynamic loaders must:

1. fail closed when governed operation has no valid envelope;
2. resolve activation by exact `binding_id`, not by surface name or called site;
3. verify envelope, session, principal, epoch, validity interval, and fabric/binding digests;
4. reject launch-identity overrides and identity/digest tampering;
5. revalidate on attach, restart, and call.

Direct or test-only ambient attachment is an explicit standalone mode and is not a governed Narada session.

This division keeps the generic surface reusable while making authority session-specific, explicit, reviewable, and revocable.
