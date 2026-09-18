# Regos MXIK and Product Marking Updater

End-user guide (no Node.js, portable `.exe`): see [README.user.md](README.user.md).

Node.js + TypeScript tool that:

1. Fetches products from Regos into SQLite
2. Looks up MXIK (`icps`) and marking status from [Tasnif](https://tasnif.soliq.uz)
3. Updates Regos `icps` and `is_labeled` only after a successful API write

Progress is stored per product in SQLite, so a crash or Ctrl+C can be resumed from the last successful update.

Requires **Node.js 22.13+** (uses the built-in `node:sqlite` module).

## Setup

```sh
cd C:\Projects\regos_mxik_updater
npm install
copy .env.example .env
```

Fill `.env` with the Regos integration token:

```
REGOS_INTEGRATION_TOKEN=...
```

For a **local** integration token, leave `REGOS_CLIENT_ID` and `REGOS_CLIENT_SECRET` empty. They are required only for catalog integrations that use OAuth.

## Settings

Edit `settings.json`:

```json
{
  "mxikUpdateMode": "empty_only",
  "updateIsLabeled": true,
  "includeChildGroups": true
}
```

| Setting | Values | Meaning |
| --- | --- | --- |
| `mxikUpdateMode` | `all` | Write MXIK from Tasnif for every matched product |
| `mxikUpdateMode` | `empty_only` | Write MXIK only when Regos `icps` is empty |
| `mxikUpdateMode` | `none` | Do not write MXIK; use with `updateIsLabeled` to update only marking |
| `updateIsLabeled` | `true` / `false` | Copy Tasnif marking (`label == 1`) to Regos `is_labeled` |
| `groupId` | number / `null` | If set, fetch and update only that Regos group |
| `includeChildGroups` | `true` / `false` | When a group is selected, also include products from child groups |

You can also choose these interactively:

```sh
npm start -- --interactive
```

## Desktop UI

Development (requires Node.js):

```sh
npm run ui
```

Portable Windows `.exe` (no Node.js, npm, or local server):

```sh
npm run dist:win
```

The file is written to `release/Regos-IKPU-1.0.0.exe`. Double-click it. Settings, `.env`, SQLite, and logs are stored next to the exe (`PORTABLE_EXECUTABLE_DIR`) or in `REGOS_DATA_DIR` if that environment variable is set.

The app still needs internet access for the Regos and Tasnif HTTPS APIs.

The Electron app can:

- Save connection secrets (local token or catalog OAuth)
- Change MXIK / `is_labeled` settings, including **update only is_labeled**
- Limit work to a Regos item group (groups load at startup; optionally include child groups)
- Start, stop, and **Continue** unfinished Tasnif/Regos work after Stop (does not fetch the catalog again)
- Empty the local SQLite database
- Set a VAT rate on all products, or only the selected group tree

## Run

Full pipeline (fetch → Tasnif → Regos update):

```sh
npm start
```

Individual steps:

```sh
npm start -- --fetch
npm start -- --tasnif
npm start -- --update
npm start -- --group 10
npm start -- --resume
npm start -- groups --json
npm start -- vat-rates --json
npm start -- vat --vat-id 4
npm start -- vat --vat-id 4 --group 10
```

Progress:

```sh
npm start -- status
```

Retry / reset:

```sh
npm start -- --retry-failed
npm start -- --retry-not-found
npm start -- --reset-all
npm start -- empty-db
```

## How resume works

Each product has a `status` in `data/products.db`:

| Status | Meaning |
| --- | --- |
| `pending` | Fetched from Regos, Tasnif lookup not done |
| `ready` | Tasnif data saved, waiting for a successful Regos update |
| `updated` | Regos `Item/Edit` completed successfully |
| `skipped` | Nothing to update for the current settings |
| `not_found` | No MXIK in Tasnif |
| `tasnif_failed` | Tasnif request error, retryable |
| `failed` | Regos update error, retryable |

A product is marked `updated` only after Regos returns success. If you stop the UI process, it finishes the current batch (or is force-stopped after a timeout). **Continue** skips fetch and resumes Tasnif / Regos update for `pending` / `ready` products in SQLite. **Full update** fetches the catalog again.

`--group <id>` limits fetch, Tasnif lookup, and Regos `Item/Edit` to that item group. Child groups are included when `includeChildGroups` is true. MXIK **empty_only** vs **all** still applies inside that scope. After upgrading, run **Fetch from Regos** once so products store `group_id`.

## VAT bulk update

`vat --vat-id <id>` writes that Regos TaxVat rate onto products via `Item/Edit`. It reads the live catalog (`Item/Get`), not SQLite MXIK status.

- `--group <id>` limits to that group; child groups are included when `includeChildGroups` is true
- Products that already have the target `vat.id` are skipped
- `skipDeleted` and `skipServices` from `settings.json` apply
- Use `vat-rates` to list enabled TaxVat ids (for example `1` is without VAT, `4` is often 12%)

## Manual ИКПУ and is_labeled

`icps --icps <code>` writes that ИКПУ (`icps`) onto products via `Item/Edit`. `labeled --labeled true|false` writes `is_labeled`. Both read the live catalog (`Item/Get`), not SQLite Tasnif status.

- `--group <id>` limits to that group; child groups are included when `includeChildGroups` is true
- Products that already have the target value are skipped
- `skipDeleted` and `skipServices` from `settings.json` apply
- The two commands are independent: one run writes only ИКПУ, the other only `is_labeled`

In the desktop UI: use **Ручное обновление** with the same group picker as MXIK / VAT.

## Tasnif lookup

For each product the tool:

1. Collects GTIN-shaped barcodes (8–14 digits) from `base_barcode` and `barcode_list`
2. Calls `GET /mxik/search/by-params?gtin=...`
3. If there is no barcode hit and the product already has `icps`, looks up that MXIK code
4. Stores `mxikCode` as a string (leading zeros are kept)
5. Treats Tasnif `label = 1` as labeled

## Logs

Daily files are written to `logs/log-DD-MM-YYYY.log`.
