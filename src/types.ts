export type MxikUpdateMode = "all" | "empty_only" | "none";

export type ProductStatus =
  | "pending"
  | "ready"
  | "skipped"
  | "not_found"
  | "updated"
  | "failed"
  | "tasnif_failed";

export interface Settings {
  mxikUpdateMode: MxikUpdateMode;
  updateIsLabeled: boolean;
  skipDeleted: boolean;
  skipServices: boolean;
  groupId: number | null;
  includeChildGroups: boolean;
  pageSize: number;
  tasnifDelayMs: number;
  tasnifConcurrency: number;
  regosDelayMs: number;
  regosBatchSize: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface EnvConfig {
  integrationToken: string;
  clientId: string | null;
  clientSecret: string | null;
  authUrl: string;
  apiBase: string;
  useOAuth: boolean;
}

export interface Secrets {
  integrationToken: string;
  clientId: string;
  clientSecret: string;
  authUrl: string;
  apiBase: string;
}

export interface AppConfig {
  env: EnvConfig;
  settings: Settings;
  paths: {
    settingsFile: string;
    databaseFile: string;
    logsDir: string;
  };
}

export interface RegosItemGroup {
  id: number;
  parent_id?: number | null;
  path?: string | null;
  name?: string | null;
  child_count?: number | null;
}

export interface RegosTaxVat {
  id: number;
  value?: number | null;
  name?: string | null;
  enabled?: boolean | null;
}

export interface RegosItem {
  id: number;
  name?: string | null;
  fullname?: string | null;
  articul?: string | null;
  code?: number | null;
  type?: string | null;
  icps?: string | null;
  is_labeled?: boolean | null;
  base_barcode?: string | null;
  barcode_list?: string | null;
  deleted_mark?: boolean | null;
  vat?: {
    id?: number | null;
    name?: string | null;
    value?: number | null;
    enabled?: boolean | null;
  } | null;
  group?: {
    id?: number | null;
    name?: string | null;
    path?: string | null;
    parent_id?: number | null;
  } | null;
}

export interface ProductRow {
  id: number;
  name: string | null;
  fullname: string | null;
  articul: string | null;
  code: number | null;
  type: string | null;
  icps: string | null;
  is_labeled: number | null;
  group_id: number | null;
  group_path: string | null;
  base_barcode: string | null;
  barcode_list: string | null;
  deleted_mark: number;
  tasnif_mxik: string | null;
  tasnif_is_labeled: number | null;
  tasnif_name: string | null;
  tasnif_barcode: string | null;
  tasnif_fetched_at: string | null;
  status: ProductStatus;
  last_error: string | null;
  updated_at: string | null;
}

export interface TasnifMatch {
  mxikCode: string;
  isLabeled: boolean;
  name: string | null;
  barcode: string | null;
}

export interface StatusCounts {
  total: number;
  pending: number;
  ready: number;
  skipped: number;
  not_found: number;
  updated: number;
  failed: number;
  tasnif_failed: number;
}
