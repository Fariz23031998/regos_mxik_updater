import type { AppDatabase } from "./database.js";
import type { ProductRow, ProductStatus, RegosItem, StatusCounts, TasnifMatch } from "../types.js";
import { nowIso } from "../utils.js";

interface CountRow {
  total: number | null;
  pending: number | null;
  ready: number | null;
  skipped: number | null;
  not_found: number | null;
  updated: number | null;
  failed: number | null;
  tasnif_failed: number | null;
}

function groupFilterSql(groupIds?: number[]): { sql: string; params: number[] } {
  if (!groupIds || groupIds.length === 0) return { sql: "", params: [] };
  const placeholders = groupIds.map(() => "?").join(", ");
  return { sql: ` AND group_id IN (${placeholders})`, params: groupIds };
}

function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

export class ProductRepository {
  constructor(private readonly db: AppDatabase) {}

  upsertFromRegos(items: RegosItem[]): { inserted: number; updated: number } {
    const select = this.db.prepare("SELECT id, status FROM products WHERE id = ?");
    const insert = this.db.prepare(`
      INSERT INTO products (
        id, name, fullname, articul, code, type, icps, is_labeled,
        group_id, group_path, base_barcode, barcode_list, deleted_mark, status, updated_at
      ) VALUES (
        @id, @name, @fullname, @articul, @code, @type, @icps, @is_labeled,
        @group_id, @group_path, @base_barcode, @barcode_list, @deleted_mark, 'pending', @updated_at
      )
    `);
    const update = this.db.prepare(`
      UPDATE products SET
        name = @name,
        fullname = @fullname,
        articul = @articul,
        code = @code,
        type = @type,
        icps = @icps,
        is_labeled = @is_labeled,
        group_id = @group_id,
        group_path = @group_path,
        base_barcode = @base_barcode,
        barcode_list = @barcode_list,
        deleted_mark = @deleted_mark,
        updated_at = @updated_at
      WHERE id = @id
    `);

    let inserted = 0;
    let updated = 0;
    const stamp = nowIso();

    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const row = {
          id: item.id,
          name: item.name ?? null,
          fullname: item.fullname ?? null,
          articul: item.articul ?? null,
          code: item.code ?? null,
          type: item.type ?? null,
          icps: item.icps?.toString() ?? null,
          is_labeled: boolToInt(item.is_labeled),
          group_id: item.group?.id ?? null,
          group_path: item.group?.path ?? item.group?.name ?? null,
          base_barcode: item.base_barcode ?? null,
          barcode_list: item.barcode_list ?? null,
          deleted_mark: item.deleted_mark ? 1 : 0,
          updated_at: stamp,
        };

        const existing = select.get(item.id) as unknown as { id: number; status: string } | undefined;
        if (existing) {
          update.run(row);
          updated += 1;
        } else {
          insert.run(row);
          inserted += 1;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { inserted, updated };
  }

  getByStatus(status: ProductStatus | ProductStatus[], limit = 200, groupIds?: number[]): ProductRow[] {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map(() => "?").join(", ");
    const group = groupFilterSql(groupIds);
    return this.db
      .prepare(
        `SELECT * FROM products WHERE status IN (${placeholders})${group.sql} ORDER BY id LIMIT ?`,
      )
      .all(...statuses, ...group.params, limit) as unknown as ProductRow[];
  }

  countByStatus(): StatusCounts {
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
          SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS not_found,
          SUM(CASE WHEN status = 'updated' THEN 1 ELSE 0 END) AS updated,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'tasnif_failed' THEN 1 ELSE 0 END) AS tasnif_failed
        FROM products
      `,
      )
      .get() as unknown as CountRow | undefined;

    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      ready: Number(row?.ready ?? 0),
      skipped: Number(row?.skipped ?? 0),
      not_found: Number(row?.not_found ?? 0),
      updated: Number(row?.updated ?? 0),
      failed: Number(row?.failed ?? 0),
      tasnif_failed: Number(row?.tasnif_failed ?? 0),
    };
  }

  saveTasnifResult(
    id: number,
    match: TasnifMatch | null,
    status: ProductStatus,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `
        UPDATE products SET
          tasnif_mxik = @tasnif_mxik,
          tasnif_is_labeled = @tasnif_is_labeled,
          tasnif_name = @tasnif_name,
          tasnif_barcode = @tasnif_barcode,
          tasnif_fetched_at = @tasnif_fetched_at,
          status = @status,
          last_error = @last_error,
          updated_at = @updated_at
        WHERE id = @id
      `,
      )
      .run({
        id,
        tasnif_mxik: match?.mxikCode ?? null,
        tasnif_is_labeled: match ? boolToInt(match.isLabeled) : null,
        tasnif_name: match?.name ?? null,
        tasnif_barcode: match?.barcode ?? null,
        tasnif_fetched_at: nowIso(),
        status,
        last_error: error,
        updated_at: nowIso(),
      });
  }

  markStatus(ids: number[], status: ProductStatus, error: string | null = null): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `
        UPDATE products
        SET status = ?, last_error = ?, updated_at = ?
        WHERE id IN (${placeholders})
      `,
      )
      .run(status, error, nowIso(), ...ids);
  }

  markUpdated(ids: number[]): void {
    this.markStatus(ids, "updated", null);
  }

  resetRetryable(groupIds?: number[]): number {
    const group = groupFilterSql(groupIds);
    const result = this.db
      .prepare(
        `
        UPDATE products
        SET status = CASE
          WHEN status = 'failed' THEN 'ready'
          WHEN status = 'tasnif_failed' THEN 'pending'
          ELSE status
        END,
        last_error = NULL,
        updated_at = ?
        WHERE status IN ('failed', 'tasnif_failed')${group.sql}
      `,
      )
      .run(nowIso(), ...group.params);
    return changesOf(result);
  }

  resetAllProgress(): number {
    const result = this.db
      .prepare(
        `
        UPDATE products SET
          tasnif_mxik = NULL,
          tasnif_is_labeled = NULL,
          tasnif_name = NULL,
          tasnif_barcode = NULL,
          tasnif_fetched_at = NULL,
          status = 'pending',
          last_error = NULL,
          updated_at = ?
      `,
      )
      .run(nowIso());
    return changesOf(result);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      )
      .run(key, value);
  }

  emptyDatabase(): number {
    const count = Number(
      (this.db.prepare("SELECT COUNT(*) AS total FROM products").get() as unknown as { total: number } | undefined)
        ?.total ?? 0,
    );
    this.db.exec("DELETE FROM products");
    this.db.exec("DELETE FROM meta");
    return count;
  }
}
