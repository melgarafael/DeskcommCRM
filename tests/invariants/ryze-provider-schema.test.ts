import { describe, expect, it } from "vitest";

import { persistRyzeSession } from "@/lib/channels/ryze/control-plane";
import { sql } from "./gov-helpers";

/**
 * Invariante de Banco e Integração de Persistência do Provider RyzeAPI (`ryze-channel`).
 *
 * Valida a integridade do schema da tabela public.channel_sessions e as operações reais de banco
 * para o provider ryze contra o Postgres efêmero que nasce de supabase/baseline.sql (scripts/test-db.sh).
 */

function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv ryze', 'inv ryze');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function insertSession(org: string, cols: Record<string, string>): string {
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return sql(`
    insert into public.channel_sessions (${nomes.join(", ")})
    values (${vals.join(", ")});
    select 'ok';
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

function dbAdapterReal(): any {
  const builder: any = {
    table: "channel_sessions",
    mode: "select",
    filters: [] as Array<[string, string, string | null]>,
    payload: null as Record<string, unknown> | null,
    from(table: string) {
      this.table = table;
      return this;
    },
    select() {
      this.mode = "select";
      return this;
    },
    eq(column: string, value: string) {
      this.filters.push([column, "=", value]);
      return this;
    },
    is(column: string, value: null) {
      this.filters.push([column, "is", value]);
      return this;
    },
    maybeSingle() {
      const org = this.filters.find((f: [string, string, string | null]) => f[0] === "organization_id")?.[2];
      const instance = this.filters.find((f: [string, string, string | null]) => f[0] === "ryze_instance_name")?.[2];
      const id = org && instance
        ? sql(`select id from public.channel_sessions where organization_id='${org}' and provider='ryze' and ryze_instance_name='${instance}' and archived_at is null limit 1`).trim()
        : "";
      this.filters = [];
      return Promise.resolve({ data: id ? { id } : null, error: null });
    },
    update(payload: Record<string, unknown>) {
      this.mode = "update";
      this.payload = payload;
      return this;
    },
    insert(payload: Record<string, unknown>) {
      this.mode = "insert";
      this.payload = payload;
      return this;
    },
    then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
      try {
        if (this.mode === "insert") {
          const p = this.payload as Record<string, string>;
          sql(`insert into public.channel_sessions (organization_id, provider, ryze_instance_name, ryze_token_encrypted, webhook_secret_encrypted, metadata) values ('${p.organization_id}', 'ryze', '${p.ryze_instance_name}', '${p.ryze_token_encrypted}'::bytea, '${p.webhook_secret_encrypted}'::bytea, '{}'::jsonb)`);
        } else if (this.mode === "update") {
          const id = this.filters.find((f: [string, string, string | null]) => f[0] === "id")?.[2];
          const org = this.filters.find((f: [string, string, string | null]) => f[0] === "organization_id")?.[2];
          const p = this.payload as Record<string, string>;
          sql(`update public.channel_sessions set ryze_token_encrypted='${p.ryze_token_encrypted}'::bytea where id='${id}' and organization_id='${org}'`);
        }
        this.filters = [];
        return Promise.resolve({ error: null }).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  };
  return { from: (table: string) => builder.from(table) };
}

describe("0210 · schema e invariantes do provider ryze", () => {
  it("ryze_token_encrypted existe na tabela channel_sessions e seu data_type é bytea", () => {
    const dataType = sql(`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name = 'ryze_token_encrypted'
    `).trim();
    expect(dataType).toBe("bytea");
  });

  it("ryze_instance_name existe na tabela channel_sessions", () => {
    const col = sql(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name = 'ryze_instance_name'
    `).trim();
    expect(col).toBe("ryze_instance_name");
  });

  it("sessão ryze sem ryze_instance_name é RECUSADA pelo banco", () => {
    const org = novaOrg(`inv-ryze-ref-${Date.now()}`);
    const msg = erroDe(() =>
      insertSession(org, { provider: `'ryze'`, waha_session_name: "null" }),
    );
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("sessão ryze com ryze_instance_name válido é ACEITA pelo banco", () => {
    const org = novaOrg(`inv-ryze-ok-${Date.now()}`);
    const res = insertSession(org, {
      provider: `'ryze'`,
      waha_session_name: "null",
      ryze_instance_name: `'instancia-ryze-${Date.now()}'`,
    });
    expect(res).toContain("ok");
  });

  it("duplicidade de ryze_instance_name em sessões ativas é RECUSADA pelo índice único parcial (mesma org ou cross-tenant)", () => {
    const org1 = novaOrg(`inv-ryze-dup1-${Date.now()}`);
    const org2 = novaOrg(`inv-ryze-dup2-${Date.now()}`);
    const instanceName = `'instancia-dup-${Date.now()}'`;
    insertSession(org1, {
      provider: `'ryze'`,
      waha_session_name: "null",
      ryze_instance_name: instanceName,
    });
    const msg = erroDe(() =>
      insertSession(org2, {
        provider: `'ryze'`,
        waha_session_name: "null",
        ryze_instance_name: instanceName,
      }),
    );
    expect(msg).toMatch(/idx_channel_sessions_ryze_instance_name_active/);
  });

  it("executa persistRyzeSession no Postgres real do harness com INSERT/UPDATE canônicos", async () => {
    const org = novaOrg(`inv-ryze-production-seam-${Date.now()}`);
    const inst = `inst-production-seam-${Date.now()}`;
    const db = dbAdapterReal();

    const inserted = await persistRyzeSession(db, {
      organizationId: org,
      instanceName: inst,
      encryptedToken: "\\xdeadbeef",
      webhookSecretEncrypted: "\\xfeedface",
    });
    expect(inserted.action).toBe("inserted");

    const status = sql(`select status from public.channel_sessions where organization_id='${org}' and ryze_instance_name='${inst}'`).trim();
    const cipher = sql(`select encode(ryze_token_encrypted, 'hex') from public.channel_sessions where organization_id='${org}' and ryze_instance_name='${inst}'`).trim();
    const webhookCipher = sql(`select encode(webhook_secret_encrypted, 'hex') from public.channel_sessions where organization_id='${org}' and ryze_instance_name='${inst}'`).trim();
    expect(status).toBe("STARTING");
    expect(cipher).toBe("deadbeef");
    expect(webhookCipher).toBe("feedface");

    const updated = await persistRyzeSession(db, {
      organizationId: org,
      instanceName: inst,
      encryptedToken: "\\xcafebabe",
    });
    expect(updated.action).toBe("updated");

    const rowCount = sql(`select count(*) from public.channel_sessions where organization_id='${org}' and ryze_instance_name='${inst}'`).trim();
    const updatedCipher = sql(`select encode(ryze_token_encrypted, 'hex') from public.channel_sessions where organization_id='${org}' and ryze_instance_name='${inst}'`).trim();
    expect(rowCount).toBe("1");
    expect(updatedCipher).toBe("cafebabe");
  });

  it("sessões legadas (waha, meta_cloud, zernio) continuam válidas e protegidas pelas constraints", () => {
    const org = novaOrg(`inv-ryze-legado-${Date.now()}`);
    const resWaha = insertSession(org, { waha_session_name: `'s-waha-${Date.now()}'` });
    expect(resWaha).toContain("ok");

    const resMeta = insertSession(org, {
      provider: `'meta_cloud'`,
      waha_session_name: "null",
      meta_phone_number_id: `'phone-meta-${Date.now()}'`,
    });
    expect(resMeta).toContain("ok");

    const resZernio = insertSession(org, {
      provider: `'zernio'`,
      waha_session_name: "null",
      zernio_account_id: `'acc-zernio-${Date.now()}'`,
    });
    expect(resZernio).toContain("ok");
  });
});
