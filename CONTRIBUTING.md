# Contributing

mcp-doctor is a small library with three fronts. Keep it that way.

## Setup

Node 20 or newer.

```bash
npm ci
npm test
npm run build
```

## What to run before a change is done

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run schemas:validate
npm run playground:build
npm run playground:dry-run
```

Coverage must stay at or above 85% for statements, branches, functions, and lines. `schemas:validate` checks that the JSON Schema files in `packages/core/schemas/` match the generator and that Ajv can compile them.

## Adding a client

1. Add the id to `CLIENT_IDS` and a profile in `packages/core/src/clients.ts`. Cite the public doc URL.
2. Teach `parse.ts` and `emit.ts` about any field that is not already shared.
3. Add a golden fixture in `packages/core/fixtures/golden.json`, copied from that doc, with the doc URL on the fixture.
4. The pair tests pick the new client up. Fix the carry report if a field cannot survive.
5. Run `npm run schemas:write` and commit the schema file.

## Adding a lint rule

Add an entry to `RULES` and a branch in `checkRule`. The id, the summary, and the fix text are the contract. Cover the hit and the clean case. Do not echo secret values in the message.

## doctor

`doctor` is read-only toward config files and it starts the servers those files name. Tests must pass a fake home directory. Do not point a test at a real home.

## Playground

The Worker must not log request bodies, store them, or call any host other than serving the response. PATH checks and handshakes stay in the CLI and the MCP server.
