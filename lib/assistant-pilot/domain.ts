import type { PilotIdentity } from "./types";

/** Server-side allowlist. No browser-supplied organization or installation IDs. */
export function assertPilotIdentity(identity: PilotIdentity) {
  const tenant = process.env.ASSISTANT_PILOT_ORGANIZATION_ID;
  const owner = process.env.ASSISTANT_PILOT_OWNER_USER_ID;
  if (
    !tenant ||
    !owner ||
    identity.tenantId !== tenant ||
    identity.userId !== owner ||
    identity.assistantId !== "internal-assistant"
  )
    throw new Error("pilot_identity_denied");
}
export type DomainContext = { organization_id: string; actor: { type: "user"; id: string } };
export type ReviewResult = {
  conversations: {
    id: string;
    last_inbound_at?: string | null;
    last_outbound_at?: string | null;
  }[];
  has_more: boolean;
  cursor: string | null;
};
export type DomainQueries = {
  review: (
    context: DomainContext,
    query: { limit: number; exclude_finished: boolean },
  ) => Promise<ReviewResult>;
};

/** Inject only the canonical handler with the authenticated user-scoped client.
 * No body-provided organization, service-role fallback or fabricated business data.
 * Incoming/outgoing timestamps are evidence, NOT a diagnosis of pending reply.
 */
export function pilotDomain(identity: PilotIdentity, queries: DomainQueries) {
  assertPilotIdentity(identity);
  const context: DomainContext = {
    organization_id: identity.tenantId,
    actor: { type: "user", id: identity.userId },
  };
  return {
    async review() {
      const result = await queries.review(context, { limit: 20, exclude_finished: true });
      return {
        ...result,
        conversations: result.conversations.map(({ id, last_inbound_at, last_outbound_at }) => ({
          id,
          last_inbound_at,
          last_outbound_at,
        })),
      };
    },
  };
}
