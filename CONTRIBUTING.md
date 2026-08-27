# Contributing

Thanks for taking an interest. This is a small codebase and easy to get into.

## Getting started

```bash
git clone https://github.com/mohammedkmo/opentable.git
cd opentable
npm install
npm run dev
```

You need Node 22+. No database is required to start the app — but to do
anything useful you will want a local PostgreSQL, MySQL, or just a SQLite file.

## Before you open a pull request

```bash
npm run typecheck    # both processes must pass
npm run build        # must succeed
```

There is no test suite yet. If you change SQL generation
(`src/shared/sql.ts`, `src/shared/alter.ts`), please say in the PR which
databases you actually ran it against — that matters more here than most
places, because a wrong `ALTER` destroys data.

## Architecture in one minute

```
src/
  main/        Node side. Database drivers, SSH, files, secrets.
               The renderer can never reach these directly.
  preload/     The only bridge. A typed, explicit IPC surface.
  renderer/    React UI. No Node access at all.
  shared/      Types and pure SQL builders used by both sides.
```

The security boundary matters: `contextIsolation` is on and `nodeIntegration`
is off. Anything touching the filesystem, the network, or credentials belongs
in `main/`, exposed through `preload/` as a named method — never by widening
the bridge.

## House style

- TypeScript strict, no `any` unless a dependency forces it
- Prettier settings live in `.prettierrc`; match the surrounding code
- Comments explain *why*, not *what*. If a workaround exists, say what breaks
  without it — several already in this codebase document real dialect quirks
- Keep dialect differences in `shared/`, not scattered through the UI

## Things worth knowing

- **MySQL ignores inline `REFERENCES`.** Foreign keys must be emitted as
  table-level constraints or they silently do nothing.
- **SQLite cannot alter a column type, nullability, default, primary key or
  foreign keys.** Those changes require a full table rebuild — see
  `sqliteRebuild()` in `src/shared/alter.ts`.
- **Identifier quoting is centralised** in `quoteIdent()`. Never interpolate a
  name into SQL yourself.
- **Row edits use bound parameters**, never string concatenation. The inlined
  SQL you see in the UI is for display only.
