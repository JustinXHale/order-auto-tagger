import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

// ── GraphQL types ────────────────────────────────────────────────────────────

type GqlProperty = { name: string; value: string };

type GqlLineItem = {
  title: string;
  quantity: number;
  variant: { title: string } | null;
  properties: GqlProperty[];
};

type GqlOrder = {
  id: string;
  name: string;
  createdAt: string;
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

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

function buildCsv(orders: GqlOrder[]): string {
  // First pass: collect all unique property names in order of first appearance
  const propNames: string[] = [];
  const propSet = new Set<string>();
  for (const order of orders) {
    for (const { node: li } of order.lineItems.edges) {
      for (const prop of li.properties) {
        if (!propSet.has(prop.name)) {
          propSet.add(prop.name);
          propNames.push(prop.name);
        }
      }
    }
  }

  const fixedHeaders = ["Order #", "Customer Name", "Product", "Variant", "Qty"];
  const allHeaders = [...fixedHeaders, ...propNames];
  const rows: string[][] = [allHeaders];

  for (const order of orders) {
    const customerName = order.billingAddress
      ? `${order.billingAddress.firstName} ${order.billingAddress.lastName}`.trim()
      : "";

    for (const { node: li } of order.lineItems.edges) {
      const propMap = new Map(li.properties.map((p) => [p.name, p.value]));
      const variantTitle =
        li.variant?.title && li.variant.title !== "Default Title"
          ? li.variant.title
          : "";

      const fixedCols = [
        order.name,
        customerName,
        li.title,
        variantTitle,
        "1", // always 1 — qty expanded to individual rows
      ];
      const propCols = propNames.map((n) => propMap.get(n) ?? "");
      const baseRow = [...fixedCols, ...propCols];

      // Expand quantity — one row per unit
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

  // Suggest tag values from existing rules so the user can pick one quickly
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const tagFilter = String(formData.get("tag") ?? "").trim();
  const startDate = String(formData.get("startDate") ?? "").trim();
  const endDate = String(formData.get("endDate") ?? "").trim();

  // Build Shopify order search query string
  const queryParts: string[] = [];
  if (tagFilter) queryParts.push(`tag:${tagFilter}`);
  if (startDate) queryParts.push(`created_at:>=${startDate}`);
  if (endDate) queryParts.push(`created_at:<=${endDate}`);
  const queryString = queryParts.join(" ") || undefined;

  // Paginate through all matching orders
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
                billingAddress { firstName lastName }
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      variant { title }
                      properties { name value }
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

  const csv = buildCsv(allOrders);
  const filename = tagFilter
    ? `orders-${tagFilter}.csv`
    : "orders-export.csv";

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};

// ── UI ────────────────────────────────────────────────────────────────────────

export default function ExportPage() {
  const { tagSuggestions } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isExporting = navigation.state === "submitting";

  const [tag, setTag] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  return (
    <s-page heading="Export orders">
      <s-section heading="Filters">
        <s-paragraph>
          Filter orders before exporting. All fields are optional — leaving them
          blank exports every order. The CSV expands quantities so each unit is
          its own row, and OPTIS custom fields appear as individual columns.
        </s-paragraph>

        <form method="post" action="/app/export">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small">
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Tag (e.g. 2026-woodlands-summer7s)</span>
                <input
                  type="text"
                  name="tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder="Leave blank to export all orders"
                  autoComplete="off"
                  style={{ padding: "8px", maxWidth: 480 }}
                />
              </label>
              {tagSuggestions.length > 0 && (
                <s-stack direction="inline" gap="small">
                  <s-text color="subdued" size="small">
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
                  name="startDate"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{ padding: "8px" }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>End date (optional)</span>
                <input
                  type="date"
                  name="endDate"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={{ padding: "8px" }}
                />
              </label>
            </s-stack>

            <s-button
              type="submit"
              variant="primary"
              disabled={isExporting}
            >
              {isExporting ? "Generating CSV…" : "Download CSV"}
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            The CSV always includes: <s-text type="strong">Order #</s-text>,{" "}
            <s-text type="strong">Customer Name</s-text>,{" "}
            <s-text type="strong">Product</s-text>,{" "}
            <s-text type="strong">Variant</s-text>, and{" "}
            <s-text type="strong">Qty</s-text>.
          </s-paragraph>
          <s-paragraph>
            OPTIS custom fields (line item properties) are discovered
            automatically and each appears as its own column.
          </s-paragraph>
          <s-paragraph>
            Orders with quantity &gt; 1 are expanded — one row per unit —
            so each row represents a single item ready for your factory form.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
