/**
 * LGPD Art. 18 II — a exportação do titular deve trazer a transcrição da mídia.
 *
 * ═══ O defeito que este arquivo fecha ═══
 *
 * O export (`data.json` + `report.pdf`) nunca leva o binário da mídia: a
 * mensagem diz só que TEM mídia (`has_media`). O `media-derive-worker`
 * (migration 0497) guarda o que a IA TRANSCREVEU/extraiu de cada mídia em
 * `messages.media_derived_text` — e a anonimização o APAGA quando o titular
 * pede eliminação (#1989). No Art. 18 II vale a mesma régua do resto do
 * coletor: o que se apaga a pedido dele é o que se entrega a pedido dele. O
 * export lia de `messages` sem `media_derived_text`, então quem pedia acesso
 * não recebia o texto que a organização efetivamente leu do áudio/imagem dele.
 *
 * ═══ Onde mora o resto da prova ═══
 *
 * Aqui o foco é o PAYLOAD — que é literalmente o `data.json` gerado pelo
 * worker (`JSON.stringify(data, null, 2)`), nos dois caminhos que leem
 * `messages`: as do titular e as de grupo que ele escreveu. A linha do PDF é
 * provada em `lgpd-pdf-transcricao.test.ts`; a máscara da prévia da
 * solicitação, em `lgpd-preview-mascara-transcricao.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";

type Row = Record<string, unknown>;
const ORG = "tenant-a";
const CONTACT = "contact-a";
const request = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: CONTACT,
  externalCustomerId: null,
};
let rows: Record<string, Row[]>;

class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
  ins: [string, unknown[]][] = [];
  page: [number, number] = [0, 100000];
  constructor(readonly table: string) {}
  select(columns: string) {
    this.columns = columns;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.ins.push([key, values]);
    return this;
  }
  order() {
    return this;
  }
  limit(limit: number) {
    this.page = [0, limit - 1];
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  or() {
    return this;
  }
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data?.[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    const data = (rows[this.table] ?? [])
      .filter((row) => this.filters.every(([key, value]) => row[key] === value))
      .filter((row) => this.ins.every(([key, values]) => values.includes(row[key])))
      .slice(this.page[0], this.page[1] + 1)
      .map((row) =>
        Object.fromEntries(
          this.columns
            .split(",")
            .map((column) => column.trim())
            .map((column) => [column, row[column]]),
        ),
      );
    return { data, error: null };
  }
}

beforeEach(() => {
  rows = {
    organizations: [
      { id: ORG, legal_name: "Clínica Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Paciente Teste",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    messages: [
      {
        id: "msg-audio",
        organization_id: ORG,
        contact_id: CONTACT,
        conversation_id: "conv-a",
        direction: "inbound",
        type: "audio",
        status: "delivered",
        body: null,
        media_url: "https://storage/audio.mp3",
        media_derived_text: "transcrição do áudio do titular",
        sent_at: "2026-09-15T10:00:00Z",
        created_at: "2026-09-15T10:00:00Z",
      },
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: export do titular traz a transcrição da mídia (#1990)", () => {
  it("entrega media_derived_text nas mensagens recentes do titular", async () => {
    const payload = await collectExportData(request);
    expect(payload.messages_recent).toEqual([
      expect.objectContaining({
        id: "msg-audio",
        has_media: true,
        media_derived_text: "transcrição do áudio do titular",
      }),
    ]);
  });

  it("mensagem de OUTRO contato não vaza a transcrição no export", async () => {
    rows.messages!.push({
      id: "msg-outro",
      organization_id: ORG,
      contact_id: "contact-b",
      conversation_id: "conv-b",
      direction: "inbound",
      type: "audio",
      status: "delivered",
      body: null,
      media_url: "https://storage/b.mp3",
      media_derived_text: "transcrição secreta de outro contato",
      sent_at: "2026-09-15T11:00:00Z",
      created_at: "2026-09-15T11:00:00Z",
    });
    const payload = await collectExportData(request);
    expect(payload.messages_recent).toEqual([
      expect.objectContaining({
        id: "msg-audio",
        media_derived_text: "transcrição do áudio do titular",
      }),
    ]);
    expect(
      payload.messages_recent.some((m) => m.media_derived_text === "transcrição secreta de outro contato"),
    ).toBe(false);
  });

  it("mensagem com mídia sem transcrição sai com media_derived_text nulo", async () => {
    const semTranscricao: Row = { ...rows.messages![0], media_derived_text: null };
    rows.messages = [semTranscricao];
    const payload = await collectExportData(request);
    expect(payload.messages_recent).toEqual([
      expect.objectContaining({
        id: "msg-audio",
        has_media: true,
        media_derived_text: null,
      }),
    ]);
  });

  it("entrega media_derived_text nas mensagens de grupo que o titular escreveu", async () => {
    rows.contacts![0] = { ...rows.contacts![0], wa_lid: "lid-titular" };
    rows.messages!.push({
      id: "msg-grupo",
      organization_id: ORG,
      contact_id: "contact-do-grupo",
      conversation_id: "conv-grupo",
      direction: "inbound",
      type: "audio",
      status: "delivered",
      body: null,
      media_url: "https://storage/grupo.mp3",
      media_derived_text: "transcrição do áudio no grupo",
      "metadata->group_sender->>lid": "lid-titular",
      sent_at: "2026-09-15T12:00:00Z",
      created_at: "2026-09-15T12:00:00Z",
    });
    const payload = await collectExportData(request);
    expect(payload.group_messages_authored).toEqual([
      expect.objectContaining({
        id: "msg-grupo",
        has_media: true,
        media_derived_text: "transcrição do áudio no grupo",
      }),
    ]);
  });
});
