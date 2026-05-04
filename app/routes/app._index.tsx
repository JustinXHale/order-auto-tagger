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
import { evaluateTagRules } from "../lib/evaluateTagRules";

export type RuleRow = {
  id: string;
  name: string | null;
  tags: string;
  productIds: string;
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rules = await db.tagRule.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
  });
  return {
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      tags: r.tags,
      productIds: r.productIds,
      startsAt: r.startsAt?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      enabled: r.enabled,
    })) satisfies RuleRow[],
  };
};

function tagsToCommaList(tagsJson: string): string {
  try {
    const arr = JSON.parse(tagsJson) as unknown;
    if (Array.isArray(arr)) {
      return arr.filter((x): x is string => typeof x === "string").join(", ");
    }
  } catch {
    /* ignore */
  }
  return "";
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "backfill") {
    const rules = await db.tagRule.findMany({ where: { shop, enabled: true } });
    if (rules.length === 0) {
      return { ok: true as const, backfill: { processed: 0, tagged: 0 } };
    }

    let cursor: string | null = null;
    let hasNextPage = true;
    let processed = 0;
    let tagged = 0;

    while (hasNextPage) {
      const res = await admin.graphql(
        `#graphql
          query BackfillOrders($first: Int!, $after: String) {
            orders(first: $first, after: $after) {
              edges {
                cursor
                node {
                  id
                  createdAt
                  lineItems(first: 50) {
                    edges {
                      node {
                        product { id }
                      }
                    }
                  }
                }
              }
              pageInfo { hasNextPage }
            }
          }`,
        { variables: { first: 50, ...(cursor ? { after: cursor } : {}) } },
      );

      const body = (await res.json()) as {
        data?: {
          orders?: {
            edges: Array<{
              cursor: string;
              node: {
                id: string;
                createdAt: string;
                lineItems: {
                  edges: Array<{ node: { product: { id: string } | null } }>;
                };
              };
            }>;
            pageInfo: { hasNextPage: boolean };
          };
        };
      };

      const edges = body?.data?.orders?.edges ?? [];
      hasNextPage = body?.data?.orders?.pageInfo?.hasNextPage ?? false;

      for (const edge of edges) {
        cursor = edge.cursor;
        const node = edge.node;
        processed++;

        const payload = {
          id: node.id,
          created_at: node.createdAt,
          line_items: node.lineItems.edges.map((li) => ({
            product_id: li.node.product?.id
              ? li.node.product.id.replace("gid://shopify/Product/", "")
              : null,
          })),
        };

        const tags = evaluateTagRules(payload, rules);
        if (tags.length > 0) {
          await admin.graphql(
            `#graphql
              mutation BackfillTagsAdd($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  userErrors { field message }
                }
              }`,
            { variables: { id: node.id, tags } },
          );
          tagged++;
        }
      }
    }

    return { ok: true as const, backfill: { processed, tagged } };
  }

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    if (!id) {
      return { ok: false as const, error: "Missing rule id" };
    }
    await db.tagRule.deleteMany({ where: { id, shop } });
    return { ok: true as const };
  }

  const tags = parseTagsInput(String(formData.get("tags") ?? ""));
  let productIds: string[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("productIds") ?? "[]"));
    if (Array.isArray(parsed)) {
      productIds = parsed.map((x) => String(x)).filter(Boolean);
    }
  } catch {
    productIds = [];
  }

  const startsAtRaw = String(formData.get("startsAt") ?? "").trim();
  const endsAtRaw = String(formData.get("endsAt") ?? "").trim();
  const startsAt = startsAtRaw ? new Date(startsAtRaw) : null;
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;

  const enabled =
    formData.get("enabled") === "on" || formData.get("enabled") === "true";

  const nameRaw = String(formData.get("name") ?? "").trim();
  const name = nameRaw.length > 0 ? nameRaw : null;

  if (tags.length === 0) {
    return { ok: false as const, error: "Add at least one tag (comma-separated)." };
  }
  if (productIds.length === 0) {
    return {
      ok: false as const,
      error: "Select at least one product for this rule.",
    };
  }

  if (intent === "create") {
    await db.tagRule.create({
      data: {
        shop,
        name,
        tags: JSON.stringify(tags),
        productIds: JSON.stringify(productIds),
        startsAt,
        endsAt,
        enabled,
      },
    });
    return { ok: true as const };
  }

  if (intent === "update") {
    const id = String(formData.get("id") ?? "");
    if (!id) {
      return { ok: false as const, error: "Missing rule id" };
    }
    const existing = await db.tagRule.findFirst({ where: { id, shop } });
    if (!existing) {
      return { ok: false as const, error: "Rule not found." };
    }
    await db.tagRule.update({
      where: { id },
      data: {
        name,
        tags: JSON.stringify(tags),
        productIds: JSON.stringify(productIds),
        startsAt,
        endsAt,
        enabled,
      },
    });
    return { ok: true as const };
  }

  return { ok: false as const, error: "Unknown action" };
};

function gidToNumericProductId(gid: string): string {
  const m = /Product\/(\d+)$/.exec(gid);
  return m ? m[1] : gid.replace(/\D/g, "") || gid;
}

function formatForDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export default function TagRulesIndex() {
  const { rules } = useLoaderData<typeof loader>();
  const ruleFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const backfillFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [enabled, setEnabled] = useState(true);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setTagsInput("");
    setProductIds([]);
    setStartsAt("");
    setEndsAt("");
    setEnabled(true);
  };

  const loadRuleIntoForm = (r: RuleRow) => {
    setEditingId(r.id);
    setName(r.name ?? "");
    setTagsInput(tagsToCommaList(r.tags));
    try {
      const ids = JSON.parse(r.productIds) as unknown;
      setProductIds(Array.isArray(ids) ? ids.map(String) : []);
    } catch {
      setProductIds([]);
    }
    setStartsAt(formatForDatetimeLocal(r.startsAt));
    setEndsAt(formatForDatetimeLocal(r.endsAt));
    setEnabled(r.enabled);
  };

  const pendingSaveKind = useRef<"create" | "update" | null>(null);
  const seenRuleSuccess = useRef(false);
  const seenDeleteSuccess = useRef(false);

  useEffect(() => {
    if (ruleFetcher.data?.ok === true) {
      if (!seenRuleSuccess.current) {
        seenRuleSuccess.current = true;
        const kind = pendingSaveKind.current;
        pendingSaveKind.current = null;
        shopify.toast.show(
          kind === "update" ? "Rule updated" : "Rule created",
        );
        resetForm();
      }
    } else if (
      ruleFetcher.data &&
      "error" in ruleFetcher.data &&
      ruleFetcher.data.error
    ) {
      seenRuleSuccess.current = false;
      shopify.toast.show(String(ruleFetcher.data.error), { isError: true });
    } else {
      seenRuleSuccess.current = false;
    }
  }, [ruleFetcher.data, shopify]);

  useEffect(() => {
    if (deleteFetcher.state === "submitting") {
      seenDeleteSuccess.current = false;
    }
  }, [deleteFetcher.state]);

  useEffect(() => {
    if (deleteFetcher.data?.ok === true) {
      if (!seenDeleteSuccess.current) {
        seenDeleteSuccess.current = true;
        shopify.toast.show("Rule deleted");
      }
    } else {
      seenDeleteSuccess.current = false;
    }
  }, [deleteFetcher.data, shopify]);

  const pickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
    });
    if (!selected?.length) return;
    const next = new Set(productIds);
    for (const item of selected) {
      if (item && typeof item === "object" && "id" in item) {
        next.add(gidToNumericProductId(String(item.id)));
      }
    }
    setProductIds(Array.from(next));
  };

  const backfillRunning =
    backfillFetcher.state === "submitting" ||
    backfillFetcher.state === "loading";

  const backfillResult =
    backfillFetcher.data?.ok === true && "backfill" in backfillFetcher.data
      ? backfillFetcher.data.backfill
      : null;

  const busy =
    ruleFetcher.state === "submitting" ||
    ruleFetcher.state === "loading" ||
    deleteFetcher.state === "submitting" ||
    deleteFetcher.state === "loading";

  const formIntent = editingId ? "update" : "create";

  return (
    <s-page heading="Order auto-tagger">
      <s-button slot="primary-action" onClick={resetForm} disabled={busy}>
        New rule
      </s-button>

      <s-section heading="Tag rules">
        <s-paragraph>
          When a new order includes any of the selected products and the order
          date falls within the window (in your browser&apos;s local timezone),
          the listed tags are added to the order. You can filter exports by
          these order tags in Shopify Admin.
        </s-paragraph>
        <s-paragraph>
          Overlapping rules all apply &mdash; tags from every matching rule are
          merged.
        </s-paragraph>
      </s-section>

      <s-section heading="Your rules">
        {rules.length === 0 ? (
          <s-paragraph>No rules yet. Create one below.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {rules.map((r) => (
              <s-box
                key={r.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-text type="strong">
                      {r.name?.trim() || "Untitled rule"}
                    </s-text>
                    {!r.enabled ? (
                      <s-badge tone="warning">Disabled</s-badge>
                    ) : null}
                  </s-stack>
                  <s-paragraph color="subdued">
                    Tags: {tagsToCommaList(r.tags)}
                  </s-paragraph>
                  <s-paragraph color="subdued">
                    Products (IDs):{" "}
                    {(() => {
                      try {
                        const ids = JSON.parse(r.productIds) as string[];
                        return Array.isArray(ids) ? ids.join(", ") : r.productIds;
                      } catch {
                        return r.productIds;
                      }
                    })()}
                  </s-paragraph>
                  <s-paragraph color="subdued">
                    Window:{" "}
                    {r.startsAt
                      ? new Date(r.startsAt).toLocaleString()
                      : "(no start)"}{" "}
                    &mdash;{" "}
                    {r.endsAt
                      ? new Date(r.endsAt).toLocaleString()
                      : "(no end)"}
                  </s-paragraph>
                  <s-stack direction="inline" gap="small">
                    <s-button
                      onClick={() => loadRuleIntoForm(r)}
                      disabled={busy}
                    >
                      Edit
                    </s-button>
                    <deleteFetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={r.id} />
                      <s-button
                        type="submit"
                        variant="tertiary"
                        tone="critical"
                        disabled={busy}
                      >
                        Delete
                      </s-button>
                    </deleteFetcher.Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Backfill past orders">
        <s-paragraph>
          Run your enabled rules against all existing orders. Tags are added to
          any order that matches — already-tagged orders are unaffected. This
          may take a moment for larger order histories.
        </s-paragraph>
        <s-stack direction="block" gap="small">
          <backfillFetcher.Form method="post">
            <input type="hidden" name="intent" value="backfill" />
            <s-button
              type="submit"
              variant="primary"
              disabled={backfillRunning || busy}
            >
              {backfillRunning ? "Running backfill…" : "Run backfill"}
            </s-button>
          </backfillFetcher.Form>
          {backfillResult ? (
            <s-paragraph>
              Done — checked {backfillResult.processed} orders, tagged{" "}
              {backfillResult.tagged}.
            </s-paragraph>
          ) : null}
          {backfillFetcher.data?.ok === false &&
          "error" in backfillFetcher.data ? (
            <s-paragraph color="critical">
              {backfillFetcher.data.error}
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading={editingId ? "Edit rule" : "Create rule"}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            pendingSaveKind.current = editingId ? "update" : "create";
            seenRuleSuccess.current = false;
            ruleFetcher.submit(
              {
                intent: formIntent,
                ...(editingId ? { id: editingId } : {}),
                name,
                tags: tagsInput,
                productIds: JSON.stringify(productIds),
                startsAt,
                endsAt,
                enabled: enabled ? "true" : "false",
              },
              { method: "post" },
            );
          }}
        >
          <s-stack direction="block" gap="base">
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Rule name (optional)</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                autoComplete="off"
                style={{ padding: "8px", maxWidth: 360 }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Tags to add (comma-separated)</span>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                disabled={busy}
                required
                autoComplete="off"
                style={{ padding: "8px", maxWidth: 480 }}
              />
            </label>

            <s-stack direction="block" gap="small">
              <s-text type="strong">Products</s-text>
              <s-paragraph color="subdued">
                Pick one or more products. Order line items are matched by
                product ID.
              </s-paragraph>
              <s-stack direction="inline" gap="small">
                <s-button type="button" onClick={pickProducts} disabled={busy}>
                  Browse products
                </s-button>
                {productIds.length > 0 ? (
                  <s-text color="subdued">
                    {productIds.length} selected ({productIds.join(", ")})
                  </s-text>
                ) : (
                  <s-text color="subdued">None selected</s-text>
                )}
              </s-stack>
            </s-stack>

            <s-stack direction="inline" gap="base">
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Starts at (optional)</span>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Ends at (optional)</span>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  disabled={busy}
                />
              </label>
            </s-stack>

            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={busy}
              />
              <span>Rule enabled</span>
            </label>

            <s-stack direction="inline" gap="small">
              <s-button type="submit" variant="primary" disabled={busy}>
                {editingId ? "Save changes" : "Create rule"}
              </s-button>
              {editingId ? (
                <s-button type="button" onClick={resetForm} disabled={busy}>
                  Cancel edit
                </s-button>
              ) : null}
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          The app listens for <s-text type="strong">orders/create</s-text> and
          adds tags when a rule matches. Re-install or deploy after scope
          changes.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
