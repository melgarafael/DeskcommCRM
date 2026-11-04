/* eslint-disable @typescript-eslint/no-explicit-any -- controlled transport doubles, validated separately against real PostgreSQL/PostgREST */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionBoundary: () => ({
    organization_id: "org",
    contact_id: "contact",
    conversation_id: "conv",
    service_revision: 2,
    demanda_id: null,
    demanda_revision: null,
  }),
}));
import { privateCaseClient } from "@/lib/ai/runtime/private-case-client";
function fake(privateMode = true) {
  const history: any[] = [];
  const data: any = {
    organizations: [{ id: "org", name: "Own" }, { id: "neighbor", name: "Other" }],
    conversation_business_contexts: [
      {
        organization_id: "org",
        conversation_id: "conv",
        service_revision: 2,
        status: "assigned",
        lead_id: "lead",
      },
    ],
    messages: [
      { organization_id: "org", conversation_id: "conv", service_revision: 1, body: "OLD-PRIVATE" },
      { organization_id: "org", conversation_id: "conv", service_revision: 2, body: "CURRENT" },
    ],
    contacts: [{ organization_id: "org", id: "other", name: "PRIVATE" }],
    channel_sessions: [{ organization_id: "org", id: "channel" }],
  };
  const db: any = {
    rpc: async () => ({ data: privateMode, error: null }),
    schema() {
      return this;
    },
    from(table: string) {
      const filters: any[] = [];
      const builder: any = {
        select() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({
            data: (data[table] ?? []).filter((r: any) => filters.every((f) => f(r)))[0] ?? null,
            error: null,
          });
        },
        eq(k: any, v: any) {
          filters.push((row: any) => row[k] === v);
          return this;
        },
        in(k: any, v: any) {
          filters.push((row: any) => v.includes(row[k]));
          return this;
        },
        delete() {
          history.push({ operation: "delete", table });
          return this;
        },
        then(resolve: any, reject: any) {
          return Promise.resolve({
            data: (data[table] ?? []).filter((r: any) => filters.every((f) => f(r))),
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db, history };
}
describe("Private-case proxy independent adversarial probes", () => {
  it("native organization configuration uses its actual primary key and remains readonly", async () => {
    const { db } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    const r: any = await client.from("organizations").select("id,name");
    expect(r.data).toEqual([{ id: "org", name: "Own" }]);
    expect(() => client.from("organizations").delete()).toThrow("private_case_cannot_change_configuration");
  });

  it("prior revision is excluded in same conversation", async () => {
    const { db } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    const r: any = await client.from("messages").select("*");
    expect(r.data.map((x: any) => x.body)).toEqual(["CURRENT"]);
  });
  it("schema escape is refused", async () => {
    const { db } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    expect(() => client.schema("public")).toThrow("private_case_client_capability_not_available");
  });
  it("neutral configuration delete is refused", async () => {
    const { db, history } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    expect(() => client.from("channel_sessions").delete()).toThrow(
      "private_case_cannot_change_configuration",
    );
    expect(history).toHaveLength(0);
  });
  it("uncontracted RPC is refused; native handoff has its explicit contract", async () => {
    const { db } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    expect(() =>
      client.rpc("fn_request_channel_routing", { p_org: "org", p_conversation: "conv" }),
    ).toThrow("private_context_rpc_requires_explicit_contract");
  });
  it("default-off returns original client unchanged", async () => {
    const { db } = fake(false);
    expect(await privateCaseClient(db, "org", "contact")).toBe(db);
  });
  it("native handoff exact conversation returns trusted original client", async () => {
    const { db } = fake();
    expect(
      await privateCaseClient(db, "org", "contact", {
        name: "crm_request_human_handoff",
        args: { conversation_id: "conv" },
      }),
    ).toBe(db);
  });
  it("native handoff wrong conversation refused", async () => {
    const { db } = fake();
    await expect(
      privateCaseClient(db, "org", "contact", {
        name: "crm_request_human_handoff",
        args: { conversation_id: "other" },
      }),
    ).rejects.toThrow("private_case_target_mismatch");
  });
  it("all uncontracted root capabilities denied", async () => {
    const { db } = fake();
    const client: any = await privateCaseClient(db, "org", "contact");
    for (const key of ["auth", "storage", "functions", "realtime", "schema"])
      expect(() => client[key]).toThrow("private_case_client_capability_not_available");
  });
  it("boundary contact mismatch refuses before any case data", async () => {
    const { db } = fake();
    await expect(privateCaseClient(db, "org", "other")).rejects.toThrow(
      "private_context_requires_conversation",
    );
  });
  it("boundary tenant mismatch refuses", async () => {
    const { db } = fake();
    await expect(privateCaseClient(db, "neighbor", "contact")).rejects.toThrow(
      "private_context_requires_conversation",
    );
  });
  it("foreign or stale case_id refused before pool handler", async () => {
    const { db } = fake();
    await expect(
      privateCaseClient(db, "org", "contact", {
        name: "crm_add_case_note",
        args: { case_id: "other-case" },
      }),
    ).rejects.toThrow("private_case_target_mismatch");
  });
  it("POSITIVE CONTROL: ordinary from contacts remains case scoped", async () => {
    const { db } = fake();
    const client = await privateCaseClient(db, "org", "contact");
    const r: any = await client.from("contacts").select("*");
    expect(r.data).toHaveLength(0);
  });
});
