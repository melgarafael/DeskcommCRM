import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectExportData } from "@/lib/lgpd/export-collector";

/**
 * LGPD ALCANÇA AS MENSAGENS DE GRUPO DE QUEM JÁ É CONTATO (migration 0411).
 *
 * A mensagem de grupo mora na conversa do contato PLACEHOLDER do grupo, não na do
 * titular: o autor só existe em `messages.metadata.group_sender`. Sem o casamento
 * por telefone/lid, anonimizar alguém deixava intacto tudo o que ele escreveu nos
 * grupos, e o export não entregava nada disso.
 *
 * Prova, no Postgres real, os dois lados:
 *   - o export entrega as mensagens de grupo do titular (por telefone E por lid),
 *     e não a de outro participante;
 *   - anonimizar — pelo pedido formal E pelo UPDATE do botão da ficha — redige
 *     essas mensagens, enfileira a mídia e zera a prévia do grupo, sem tocar a
 *     mensagem de outro participante.
 *
 * O participante que NÃO é contato não tem caminho, de propósito (ver a spec).
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

// Ponte de leitura para o coletor: filtros viram SQL real. Aceita caminho JSON
// aninhado (`metadata->group_sender->>phone`), que é o filtro deste recurso.
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error(`identificador inválido: ${s}`);
  return `"${s}"`;
};
const field = (s: string): string => {
  const partes = s.split(/->>?/);
  if (partes.length === 1) return ident(s);
  const ops = s.match(/->>?/g)!;
  return partes.slice(1).reduce((acc, p, i) => {
    if (!/^[a-z_]+$/.test(p)) throw Error(`chave inválida: ${p}`);
    return `${acc}${ops[i]}'${p}'`;
  }, ident(partes[0]!));
};
class ReadQuery {
  columns = "";
  filters: string[] = [];
  values: unknown[] = [];
  ordering: string[] = [];
  size?: number;
  offset = 0;
  one = false;
  head = false;
  constructor(readonly table: string) {}
  p(value: unknown) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  select(columns: string, options?: { head?: boolean }) {
    this.columns = columns;
    this.head = !!options?.head;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push(`${field(key)}=${this.p(value)}`);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.filters.push(`${field(key)}=any(${this.p(values)})`);
    return this;
  }
  or(expression: string) {
    this.filters.push(
      `(${expression
        .split(",")
        .map((term) => {
          const [key, op, value] = term.split(".");
          if (op !== "eq" || !key || !value) throw Error("filtro não suportado");
          return `${field(key)}=${this.p(value)}`;
        })
        .join(" or ")})`,
    );
    return this;
  }
  order(key: string, options?: { ascending?: boolean }) {
    this.ordering.push(`${field(key)} ${options?.ascending === false ? "desc" : "asc"}`);
    return this;
  }
  limit(size: number) {
    this.size = size;
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.size = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this.execute();
  }
  then(yes: (value: unknown) => unknown, no?: (error: unknown) => unknown) {
    return this.execute().then(yes, no);
  }
  async execute() {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    if (this.head) {
      const r = await pool.query(`select count(*)::int n from ${ident(this.table)}${where}`, this.values);
      return { data: null, error: null, count: r.rows[0].n };
    }
    const projection = this.columns
      .split(",")
      .map((part) => {
        const [alias, source] = part.trim().split(":");
        return source ? `${field(source)} as ${ident(alias!)}` : field(alias!);
      })
      .join(",");
    const order = this.ordering.length ? ` order by ${this.ordering.join(",")}` : "";
    const sql = `select ${projection} from ${ident(this.table)}${where}${order}${this.size === undefined ? "" : ` limit ${this.size}`} offset ${this.offset}`;
    try {
      const r = await pool.query(`with r as (${sql}) select to_jsonb(r) j from r`, this.values);
      const data = r.rows.map((row) => row.j);
      return { data: this.one ? (data[0] ?? null) : data, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  }
}

const ORG = randomUUID();
const SESSAO = randomUUID();
const GRUPO = randomUUID(); // contato placeholder do grupo
const CONVERSA_GRUPO = randomUUID();
const TITULAR = randomUUID(); // anonimizado pelo pedido formal
const PELA_TELA = randomUUID(); // anonimizado pelo UPDATE do botão
const LID_DO_TITULAR = "111222333444";

// Mensagens de grupo
const DO_TITULAR_POR_TELEFONE = randomUUID(); // grafia SEM o nono dígito
const DO_TITULAR_POR_LID = randomUUID(); // sem telefone no rótulo, com mídia
const DE_OUTRO_PARTICIPANTE = randomUUID();
const DE_QUEM_FOI_PELA_TELA = randomUUID();
const MIDIA = `${ORG}/grupo-titular.jpg`;

async function mensagemDeGrupo(id: string, body: string, sender: object, mediaPath: string | null = null) {
  await q(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,media_storage_path,sent_at,metadata)
     values($1,$2,$3,$4,$5,'text','inbound','delivered','external_device',$6,$7,'2026-09-20T12:00:00Z',jsonb_build_object('raw_type','chat','group_sender',$8::jsonb))`,
    [id, ORG, CONVERSA_GRUPO, SESSAO, GRUPO, body, mediaPath, JSON.stringify(sender)],
  );
}

beforeAll(async () => {
  vi.mocked(createAdminClient).mockReturnValue({ from: (t: string) => new ReadQuery(t) } as never);
  await q("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Grupos LGPD','Grupos LGPD')", [ORG]);
  await q(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'\\x00'::bytea)",
    [SESSAO, ORG],
  );
  await q(
    "insert into contacts(id,organization_id,name,display_name,phone_number,source_metadata) values($1,$2,'Titular','Titular','+5511987654321',jsonb_build_object('waha_lid',$3::text))",
    [TITULAR, ORG, `${LID_DO_TITULAR}@lid`],
  );
  await q(
    "insert into contacts(id,organization_id,name,display_name,phone_number) values($1,$2,'Pela Tela','Pela Tela','+5521988887777')",
    [PELA_TELA, ORG],
  );
  await q(
    "insert into contacts(id,organization_id,name,display_name,kind,source,source_metadata) values($1,$2,'Grupo','Grupo','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id','120363000000000777@g.us'))",
    [GRUPO, ORG],
  );
  await q(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,last_message_preview) values($1,$2,$3,$4,'open',true,'meu cpf é 52998224725')",
    [CONVERSA_GRUPO, ORG, GRUPO, SESSAO],
  );
  await mensagemDeGrupo(DO_TITULAR_POR_TELEFONE, "sou o Titular, cpf 52998224725", {
    name: "Titular",
    phone: "+551187654321",
    lid: null,
  });
  await mensagemDeGrupo(DO_TITULAR_POR_LID, "foto do meu documento", { name: "Titular", phone: null, lid: LID_DO_TITULAR }, MIDIA);
  await mensagemDeGrupo(DE_OUTRO_PARTICIPANTE, "oi, sou a Outra", {
    name: "Outra",
    phone: "+5511911112222",
    lid: "999888777666",
  });
  await mensagemDeGrupo(DE_QUEM_FOI_PELA_TELA, "aqui é o Pela Tela", { name: "Pela Tela", phone: "+5521988887777", lid: null });
});

async function mensagem(id: string) {
  return (
    await q("select body, metadata, media_storage_path, sent_at, created_at from messages where id=$1", [id])
  ).rows[0];
}

describe("mensagens de grupo de quem já é contato", () => {
  it("o export entrega as mensagens de grupo do titular (telefone E lid) e não a de outro participante", async () => {
    const data = await collectExportData({ organizationId: ORG, requestId: randomUUID(), contactId: TITULAR, externalCustomerId: null });
    expect(data.group_messages_authored.map((m) => m.id).sort()).toEqual([DO_TITULAR_POR_TELEFONE, DO_TITULAR_POR_LID].sort());
    const serializado = JSON.stringify(data.group_messages_authored);
    expect(serializado).toContain("sou o Titular");
    expect(serializado).not.toContain("sou a Outra");
    expect(serializado).not.toContain("Pela Tela");
  });

  it("pedido formal: anonimizar redige as mensagens de grupo do titular, enfileira a mídia e poupa o outro participante", async () => {
    const antes = await mensagem(DO_TITULAR_POR_TELEFONE);
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,null)", [ORG, TITULAR]);

    for (const id of [DO_TITULAR_POR_TELEFONE, DO_TITULAR_POR_LID]) {
      const m = await mensagem(id);
      expect(m.body).toBe("[mensagem anonimizada]");
      expect(m.metadata).toEqual({});
      expect(m.media_storage_path).toBeNull();
    }
    // Timestamps preservados.
    const depois = await mensagem(DO_TITULAR_POR_TELEFONE);
    expect(depois.sent_at).toEqual(antes.sent_at);
    expect(depois.created_at).toEqual(antes.created_at);

    const fila = await q("select count(*)::int n from storage_redaction_queue where bucket='whatsapp-media' and object_path=$1", [MIDIA]);
    expect(fila.rows[0].n).toBe(1);

    const outro = await mensagem(DE_OUTRO_PARTICIPANTE);
    expect(outro.body).toBe("oi, sou a Outra");
    expect(outro.metadata.group_sender.phone).toBe("+5511911112222");
    const pelaTela = await mensagem(DE_QUEM_FOI_PELA_TELA);
    expect(pelaTela.body).toBe("aqui é o Pela Tela");

    const conversa = await q("select last_message_preview from conversations where id=$1", [CONVERSA_GRUPO]);
    expect(conversa.rows[0].last_message_preview).toBeNull();
  });

  it("pelo botão da ficha: o mesmo UPDATE de fn_lgpd_anonymize_contact redige a mensagem de grupo dele", async () => {
    // Reproduz o UPDATE da RPC (que exige sessão com MFA), como
    // lgpd-anonimizar-pela-tela-redige-conversas.test.ts: o telefone some no
    // MESMO comando que vira is_anonymized.
    await q(
      `update contacts set name=null, display_name='Contato Anonimizado', email=null, phone_number=null,
         is_anonymized=true, anonymized_at=now(), updated_at=now()
       where organization_id=$1 and id=$2`,
      [ORG, PELA_TELA],
    );
    const m = await mensagem(DE_QUEM_FOI_PELA_TELA);
    expect(m.body).toBe("[mensagem anonimizada]");
    expect(m.metadata).toEqual({});
    const outro = await mensagem(DE_OUTRO_PARTICIPANTE);
    expect(outro.body).toBe("oi, sou a Outra");
  });
});
