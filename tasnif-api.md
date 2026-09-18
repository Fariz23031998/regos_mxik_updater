# Tasnif (MXIK / IKPU) API

Public product classification API from [tasnif.soliq.uz](https://tasnif.soliq.uz).

**Base URL:** `https://tasnif.soliq.uz/api/cls-api`  
**npm client:** [`mxik`](https://www.npmjs.com/package/mxik) (`^1.1.7`)  
**Admin wrapper:** `admin/src/api/mxik.ts`  
**API client (bulk jobs):** `api/app/services/tasnif.py`

Interactive search/create in admin still calls Tasnif **from the browser** (no API key).  
Bulk **Update IKPU** on the products list runs as a **backend background job** (`POST /api/v1/admin/products/ikpu-jobs`) and notifies the admin via SSE when finished.

## Install

```sh
cd admin && npm i mxik
```

## Project helpers

Prefer these wrappers over using `MxikClient` directly:

| Function | File | Purpose |
|----------|------|---------|
| `searchMxik(q)` | `admin/src/api/mxik.ts` | Search by barcode, IKPU, or name; enriches with photos + first package |
| `listMxikPackages(mxikCode)` | `admin/src/api/mxik.ts` | Package codes/names for an IKPU |
| `mxikItemToPrefill(item)` | `admin/src/api/mxik.ts` | Map a search hit to product create prefill |
| `ensureMxikPackageList(ikpu)` | `admin/src/lib/mxikPackageCodes.ts` | Cached package list for the name picker |
| `TasnifClient.lookup_by_barcode` | `api/app/services/tasnif.py` | Server-side barcode → IKPU + first package + marked (bulk job) |

```ts
import { searchMxik, listMxikPackages, mxikItemToPrefill } from "../api/mxik";

const { query_type, items } = await searchMxik("06111001018000000");
const prefill = mxikItemToPrefill(items[0]);

const { items: packages } = await listMxikPackages(prefill.ikpu);
```

## Query detection (`searchMxik`)

| Input | Treated as | Client call |
|-------|------------|-------------|
| Digits, length ≥ 15 | IKPU / MXIK | `mxik.params({ mxikCode })` |
| Digits, length 8–14 | Barcode (GTIN) | `mxik.barcode(...)` |
| Anything else | Name | `mxik.search(...)` |

## Bulk IKPU update (backend)

1. Admin chooses mode: `missing_ikpu` or `all`.
2. API inserts a `product_jobs` row (`kind=ikpu-from-tasnif`) and runs `run_ikpu_from_tasnif_job` in the background.
3. For each candidate product, barcodes are tried in API list order (GTIN-shaped only); first valid IKPU wins; base unit `package_code` is set when Tasnif returns a package; `marked` is set from Tasnif `label` (`1` ⇒ marked), same as create-from-Tasnif.
4. On completion, SSE `product_jobs.updated` triggers an admin toast.

## IKPU

Always keep IKPU as a **digit string**. Do not convert with `Number(...)` — that drops leading zeros (e.g. `06111…` → `6111…`).

Store and send the value exactly as Tasnif returns it (`mxikCode`).

## Packages & unit inference

Package types come from history lookup (`mxik.code` / `GET /integration-mxik/get/history/{mxikCode}` → `packageNames`).

Tasnif display language (Uzbek / Russian / Latin) is chosen in **admin main settings** (Product settings) and stored in localStorage. Package name pickers use that language.

When creating a product, unit name is resolved as:

1. Use `unitName` from Tasnif if present  
2. Else if package name contains `шт` → `шт`  
3. Else if package name contains `килограмм` or `кг` → `кг`  
4. Else → `шт`

## Photos

```
GET /integration-mxik/references/get/mxik/picture-names?lang=ru&mxik_code=<IKPU>
→ filenames
→ https://tasnif.soliq.uz/api/cls-api/integration-mxik/references/get/file/<filename>
```

`searchMxik` already attaches `photoUrl` / `photoUrls` when available.

## Direct `MxikClient` (optional)

```ts
import { MxikClient } from "mxik";

const mxik = new MxikClient();
await mxik.search("Футболка");
await mxik.barcode("4780022622461");
await mxik.code("06111001018000000"); // includes packageNames
```

HTTP paths used by `mxik` (and the Python client):

- Barcode: `GET /mxik/search/by-params?gtin=…`
- History/packages: `GET /integration-mxik/get/history/{mxikCode}`

More detail: [mxik-js on GitHub](https://github.com/azabroflovski/mxik-js).
