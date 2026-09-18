import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT,
  fullname TEXT,
  articul TEXT,
  code INTEGER,
  type TEXT,
  icps TEXT,
  is_labeled INTEGER,
  group_id INTEGER,
  group_path TEXT,
  base_barcode TEXT,
  barcode_list TEXT,
  deleted_mark INTEGER NOT NULL DEFAULT 0,
  tasnif_mxik TEXT,
  tasnif_is_labeled INTEGER,
  tasnif_name TEXT,
  tasnif_barcode TEXT,
  tasnif_fetched_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export type AppDatabase = DatabaseSync;

interface ColumnInfo {
  name: string;
}

function ensureColumn(db: AppDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
  if (columns.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function openDatabase(filePath: string): AppDatabase {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    allowBareNamedParameters: true,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  ensureColumn(db, "products", "group_id", "group_id INTEGER");
  ensureColumn(db, "products", "group_path", "group_path TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_products_group_id ON products(group_id)");
  return db;
}
