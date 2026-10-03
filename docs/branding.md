# Agent Swarm naming and compatibility

The product name is **Agent Swarm**. User-facing titles, dashboard labels, examples, and project descriptions use that name.

Existing `quant-swarm` strings remain as compatibility identifiers where changing them would address a different migration problem: SpacetimeDB database names (`quant-swarm`, `quant-swarm-coord`, and `quant-swarm-factorio-coord`), table/run history, token and artifact directories, backup paths, package lock metadata, environment defaults, and board/session names. Renaming those values would disconnect existing workers, tokens, saved artifacts, or databases. They are implementation identifiers, not the product label.

The migration path is therefore additive: new user-facing work should say Agent Swarm, while existing technical identifiers continue to work until a separately planned database, token, artifact, and package migration is performed. Do not rename a database or token directory as part of a UI/documentation change. When writing new compatibility documentation, explain the old identifier instead of presenting it as the product name.
