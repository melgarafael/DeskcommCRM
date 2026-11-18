import { describe, expect, it, vi } from "vitest";

/**
 * O EXPORT DO TITULAR TRAZ OS TELEFONES EXTRAS (Spec 31, B1, item 8).
 *
 * Dois pedidos da LGPD, no coletor:
 *   - a ficha entrega os extras com tipo, WhatsApp, rótulo, origem, `lid` e
 *     `created_at` (o titular recebe o que a organização tem dele);
 *   - a busca de mensagens de GRUPO que o titular escreveu casa pelo número
 *     EXTRA e pelo `lid` do extra, além do principal (C18: antes só o principal).
 *
 * O banco falso devolve só as colunas pedidas no `select` e filtra as mensagens
 * pelo caminho JSON pedido — senão a busca de grupo passaria verde por acaso.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Buscar o grupo só pelo principal (tirar os extras de `telefones` e `lids`):
 *   a mensagem casada pelo número extra e a casada pelo `lid` do extra somem.
 * - Não ler os extras (`telefonesExtras` vazio): o extra some do `contact`.
 */

const ORG = "org-1";
const CONTATO = "c1";

const CONTATO_DO_BANCO = {
  id: CONTATO,
  name: "Titular",
  display_name: "Titular",
  address_book_name: null,
  email: null,
  phone_number: "+5511999998888",
  wa_lid: "lidPrincipal",
  cpf_encrypted: null,
  birthdate: null,
  is_blocked: false,
  is_anonymized: false,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-02T03:04:05.000Z",
  last_activity_at: null,
  first_service_at: null,
};

const EXTRA_DO_BANCO = {
  phone_number: "+5521977776666",
  tipo: "celular",
  whatsapp: "sim",
  rotulo: "Trabalho",
  origem: "fusao",
  wa_lid: "lidExtra",
  created_at: "2026-10-02T10:00:00.000Z",
};

/** Mensagens de grupo: uma por caso (principal, extra por número, extra por lid, outro). */
const MENSAGENS = [
  {
    id: "msg-principal",
    conversation_id: "conv-g",
    direction: "inbound",
    type: "text",
    status: "delivered",
    body: "oi, sou o principal",
    media_url: null,
    media_derived_text: null,
    sent_at: "2026-10-01T12:00:00.000Z",
    created_at: "2026-10-01T12:00:00.000Z",
    metadata: { group_sender: { name: "T", phone: "+5511999998888", lid: null } },
  },
  {
    id: "msg-extra-por-numero",
    conversation_id: "conv-g",
    direction: "inbound",
    type: "text",
    status: "delivered",
    body: "oi, falo pelo segundo número",
    media_url: null,
    media_derived_text: null,
    sent_at: "2026-10-03T12:00:00.000Z",
    created_at: "2026-10-03T12:00:00.000Z",
    metadata: { group_sender: { name: "T", phone: "+5521977776666", lid: null } },
  },
  {
    id: "msg-extra-por-lid",
    conversation_id: "conv-g",
    direction: "inbound",
    type: "text",
    status: "delivered",
    body: "oi, sem telefone no rótulo",
    media_url: null,
    media_derived_text: null,
    sent_at: "2026-10-04T12:00:00.000Z",
    created_at: "2026-10-04T12:00:00.000Z",
    metadata: { group_sender: { name: "T", phone: null, lid: "lidExtra" } },
  },
  {
    id: "msg-de-outro",
    conversation_id: "conv-g",
    direction: "inbound",
    type: "text",
    status: "delivered",
    body: "oi, sou outra pessoa",
    media_url: null,
    media_derived_text: null,
    sent_at: "2026-10-05T12:00:00.000Z",
    created_at: "2026-10-05T12:00:00.000Z",
    metadata: { group_sender: { name: "Outra", phone: "+5511911112222", lid: "lidOutro" } },
  },
];

/** Os extras que o banco falso devolve; o caso "sem extra" zera esta lista. */
let extrasAtuais: Record<string, unknown>[] = [EXTRA_DO_BANCO as Record<string, unknown>];

/** Lê um caminho JSON simples (`metadata->group_sender->>phone`) de uma linha. */
function caminho(linha: Record<string, unknown>, campo: string): unknown {
  const partes = campo.split(/->>?/);
  return partes.slice(1).reduce<unknown>((acc, chave) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[chave];
    return undefined;
  }, linha[partes[0]!]);
}

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const org = { legal_name: "Org LTDA", display_name: "Org", country: null, timezone: "America/Sao_Paulo" };
    const consulta = (tabela: string): unknown => {
      let colunas: string[] | null = null;
      const filtrosIn: Array<{ campo: string; valores: unknown[] }> = [];
      const linhas = (): Record<string, unknown>[] => {
        if (tabela === "contact_phones") return extrasAtuais;
        if (tabela !== "messages") return [];
        // Só casa o que o coletor pede pelo caminho JSON, como o banco faria.
        return MENSAGENS.filter((m) =>
          filtrosIn.every((f) => f.valores.includes(caminho(m as Record<string, unknown>, f.campo) as never)),
        ) as Record<string, unknown>[];
      };
      const linhaUnica = (): Record<string, unknown> | null => {
        if (tabela === "organizations") return org;
        if (tabela !== "contacts" || colunas === null) return null;
        const pedidas = colunas;
        return Object.fromEntries(
          Object.entries(CONTATO_DO_BANCO).filter(([k]) => pedidas.includes(k)),
        ) as Record<string, unknown>;
      };
      const projetar = (rows: Record<string, unknown>[]) =>
        colunas === null
          ? rows
          : rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => colunas!.includes(k))));
      const q: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then")
              return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => {
                const data =
                  tabela === "organizations"
                    ? [org]
                    : tabela === "messages" || tabela === "contact_phones"
                      ? projetar(linhas())
                      : [];
                return Promise.resolve({ data, error: null, count: 0 }).then(ok, erro);
              };
            if (prop === "maybeSingle" || prop === "single")
              return async () => ({ data: linhaUnica(), error: null });
            if (prop === "select")
              return (sel?: string) => {
                if (typeof sel === "string") colunas = sel.split(",").map((c) => c.trim());
                return q;
              };
            if (prop === "in")
              return (campo: string, valores: unknown[]) => {
                filtrosIn.push({ campo, valores });
                return q;
              };
            return () => q;
          },
        },
      );
      return q;
    };
    return { from: consulta, rpc: async () => ({ data: null, error: null }) };
  },
}));

import { collectExportData } from "@/lib/lgpd/export-collector";

describe("export LGPD: os telefones extras da ficha", () => {
  it("o contato do data.json traz os extras com tipo, WhatsApp, rótulo, origem, lid e data", async () => {
    const p = await collectExportData({
      organizationId: ORG,
      requestId: "r1",
      contactId: CONTATO,
      externalCustomerId: null,
    });
    // CONTROLE: a ficha foi lida (senão o caso abaixo vazio por outro motivo).
    expect(p.contact?.phone_number).toBe("+5511999998888");
    expect(p.contact?.additional_phones).toEqual([
      {
        phone_number: "+5521977776666",
        tipo: "celular",
        whatsapp: "sim",
        rotulo: "Trabalho",
        origem: "fusao",
        wa_lid: "lidExtra",
        created_at: "2026-10-02T10:00:00.000Z",
      },
    ]);
  });

  it("a mensagem de grupo casada pelo número EXTRA e pelo lid do extra entra na exportação", async () => {
    const p = await collectExportData({
      organizationId: ORG,
      requestId: "r2",
      contactId: CONTATO,
      externalCustomerId: null,
    });
    const ids = p.group_messages_authored.map((m) => m.id).sort();
    // Principal (CONTROLE: a busca de antes continua valendo) + extra por número + extra por lid.
    expect(ids).toEqual(["msg-extra-por-lid", "msg-extra-por-numero", "msg-principal"]);
    // A mensagem de OUTRO participante não entra.
    expect(ids).not.toContain("msg-de-outro");
  });

  it("ficha sem extra não ganha a chave additional_phones (o data.json sai como saía)", async () => {
    extrasAtuais = [];
    try {
      const p = await collectExportData({
        organizationId: ORG,
        requestId: "r3",
        contactId: CONTATO,
        externalCustomerId: null,
      });
      // CONTROLE: o contato foi lido; a diferença é só a chave ausente.
      expect(p.contact?.phone_number).toBe("+5511999998888");
      expect("additional_phones" in (p.contact ?? {})).toBe(false);
    } finally {
      extrasAtuais = [EXTRA_DO_BANCO];
    }
  });
});
