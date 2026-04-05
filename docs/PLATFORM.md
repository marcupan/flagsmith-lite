# Internal Platform

Tools and shared configurations that make the right path the easy path.

## Shared Packages

| Package                | What                       | Used by            |
| ---------------------- | -------------------------- | ------------------ |
| `@project/config-ts`   | TypeScript base configs    | All packages       |
| `@project/config-lint` | ESLint + Prettier config   | Root config        |
| `@project/cli`         | CLI tools for the project  | Developers         |
| `@project/shared`      | Shared types + utilities   | api, web, sdk      |
| `@project/sdk`         | Typed SDK for evaluate API | External consumers |

## TypeScript Configs

Three configs in `packages/config-ts/`:

| Config       | Extends | Purpose                     |
| ------------ | ------- | --------------------------- |
| `base.json`  | —       | Strictest shared settings   |
| `node.json`  | base    | Node.js packages (api, sdk) |
| `react.json` | base    | React + DOM (web)           |

Usage in any package `tsconfig.json`:

```json
{
  "extends": "../config-ts/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  }
}
```

### How to add a new TypeScript rule

1. Edit `packages/config-ts/base.json` (applies to all packages)
2. Or edit `node.json` / `react.json` for environment-specific rules
3. Run `pnpm build` to verify all packages still compile

## Lint & Format

`@project/config-lint` exports named ESLint config arrays and a Prettier config.

Root `eslint.config.mjs` composes them:

```js
import { base, api, web, shared, scripts } from "@project/config-lint";

export default tsEsLint.config(...base, ...api, ...web, ...shared, ...scripts);
```

Root `prettier.config.js` re-exports the shared config:

```js
export { default } from "@project/config-lint/prettier.config.js";
```

### How to add a new lint rule

1. Edit `packages/config-lint/eslint.config.mjs`
2. Add the rule to the appropriate section (`api`, `web`, `shared`, or `base`)
3. Run `pnpm lint` to verify — `pnpm lint:fix` to auto-fix

## CLI Reference

Run with `pnpm cli <command>`:

| Command                      | What it does                                                  |
| ---------------------------- | ------------------------------------------------------------- |
| `pnpm cli new:adr <title>`   | Create a new ADR from template, auto-numbered                 |
| `pnpm cli new:migration <n>` | Create a timestamped migration SQL file                       |
| `pnpm cli health`            | Check all services: API, Postgres, Redis, Prometheus, Grafana |
| `pnpm cli metrics`           | Fetch and display key metrics from `/metrics`                 |
| `pnpm cli db:status`         | Show migration status (applied vs pending)                    |

Every command supports `--help`:

```bash
pnpm cli new:adr --help
pnpm cli health --help
```

### How to add a new CLI command

1. Create `packages/cli/src/commands/my-command.ts`:

   ```ts
   export async function myCommand(arg: string): Promise<void> {
     // implementation
   }
   ```

2. Register in `packages/cli/src/index.ts`:

   ```ts
   import { myCommand } from "./commands/my-command.js";

   program.command("my:command <arg>").description("What it does").action(myCommand);
   ```

3. Add to this table above
4. Run `pnpm cli my:command --help` to verify
