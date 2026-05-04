import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  evaluateTagRules,
  type OrderWebhookPayload,
  orderGidFromRestId,
} from "../lib/evaluateTagRules";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, topic, payload: rawPayload } =
    await authenticate.webhook(request);

  if (!session || !admin) {
    return new Response();
  }

  const payload = rawPayload as OrderWebhookPayload;

  const rules = await db.tagRule.findMany({
    where: { shop, enabled: true },
  });

  const tags = evaluateTagRules(payload, rules);

  if (tags.length === 0) {
    return new Response();
  }

  const rawId = payload.id;
  const orderId =
    typeof rawId === "number"
      ? rawId
      : rawId != null
        ? Number.parseInt(String(rawId), 10)
        : NaN;
  if (Number.isNaN(orderId)) {
    console.warn(`[${topic}] missing order id for ${shop}`);
    return new Response();
  }

  const response = await admin.graphql(
    `#graphql
      mutation orderAutoTaggerTagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        id: orderGidFromRestId(orderId),
        tags,
      },
    },
  );

  const body = await response.json();
  const errors = body?.data?.tagsAdd?.userErrors;
  if (Array.isArray(errors) && errors.length > 0) {
    console.error(`tagsAdd userErrors for ${shop}:`, errors);
  }

  return new Response();
};
