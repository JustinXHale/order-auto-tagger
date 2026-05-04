import type { TagRule } from "@prisma/client";

/** Minimal REST order payload fields used from orders/create webhook */
export type OrderWebhookPayload = {
  id?: number | string;
  created_at?: string;
  line_items?: Array<{ product_id?: number | string | null }>;
};

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function parseProductIdsFromPayload(payload: OrderWebhookPayload): Set<string> {
  const ids = new Set<string>();
  for (const line of payload.line_items ?? []) {
    const pid = line.product_id;
    if (pid != null && pid !== "" && Number(pid) !== 0) {
      ids.add(String(pid));
    }
  }
  return ids;
}

/**
 * A rule matches when:
 * - enabled
 * - order created_at is within [startsAt, endsAt] (inclusive; null bound = open)
 * - at least one line item product_id is in rule.productIds
 */
export function evaluateTagRules(
  order: OrderWebhookPayload,
  rules: TagRule[],
): string[] {
  const orderCreated = order.created_at
    ? new Date(order.created_at)
    : new Date();
  if (Number.isNaN(orderCreated.getTime())) {
    return [];
  }

  const lineProductIds = parseProductIdsFromPayload(order);
  const tagSet = new Set<string>();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.startsAt && orderCreated < rule.startsAt) continue;
    if (rule.endsAt && orderCreated > rule.endsAt) continue;

    const ruleProductIds = new Set(parseJsonArray(rule.productIds));
    if (ruleProductIds.size === 0) continue;

    let anyMatch = false;
    for (const pid of lineProductIds) {
      if (ruleProductIds.has(pid)) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) continue;

    for (const t of parseJsonArray(rule.tags)) {
      const trimmed = t.trim();
      if (trimmed) tagSet.add(trimmed);
    }
  }

  return Array.from(tagSet);
}

export function orderGidFromRestId(orderId: number): string {
  return `gid://shopify/Order/${orderId}`;
}
