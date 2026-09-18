import type { RegosItemGroup } from "../types.js";
import { RegosApiError, type RegosClient } from "./client.js";

interface GroupFilter {
  Field: string;
  Operator: string;
  Value: string;
}

function uniqueGroups(groups: RegosItemGroup[]): RegosItemGroup[] {
  const map = new Map<number, RegosItemGroup>();
  for (const group of groups) {
    if (Number.isInteger(group.id) && group.id > 0) {
      map.set(group.id, group);
    }
  }
  return [...map.values()].sort((a, b) =>
    (a.path || a.name || "").localeCompare(b.path || b.name || "", "ru", { numeric: true }),
  );
}

export class RegosGroupsApi {
  constructor(private readonly client: RegosClient) {}

  async listAll(): Promise<RegosItemGroup[]> {
    return this.fetch([]);
  }

  async getById(id: number): Promise<RegosItemGroup | undefined> {
    const groups = await this.fetch([
      { Field: "id", Operator: "Equal", Value: String(id) },
    ]);
    return groups.find((group) => group.id === id);
  }

  async search(query: string): Promise<RegosItemGroup[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (/^\d+$/.test(trimmed)) {
      return this.fetch([{ Field: "id", Operator: "Equal", Value: trimmed }]);
    }

    const [byName, byPath] = await Promise.all([
      this.fetch([{ Field: "name", Operator: "Like", Value: trimmed }]),
      this.fetch([{ Field: "path", Operator: "Like", Value: trimmed }]),
    ]);
    return uniqueGroups([...byName, ...byPath]);
  }

  private async fetch(filters: GroupFilter[]): Promise<RegosItemGroup[]> {
    const body = filters.length > 0 ? { filters } : {};
    const response = await this.client.post<RegosItemGroup[]>("ItemGroup/Get", body);
    const groups = Array.isArray(response.result) ? response.result : [];
    return uniqueGroups(groups);
  }
}

export function resolveGroupTree(groups: RegosItemGroup[], rootId: number): number[] {
  const children = new Map<number, number[]>();
  for (const group of groups) {
    const parent = group.parent_id ?? 0;
    const list = children.get(parent) ?? [];
    list.push(group.id);
    children.set(parent, list);
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const child of children.get(id) ?? []) {
      stack.push(child);
    }
  }
  return ids.sort((a, b) => a - b);
}

export async function resolveGroupIds(
  groupsApi: RegosGroupsApi,
  groupId: number,
  includeChildGroups = true,
): Promise<number[]> {
  if (!includeChildGroups) {
    const group = await groupsApi.getById(groupId);
    if (!group) {
      throw new RegosApiError(`Regos item group ${groupId} was not found`, 200, "group_not_found", false);
    }
    return [groupId];
  }

  const groups = await groupsApi.listAll();
  const ids = resolveGroupTree(groups, groupId);
  if (!groups.some((group) => group.id === groupId) && ids.length === 1) {
    throw new RegosApiError(`Regos item group ${groupId} was not found`, 200, "group_not_found", false);
  }
  return ids;
}
