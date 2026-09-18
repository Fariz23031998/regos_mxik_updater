import type { RegosItem } from "../types.js";
import { sleep, withRetry } from "../utils.js";
import { RegosApiError, type RegosClient } from "./client.js";

export interface ItemEditPayload {
  id: number;
  icps?: string;
  is_labeled?: boolean;
  vat_id?: number;
}

export interface BatchItemResult {
  key: string;
  id: number;
  ok: boolean;
  error?: string;
}

interface BatchResponseItem {
  key?: string;
  ok?: boolean;
  result?: {
    row_affected?: number;
    error?: string | number;
    description?: string;
  };
}

export interface ItemGetOptions {
  pageSize: number;
  delayMs: number;
  groupIds?: number[];
}

export class RegosItemsApi {
  constructor(
    private readonly client: RegosClient,
    private readonly maxRetries = 3,
  ) {}

  async *fetchAllPages(options: ItemGetOptions): AsyncGenerator<RegosItem[], void, void> {
    const { pageSize, delayMs, groupIds } = options;
    let offset = 0;
    const body: Record<string, unknown> = {
      limit: pageSize,
      offset,
    };
    if (groupIds && groupIds.length > 0) {
      body.filters = [
        {
          Field: "group_id",
          Operator: "In",
          Value: groupIds.join(","),
        },
      ];
    }

    while (true) {
      body.offset = offset;
      const response = await withRetry(
        () => this.client.post<RegosItem[]>("Item/Get", body),
        {
          retries: this.maxRetries,
          delayMs: Math.max(500, delayMs),
          shouldRetry: (error) => error instanceof RegosApiError && error.retryable,
        },
      );

      const batch = Array.isArray(response.result) ? response.result : [];
      if (batch.length === 0) {
        break;
      }

      yield batch;

      const nextOffset = response.next_offset;
      if (nextOffset !== null && nextOffset !== undefined && Number(nextOffset) > offset) {
        offset = Number(nextOffset);
      } else if (batch.length >= pageSize) {
        offset += batch.length;
      } else {
        break;
      }

      await sleep(delayMs);
    }
  }

  async editBatch(payloads: ItemEditPayload[], delayMs: number): Promise<BatchItemResult[]> {
    if (payloads.length === 0) return [];

    const request = {
      stop_on_error: false,
      requests: payloads.map((payload) => ({
        key: `ItemEdit_${payload.id}`,
        path: "Item/Edit",
        payload,
      })),
    };

    const response = await this.client.post<BatchResponseItem[] | { responses?: BatchResponseItem[] }>(
      "batch",
      request,
    );

    await sleep(delayMs);

    const items = Array.isArray(response.result)
      ? response.result
      : Array.isArray(response.result?.responses)
        ? response.result.responses
        : [];

    if (items.length === 0) {
      throw new RegosApiError(
        "Regos batch response did not include per-item results; products were not marked updated",
        200,
        "empty_batch",
        true,
      );
    }

    return payloads.map((payload) => {
      const key = `ItemEdit_${payload.id}`;
      const item = items.find((entry) => entry.key === key);
      if (!item) {
        return { key, id: payload.id, ok: false, error: "Missing batch result for item" };
      }
      if (item.ok === false) {
        const code = item.result?.error ?? "Unknown";
        const description = item.result?.description ?? "Unknown error";
        return { key, id: payload.id, ok: false, error: `${code} - ${description}` };
      }
      return { key, id: payload.id, ok: true };
    });
  }
}
