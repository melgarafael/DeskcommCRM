import { z } from "zod";
import { channelSchema, type SocialNetwork } from "./contract";

const BASE = "https://hub.sociosai.com";
export class SocialApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    // Não propagar detail nem o corpo remoto: podem conter credenciais ou dados pessoais.
    super(`social_api:${code}`);
  }
}

/** Uma chave de SUBCONTA por organização. Nenhum header permite trocar a conta. */
export class SocialClient {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const res = await this.transport(`${BASE}${path}`, {
      method,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const error = z.object({ code: z.string().regex(/^[a-z_]+$/) }).safeParse(json);
      throw new SocialApiError(
        error.success ? error.data.code : "invalid_response",
        res.status,
        res.headers.get("retry-after"),
      );
    }
    const version = res.headers.get("x-hub-contract-version");
    if (method === "GET" && version && version !== "1.3")
      throw new SocialApiError("contract_changed", 502);
    return json;
  }

  async identity() {
    return z
      .object({
        account: z.object({
          id: z.string().min(1),
          kind: z.literal("subaccount"),
          status: z.literal("active"),
        }),
        contract_version: z.literal("1.3"),
      })
      .parse(await this.request("/v1/me"));
  }
  async channels() {
    const result = z
      .object({ data: z.array(z.object({ type: z.string() }).passthrough()) })
      .parse(await this.request("/v1/channels"));
    return result.data
      .filter((c) => c.type === "instagram" || c.type === "messenger")
      .map((c) => channelSchema.parse(c));
  }
  async connect(network: SocialNetwork, returnUrl: string) {
    const result = z.object({ url: z.string().url(), expires_at: z.string() }).parse(
      await this.request("/v1/connect-sessions", "POST", {
        channel_type: network,
        return_url: returnUrl,
      }),
    );
    const url = new URL(result.url);
    if (url.origin !== BASE || !url.pathname.startsWith("/connect/"))
      throw new SocialApiError("invalid_connect_url", 502);
    return result;
  }
  async subscribe(url: string) {
    return z.object({ id: z.string().min(1), secret: z.string().min(16) }).parse(
      await this.request("/v1/webhooks", "POST", {
        url,
        events: [
          "message.received",
          "message.status",
          "channel.connected",
          "channel.reconnected",
          "channel.disconnected",
          "channel.health_changed",
        ],
      }),
    );
  }
  async recover(since: string, before?: string) {
    const params = new URLSearchParams({ event: "message.received", since, limit: "50" });
    if (before) params.set("before", before);
    return z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            event: z.literal("message.received"),
            data: z.record(z.string(), z.unknown()).nullable(),
            expired: z.boolean(),
          }),
        ),
        has_more: z.boolean(),
        next_before: z.string().nullable(),
      })
      .parse(await this.request(`/v1/events?${params}`));
  }
  async send(channelId: string, recipient: string, body: unknown, idempotencyKey: string) {
    return z.object({ message_id: z.string().min(1), status: z.string() }).parse(
      await this.request(
        "/v1/messages",
        "POST",
        {
          channel_id: channelId,
          to: recipient,
          ...(body as Record<string, unknown>),
        },
        idempotencyKey,
      ),
    );
  }
}
