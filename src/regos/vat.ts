import type { RegosTaxVat } from "../types.js";
import type { RegosClient } from "./client.js";

export class RegosVatApi {
  constructor(private readonly client: RegosClient) {}

  async listEnabled(): Promise<RegosTaxVat[]> {
    const response = await this.client.post<RegosTaxVat[]>("TaxVat/Get", {
      filters: [
        {
          Field: "enabled",
          Operator: "Equal",
          Value: "true",
        },
      ],
    });
    const rates = Array.isArray(response.result) ? response.result : [];
    return rates.filter((rate) => Number.isInteger(rate.id) && rate.id > 0);
  }

  async getById(id: number): Promise<RegosTaxVat | undefined> {
    const rates = await this.listEnabled();
    return rates.find((rate) => rate.id === id);
  }
}

export function formatVatLabel(rate: RegosTaxVat): string {
  const name = rate.name?.trim();
  if (name) return `${rate.id} — ${name}`;
  if (rate.value === -1) return `${rate.id} — Without VAT`;
  if (rate.value !== null && rate.value !== undefined) return `${rate.id} — ${rate.value}%`;
  return `VAT ${rate.id}`;
}
