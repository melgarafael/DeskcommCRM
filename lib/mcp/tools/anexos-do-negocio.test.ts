/**
 * O DOCUMENTO DO CARD PELO MCP (#4544, item 2).
 *
 * O caso real: apólice em PDF anexada no negócio, e o agente sem como descobrir
 * o id nem ler o arquivo — o card ficava sem o número da apólice. Aqui os cinco
 * casos que sustentam a entrega, um por requisito:
 *
 *   (a) a listagem devolve os campos do anexo (id, nome, tipo, tamanho, data);
 *   (b) a leitura devolve o TEXTO do documento — extração real do pdfjs, com a
 *       fixture do repositório, não um mock de extração;
 *   (c) negócio de outra organização e negócio de outro contato do turno são
 *       RECUSADOS (e a query leva `organization_id` — a cerca é do banco);
 *   (d) anexo inexistente recusa com erro legível;
 *   (e) o `attachment_id` que a listagem devolve é aceito pela
 *       `crm_propose_lead_fields_from_document` — a costura que fecha o caso.
 *
 * O que NÃO se mocka de propósito: o caminho de leitura (`extrairTextoDoArquivo`
 * + `isLeadAttachmentPathOwnedBy`) e o schema das ferramentas. Só o Storage
 * (rede) e as bordas que falam com outros módulos (`proporCamposDoNegocio`,
 * `audit`) são dublados.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const proporCampos = vi.fn();

vi.mock("@/lib/leads/proposta-de-campos-por-documento", () => ({
  proporCamposDoNegocio: (...args: unknown[]) => proporCampos(...args),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

/** O Storage é a única borda de rede: `download` devolve os bytes da fixture. */
const baixar = vi.fn();
const bucketPedido: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => {
        bucketPedido.push(bucket);
        return { download: baixar };
      },
    },
  }),
}));

import type { McpContext } from "@/lib/mcp/types";

import {
  crmGetLeadAttachment,
  crmListLeadAttachments,
  crmProposeLeadFieldsFromDocument,
} from "./leads";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ANEXO = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const OUTRO_CONTATO = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  filtros: Record<string, unknown>;
}

/**
 * Dublê do client Supabase: honra `eq`/`maybeSingle`/`order` e GUARDA os filtros
 * de cada consulta — é assim que o teste cobra a cerca de organização em vez de
 * confiar que ela está no código.
 */
function bancoFalso(tabelas: Record<string, Linha[]>) {
  const consultas: Consulta[] = [];

  function from(tabela: string) {
    const consulta: Consulta = { tabela, filtros: {} };
    consultas.push(consulta);
    const linhas = () =>
      (tabelas[tabela] ?? []).filter((r) =>
        Object.entries(consulta.filtros).every(([coluna, valor]) => r[coluna] === valor),
      );

    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        consulta.filtros[coluna] = valor;
        return q;
      },
      order: () => q,
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: unknown, ko: unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok as never, ko as never),
    };
    return q;
  }

  return { from, consultas };
}

/** O caminho que o upload grava no Storage — o que a cerca de posse confere. */
function caminhoDoAnexo(org: string, lead: string, id: string) {
  return `${org}/leads/${lead}/apolice/${id}.pdf`;
}

function anexoDaFixture(over: Linha = {}): Linha {
  return {
    id: ANEXO,
    lead_id: LEAD,
    organization_id: ORG,
    field_key: "apolice",
    file_name: "apolice.pdf",
    file_size: 512,
    mime_type: "application/pdf",
    created_at: "2026-11-02T12:00:00.000Z",
    storage_path: caminhoDoAnexo(ORG, LEAD, ANEXO),
    ...over,
  };
}

function bancoPadrao(over: { leads?: Linha[]; anexos?: Linha[] } = {}) {
  return bancoFalso({
    crm_leads: over.leads ?? [{ id: LEAD, organization_id: ORG, contact_id: CONTATO }],
    crm_lead_attachments: over.anexos ?? [anexoDaFixture()],
    contacts: [],
  });
}

function ctxCom(db: ReturnType<typeof bancoFalso>, extra: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "api_token", id: "tok" },
    requestId: "req-anexos",
    supabase: db,
    ...extra,
  } as unknown as McpContext;
}

beforeEach(() => {
  baixar.mockReset();
  bucketPedido.length = 0;
  proporCampos.mockReset();
});

describe("crm_list_lead_attachments — o documento do card", () => {
  it("lista devolve os campos do anexo (id, nome, tipo, tamanho, criado em)", async () => {
    const db = bancoPadrao();

    const r = (await crmListLeadAttachments.handler(
      { lead_id: LEAD },
      ctxCom(db),
    )) as { anexos: Array<Record<string, unknown>>; total: number };

    expect(r.total).toBe(1);
    expect(r.anexos[0]).toMatchObject({
      id: ANEXO,
      nome: "apolice.pdf",
      tipo: "application/pdf",
      tamanho_bytes: 512,
      criado_em: "2026-11-02T12:00:00.000Z",
      campo: "apolice",
    });
    // A listagem não toca no Storage: listar é metadado.
    expect(baixar).not.toHaveBeenCalled();
  });

  it("lê o conteúdo do documento anexado pelo MESMO caminho de extração do acervo", async () => {
    const pdf = readFileSync(join(process.cwd(), "tests/fixtures/sample-text.pdf"));
    baixar.mockResolvedValue({
      data: new Blob([pdf], { type: "application/pdf" }),
      error: null,
    });

    const r = (await crmGetLeadAttachment.handler(
      { lead_id: LEAD, attachment_id: ANEXO },
      ctxCom(bancoPadrao()),
    )) as { anexo: Record<string, unknown> };

    expect(r.anexo.legivel_como_texto).toBe(true);
    // O texto sai do PDF de verdade (fixture do repo), não de um mock de extração.
    expect(r.anexo.conteudo).toMatch(/RAG fixture/);
    expect(r.anexo.motivo).toBeNull();
    // Baixou do bucket dos anexos, pelo caminho que o negócio possui.
    expect(baixar).toHaveBeenCalledWith(caminhoDoAnexo(ORG, LEAD, ANEXO));
    expect(bucketPedido).toContain("internal-media");
  });

  it("recusa anexo de negócio de outra organização e negócio fora do escopo do turno", async () => {
    // O negócio existe — na OUTRA organização.
    const dbOutra = bancoPadrao({
      leads: [{ id: LEAD, organization_id: OUTRA_ORG, contact_id: CONTATO }],
      anexos: [anexoDaFixture({ organization_id: OUTRA_ORG })],
    });

    const deOutra = (await crmGetLeadAttachment.handler(
      { lead_id: LEAD, attachment_id: ANEXO },
      ctxCom(dbOutra),
    )) as { erro: { codigo: string; mensagem: string } };

    expect(deOutra.erro.codigo).toBe("negocio_nao_encontrado");
    // A cerca é do BANCO: a consulta do negócio levou a organização de quem pede.
    expect(dbOutra.consultas[0]?.filtros).toMatchObject({ organization_id: ORG });
    // ...e nada foi baixado antes das cercas.
    expect(baixar).not.toHaveBeenCalled();

    // Mesma organização, contato DIFERENTE do turno: recusa nomeada.
    const foraDaConversa = await crmGetLeadAttachment.handler(
      { lead_id: LEAD, attachment_id: ANEXO },
      ctxCom(bancoPadrao(), { contatoDoTurno: OUTRO_CONTATO }),
    );

    expect(foraDaConversa).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(baixar).not.toHaveBeenCalled();
  });

  it("recusa anexo inexistente com erro legível", async () => {
    const db = bancoPadrao({ anexos: [] });

    const r = (await crmGetLeadAttachment.handler(
      { lead_id: LEAD, attachment_id: ANEXO },
      ctxCom(db),
    )) as { erro: { codigo: string; mensagem: string } };

    expect(r.erro.codigo).toBe("anexo_nao_encontrado");
    expect(r.erro.mensagem.length).toBeGreaterThan(20);
    expect(r.erro.mensagem).toMatch(/anexo/i);
  });

  it("o attachment_id da listagem é aceito por crm_propose_lead_fields_from_document", async () => {
    proporCampos.mockResolvedValue({
      criadas: [{ id: "prop-1", campo: "apolice", valorProposto: "AP-9981", valorAnterior: null }],
      recusadas: [],
    });

    const ctx = ctxCom(bancoPadrao());
    const lista = (await crmListLeadAttachments.handler({ lead_id: LEAD }, ctx)) as {
      anexos: Array<{ id: string }>;
    };
    const attachmentId = lista.anexos[0]!.id;

    // O id que a listagem devolve passa pelo schema da ferramenta de proposta...
    const entrada = z.object(crmProposeLeadFieldsFromDocument.inputSchema).parse({
      lead_id: LEAD,
      attachment_id: attachmentId,
      campos: [{ campo: "apolice", valor: "AP-9981", trecho: "Apólice nº AP-9981" }],
    });

    const r = (await crmProposeLeadFieldsFromDocument.handler(entrada, ctx)) as {
      propostas_criadas: unknown[];
    };

    // ...e chega à régua de proposta como `attachmentId` — a costura do caso real.
    // Primeiro argumento é o client do banco; o que interessa é o payload.
    expect(proporCampos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attachmentId, leadId: LEAD, organizationId: ORG }),
    );
    expect(r.propostas_criadas).toHaveLength(1);
  });
});
