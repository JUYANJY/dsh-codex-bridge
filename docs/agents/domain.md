# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: single-context

Confirmed at setup time: this repo is **single-context** — one `CONTEXT.md` at the repo root, with architecture decisions in `docs/adr/`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain vocabulary for this repo.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context is **not** this repo's layout. It would be signalled by a `CONTEXT-MAP.md` at the root pointing at one `CONTEXT.md` per context, each with its own `src/<context>/docs/adr/`. Nothing here creates that: no `CONTEXT-MAP.md` and no per-subproject `CONTEXT.md` exists yet, and none should be created until a real entry needs writing.

## Naming

This repo's domain vocabulary file is **`CONTEXT.md`**, and the multi-context map
would be **`CONTEXT-MAP.md`**. Some bundled skill templates — `domain-modeling`, and
the upstream template this file was generated from, both installed under
`node_modules/` — call that same artifact `GLOSSARY.md` / `GLOSSARY-MAP.md`. Those
are aliases for one file, and this repo's name wins. Concretely:

- **Read** `CONTEXT.md`.
- **Create** `CONTEXT.md` when a skill creates it lazily — never `GLOSSARY.md`.
- If a skill leaves a `GLOSSARY.md` here, **rename** it to `CONTEXT.md` instead of
  keeping both side by side.

The templates cannot be edited to say this (they are third-party files inside
`node_modules/`, replaced on every plugin update), so the rule lives here rather
than upstream.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
