import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

// ── GraphQL types ────────────────────────────────────────────────────────────

// Shopify Admin GraphQL uses `customAttributes` (key/value) on LineItem, not `properties`
type GqlAttribute = { key: string; value: string };

type GqlLineItem = {
  title: string;
  quantity: number;
  variant: { title: string } | null;
  customAttributes: GqlAttribute[];
};

type GqlOrder = {
  id: string;
  name: string;
  createdAt: string;
  note: string | null;
  email: string | null;
  billingAddress: { firstName: string; lastName: string } | null;
  lineItems: { edges: Array<{ node: GqlLineItem }> };
};

type GqlOrdersResponse = {
  data?: {
    orders?: {
      edges: Array<{ cursor: string; node: GqlOrder }>;
      pageInfo: { hasNextPage: boolean };
    };
  };
};

export type FixedColumnKey = "order" | "customer" | "email" | "product" | "variant" | "qty" | "note";

const FIXED_LABELS: Record<FixedColumnKey, string> = {
  order: "Order #",
  customer: "Customer Name",
  email: "Email",
  product: "Product",
  variant: "Variant",
  qty: "Qty",
  note: "Order Note",
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

function parsePropertyWhitelist(raw: string): string[] | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function discoverPropertyNames(orders: GqlOrder[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    for (const { node: li } of order.lineItems.edges) {
      for (const attr of li.customAttributes) {
        if (!seen.has(attr.key)) {
          seen.add(attr.key);
          names.push(attr.key);
        }
      }
    }
  }
  return names;
}

function resolvePropertyColumns(
  discovered: string[],
  whitelist: string[] | null,
): string[] {
  if (!whitelist) return discovered;
  const set = new Set(discovered);
  const out: string[] = [];
  for (const name of whitelist) {
    if (set.has(name)) out.push(name);
  }
  return out;
}

function buildCsv(
  orders: GqlOrder[],
  fixed: Record<FixedColumnKey, boolean>,
  propNames: string[],
): string {
  const fixedKeys = (
    Object.entries(fixed) as [FixedColumnKey, boolean][]
  ).filter(([, on]) => on);

  if (fixedKeys.length === 0 && propNames.length === 0) {
    return "";
  }

  const headers: string[] = [
    ...fixedKeys.map(([k]) => FIXED_LABELS[k]),
    ...propNames,
  ];
  const rows: string[][] = [headers];

  for (const order of orders) {
    const customerName = order.billingAddress
      ? `${order.billingAddress.firstName} ${order.billingAddress.lastName}`.trim()
      : "";

    for (const { node: li } of order.lineItems.edges) {
      const propMap = new Map(li.customAttributes.map((a) => [a.key, a.value]));
      const variantTitle =
        li.variant?.title && li.variant.title !== "Default Title"
          ? li.variant.title
          : "";

      const fixedValues: Record<FixedColumnKey, string> = {
        order: order.name,
        customer: customerName,
        email: order.email ?? "",
        product: li.title,
        variant: variantTitle,
        qty: "1",
        note: order.note ?? "",
      };

      const fixedCols = fixedKeys.map(([k]) => fixedValues[k]);
      const propCols = propNames.map((n) => propMap.get(n) ?? "");
      const baseRow = [...fixedCols, ...propCols];

      for (let i = 0; i < li.quantity; i++) {
        rows.push(baseRow);
      }
    }
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rules = await db.tagRule.findMany({
    where: { shop: session.shop, enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { name: true, tags: true },
  });

  const tagSuggestions: string[] = [];
  for (const rule of rules) {
    try {
      const parsed = JSON.parse(rule.tags) as unknown;
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          if (typeof t === "string" && t.trim()) tagSuggestions.push(t.trim());
        }
      }
    } catch {
      // ignore
    }
  }

  return { tagSuggestions: [...new Set(tagSuggestions)] };
};

// ── Action ────────────────────────────────────────────────────────────────────

export type ExportActionData =
  | { ok: true; csv: string; filename: string }
  | { ok: false; error: string };

function parseBool(v: FormDataEntryValue | null): boolean {
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "on" || s === "1";
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ExportActionData> => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const tagFilter = String(formData.get("tag") ?? "").trim();
  const startDate = String(formData.get("startDate") ?? "").trim();
  const endDate = String(formData.get("endDate") ?? "").trim();
  const propertyFilterRaw = String(formData.get("propertyFilter") ?? "");

  const fixed: Record<FixedColumnKey, boolean> = {
    order: parseBool(formData.get("includeOrder")),
    customer: parseBool(formData.get("includeCustomer")),
    email: parseBool(formData.get("includeEmail")),
    product: parseBool(formData.get("includeProduct")),
    variant: parseBool(formData.get("includeVariant")),
    qty: parseBool(formData.get("includeQty")),
    note: parseBool(formData.get("includeNote")),
  };

  // Defaults: if nothing sent (old clients), treat as all true except note/email
  const anyFixedSent =
    formData.has("includeOrder") ||
    formData.has("includeCustomer") ||
    formData.has("includeEmail") ||
    formData.has("includeProduct") ||
    formData.has("includeVariant") ||
    formData.has("includeQty") ||
    formData.has("includeNote");

  if (!anyFixedSent) {
    fixed.order = true;
    fixed.customer = true;
    fixed.email = false;
    fixed.product = true;
    fixed.variant = true;
    fixed.qty = true;
    fixed.note = false;
  }

  const whitelist = parsePropertyWhitelist(propertyFilterRaw);

  const queryParts: string[] = [];
  if (tagFilter) queryParts.push(`tag:${tagFilter}`);
  if (startDate) queryParts.push(`created_at:>=${startDate}`);
  if (endDate) queryParts.push(`created_at:<=${endDate}`);
  const queryString = queryParts.join(" ") || undefined;

  const allOrders: GqlOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const res = await admin.graphql(
      `#graphql
        query ExportOrders($first: Int!, $after: String, $query: String) {
          orders(first: $first, after: $after, query: $query) {
            edges {
              cursor
              node {
                id
                name
                createdAt
                note
                email
                billingAddress { firstName lastName }
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      variant { title }
                      customAttributes { key value }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }`,
      {
        variables: {
          first: 50,
          ...(cursor ? { after: cursor } : {}),
          ...(queryString ? { query: queryString } : {}),
        },
      },
    );

    const body = (await res.json()) as GqlOrdersResponse;
    const edges = body?.data?.orders?.edges ?? [];
    hasNextPage = body?.data?.orders?.pageInfo?.hasNextPage ?? false;

    for (const edge of edges) {
      cursor = edge.cursor;
      allOrders.push(edge.node);
    }
  }

  const discovered = discoverPropertyNames(allOrders);
  const propColumns = resolvePropertyColumns(discovered, whitelist);

  const hasFixed = Object.values(fixed).some(Boolean);
  if (!hasFixed && propColumns.length === 0) {
    return {
      ok: false,
      error:
        "Select at least one column (fixed fields or OPTIS fields), or clear the OPTIS whitelist to include all custom fields.",
    };
  }

  const csv = buildCsv(allOrders, fixed, propColumns);
  const filename = tagFilter
    ? `orders-${tagFilter}.csv`
    : "orders-export.csv";

  return { ok: true, csv, filename };
};

// ── UI ────────────────────────────────────────────────────────────────────────

export default function ExportPage() {
  const { tagSuggestions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ExportActionData>();
  const shopify = useAppBridge();
  const outcomeHandledRef = useRef(false);

  const [tag, setTag] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");

  const [includeOrder, setIncludeOrder] = useState(true);
  const [includeCustomer, setIncludeCustomer] = useState(true);
  const [includeEmail, setIncludeEmail] = useState(false);
  const [includeProduct, setIncludeProduct] = useState(true);
  const [includeVariant, setIncludeVariant] = useState(true);
  const [includeQty, setIncludeQty] = useState(true);
  const [includeNote, setIncludeNote] = useState(false);

  const isExporting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "submitting") {
      outcomeHandledRef.current = false;
    }
  }, [fetcher.state]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data;
    if (!data || outcomeHandledRef.current) return;
    outcomeHandledRef.current = true;

    if (data.ok === true) {
      const blob = new Blob([data.csv], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      shopify.toast.show("CSV downloaded");
      return;
    }

    if (data.error) {
      shopify.toast.show(data.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const runExport = () => {
    fetcher.submit(
      {
        tag,
        startDate,
        endDate,
        propertyFilter,
        includeOrder: includeOrder ? "true" : "false",
        includeCustomer: includeCustomer ? "true" : "false",
        includeEmail: includeEmail ? "true" : "false",
        includeProduct: includeProduct ? "true" : "false",
        includeVariant: includeVariant ? "true" : "false",
        includeQty: includeQty ? "true" : "false",
        includeNote: includeNote ? "true" : "false",
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading="Export orders">
      <s-section heading="Filters">
        <s-paragraph>
          Filter which orders to include. Use columns below to choose what
          appears in the CSV. Leave OPTIS whitelist blank to include every
          custom field discovered in that export.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small">
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Tag (optional)</span>
              <input
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. 2026-woodlands-summer7s — blank = all orders"
                autoComplete="off"
                style={{ padding: "8px", maxWidth: 480 }}
              />
            </label>
            {tagSuggestions.length > 0 && (
              <s-stack direction="inline" gap="small">
                <s-text color="subdued">
                  Quick fill:
                </s-text>
                {tagSuggestions.map((t) => (
                  <s-button
                    key={t}
                    type="button"
                    onClick={() => setTag(t)}
                  >
                    {t}
                  </s-button>
                ))}
              </s-stack>
            )}
          </s-stack>

          <s-stack direction="inline" gap="base">
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Start date (optional)</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{ padding: "8px" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>End date (optional)</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{ padding: "8px" }}
              />
            </label>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Columns to export">
        <s-paragraph color="subdued">
          Uncheck fields you don&apos;t need. OPTIS line-item properties are
          listed in the next section.
        </s-paragraph>
        <s-stack direction="block" gap="small">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeOrder}
              onChange={(e) => setIncludeOrder(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.order}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeCustomer}
              onChange={(e) => setIncludeCustomer(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.customer}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeEmail}
              onChange={(e) => setIncludeEmail(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.email}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeProduct}
              onChange={(e) => setIncludeProduct(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.product}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeVariant}
              onChange={(e) => setIncludeVariant(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.variant}</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeQty}
              onChange={(e) => setIncludeQty(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.qty} (always 1 per row when expanded)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={includeNote}
              onChange={(e) => setIncludeNote(e.target.checked)}
              disabled={isExporting}
            />
            <span>{FIXED_LABELS.note}</span>
          </label>
        </s-stack>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 12,
          }}
        >
          <span>OPTIS fields whitelist (optional)</span>
          <input
            type="text"
            value={propertyFilter}
            onChange={(e) => setPropertyFilter(e.target.value)}
            placeholder="Comma-separated: Team Name, Jersey Number — leave blank for ALL fields"
            autoComplete="off"
            disabled={isExporting}
            style={{ padding: "8px", maxWidth: 560 }}
          />
        </label>

        <s-stack direction="inline" gap="small">
          <s-button
            type="button"
            variant="primary"
            onClick={runExport}
            disabled={isExporting}
          >
            {isExporting ? "Generating CSV…" : "Download CSV"}
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Choose filters to limit which orders are fetched. Without a tag or
            dates, every order in the store is included (large exports).
          </s-paragraph>
          <s-paragraph>
            Pick columns above so the CSV only contains what you need for Google
            Sheets or your factory form.
          </s-paragraph>
          <s-paragraph>
            OPTIS custom fields: leave the whitelist blank to auto-include every
            property name found in the filtered orders; or list only the names
            you want as columns.
          </s-paragraph>
          <s-paragraph>
            Quantity &gt; 1 is expanded to one row per unit (Qty column shows{" "}
            <s-text type="strong">1</s-text> per row).
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
