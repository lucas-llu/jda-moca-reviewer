# JDA MOCA Code Reviewer

## Installation

### Install from a VSIX file

1. Build or download `code-reviewer-0.0.3.vsix`.
2. Open Visual Studio Code.
3. Open the Extensions view with `Ctrl+Shift+X`.
4. Select the `...` menu and choose **Install from VSIX...**.
5. Select the VSIX file and reload Visual Studio Code when prompted.

### Build from source

```bash
npm install
npm test
npm run compile
npx --yes @vscode/vsce package
```

The generated package is `code-reviewer-0.0.3.vsix`.

## Usage

Open the Command Palette with `Ctrl+Shift+P` and run one of the following commands:

- **Code Reviewer: Review Current File** — review the active `.mcmd`, `.mtrg`, `.jrxml`, `.pof`, database, CSV, CTL, or post-install file when it is in a supported project path.
- **Code Reviewer: Review Project** — review all supported files in the workspace while excluding `.git`, `node_modules`, `out`, `dist`, and placeholder `.gitkeep` files.
- **Code Reviewer: Review by Jira Ticket** — enter a Jira key such as `SWIFTLEX-74319`; the extension reviews matching committed changes together with staged, unstaged, and untracked supported files.
- **Code Reviewer: Review Current .jrxml File** — review the active JasperReport file specifically.

Issues are shown in VS Code's **Problems** panel. Errors block the review result; warnings are advisory and remain visible even when an explanatory comment is present.

## What this extension reviews

This extension reviews JDA/Blue Yonder MOCA local customisations, including:

- **MOCA Commands and Triggers**: `.mcmd` structure, command naming, `lc`/`usr`/`pd` layer classification, BY policy guards, trigger single-command rules, copy markers, SQL complexity, DML usage, subqueries, View usage, division-by-zero protection, bind hints, and related command safety checks.
- **Database objects**: table, index, sequence, view, and database-trigger naming, prefixes, primary keys, CREATE/ALTER consistency, idempotency, ORCA registration, and index unload dependencies.
- **CSV and CTL data**: `cust_lvl`, `les_mls_cat` ranges, CSV/CTL dependencies, unload DELETE patterns, Config Action version checks, and post-install `mload_all` coverage.
- **Reports and Labels**: `.jrxml` report naming and `MOCA_REPORT_CONNECTION` safety, plus `.pof` label naming and `rpt_id` consistency.
- **Git/Jira workflow**: branch-name validation, ticket-based file selection, rename/delete handling, and duplicate-file removal.

Rules that require external evidence—such as QA/DBA approval, SQL execution-plan analysis, representative-data performance testing, or whether a command is called by Web UI/IFD—remain manual review items and are not generated as plugin diagnostics.

## Supported project paths

The current routing recognizes these project locations:

- `les/db/ddl/**/Tables`
- `les/db/ddl/**/Indexes`
- `les/db/ddl/**/Sequences`
- `les/db/ddl/**/Views`
- `les/db/ddl/**/Triggers`
- `les/db/data/**`
- `les/labels/z140xiII` and `les/reports/z140xiII`
- `postinstall/**` `isccustom*.sh` scripts

## Development

```bash
npm install
npm test
npm run lint
npm run compile
npx --yes @vscode/vsce package
```

The extension currently exposes the automatic-review settings in its manifest for future integration; the active workflow is command-driven through the Command Palette.

## License

MIT
