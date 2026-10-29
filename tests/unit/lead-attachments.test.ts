// @vitest-environment node
/**
 * ANEXOS DE NEGÓCIO (#3229) — as rotas e a cascata rodando de verdade, com o
 * banco e o Storage falsificados.
 *
 * O falso APLICA os filtros (`eq`/`in`): uma rota que esqueça o
 * `organization_id` acha a linha do vizinho aqui, como acharia com o cliente
 * admin em produção. Por isso os casos de outra organização reprovam quem tirar
 * o filtro, em vez de passarem por construção.
 *
 * O que é do BANCO (RLS da tabela, a poda de órfãos) está em
 * `tests/invariants/anexo-de-lead-isolamento-e-poda.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Linha = Record<string, unknown>;
interface Resultado {
  data: unknown;
  error: { message: string } | null;
}
interface Consulta {
  select: (colunas?: string) => Consulta;
  order: (...args: unknown[]) => Consulta;
  limit: (n: number) => Consulta;
  not: (...args: unknown[]) => Consulta;
  eq: (coluna: string, valor: unknown) => Consulta;
  in: (coluna: string, valores: unknown[]) => Consulta;
  insert: (linha: Linha) => Consulta;
  upsert: (linha: Linha, opcoes?: unknown) => Consulta;
  delete: () => Consulta;
  maybeSingle: () => Promise<Resultado>;
  single: () => Promise<Resultado>;
  then: (ok: (r: Resultado) => unknown, falha?: (e: unknown) => unknown) => Promise<unknown>;
}

const h = vi.hoisted(() => {
  const db: Record<string, Linha[]> = {};
  const deletes: { tabela: string; filtros: string[] }[] = [];

  function consulta(tabela: string): Consulta {
    const filtros: ((l: Linha) => boolean)[] = [];
    const nomes: string[] = [];
    let op: "select" | "insert" | "upsert" | "delete" = "select";
    let nova: Linha | null = null;
    const linhas = () => (db[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const executa = (): Resultado => {
      if ((op === "insert" || op === "upsert") && nova) {
        const l = { created_at: "2026-10-22T00:00:00Z", ...nova };
        (db[tabela] ??= []).push(l);
        return { data: l, error: null };
      }
      if (op === "delete") {
        deletes.push({ tabela, filtros: [...nomes] });
        const fora = new Set(linhas());
        db[tabela] = (db[tabela] ?? []).filter((l) => !fora.has(l));
        return { data: null, error: null };
      }
      return { data: linhas(), error: null };
    };
    const primeira = async (): Promise<Resultado> => {
      const r = executa();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };
    const b: Consulta = {
      select: () => b,
      order: () => b,
      limit: () => b,
      not: () => b,
      eq: (coluna, valor) => {
        nomes.push(coluna);
        filtros.push((l) => l[coluna] === valor);
        return b;
      },
      in: (coluna, valores) => {
        nomes.push(coluna);
        filtros.push((l) => valores.includes(l[coluna]));
        return b;
      },
      insert: (linha) => {
        op = "insert";
        nova = linha;
        return b;
      },
      upsert: (linha) => {
        op = "upsert";
        nova = linha;
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      maybeSingle: primeira,
      single: primeira,
      then: (ok, falha) => Promise.resolve(executa()).then(ok, falha),
    };
    return b;
  }

  return {
    db,
    deletes,
    consulta,
    upload: vi.fn(),
    remove: vi.fn(),
    assinar: vi.fn(),
    audit: vi.fn(),
    rpc: vi.fn(),
    org: "11111111-1111-4111-8111-111111111111",
  };
});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    org: { orgId: h.org },
    user: { id: "55555555-5555-4555-8555-555555555555", idioma: "pt-BR" },
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.consulta }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: h.consulta,
    rpc: h.rpc,
    storage: { from: () => ({ upload: h.upload, remove: h.remove, createSignedUrl: h.assinar }) },
  }),
}));

import { DELETE, POST } from "@/app/api/v1/leads/[id]/attachments/route";
import { GET as GET_MIDIA } from "@/app/api/v1/leads/[id]/attachments/[attachmentId]/media/route";
import { cascadeRedactContact } from "@/lib/lgpd/redact-cascade";
import { camposComAnexo, validaCamposExigidos } from "@/lib/leads/campos-exigidos";

const ORG = h.org;
const OUTRA = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const FUNIL_OUTRA = "44444444-4444-4444-8444-000000000002";
const ETAPA = "66666666-6666-4666-8666-666666666666";
const CONTATO = "77777777-7777-4777-8777-777777777777";
const LEAD = "22222222-2222-4222-8222-222222222222";
const LEAD_OUTRA = "22222222-2222-4222-8222-000000000002";
const ANEXO = "88888888-8888-4888-8888-888888888888";
const ANEXO_OUTRA = "88888888-8888-4888-8888-000000000002";
const CAMINHO = `${ORG}/leads/${LEAD}/comprovante/${ANEXO}.pdf`;
const CAMINHO_OUTRA = `${OUTRA}/leads/${LEAD_OUTRA}/comprovante/${ANEXO_OUTRA}.pdf`;
// Linha da PRÓPRIA organização cujo caminho não está sob o prefixo do negócio.
const ANEXO_FORA = "88888888-8888-4888-8888-000000000003";
// Negócio que o usuário não enxerga (no falso: não está em `crm_leads`).
const LEAD_INVISIVEL = "22222222-2222-4222-8222-000000000003";
const ANEXO_INVISIVEL = "88888888-8888-4888-8888-000000000004";

const CAMPOS = [
  { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA] } },
  { key: "obs", label: "Observação", type: "text" },
];

function anexo(id: string, org: string, lead: string, caminho: string): Linha {
  return {
    id,
    organization_id: org,
    lead_id: lead,
    field_key: "comprovante",
    file_name: "comprovante.pdf",
    file_size: 4,
    mime_type: "application/pdf",
    storage_path: caminho,
    created_at: "2026-10-21T00:00:00Z",
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postArquivo(lead: string, fieldKey: string): NextRequest {
  const form = new FormData();
  form.append("field_key", fieldKey);
  form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "voucher.pdf", { type: "application/pdf" }));
  return new NextRequest(`http://localhost/api/v1/leads/${lead}/attachments`, { method: "POST", body: form });
}

function deleteAnexo(lead: string, attachmentId: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${lead}/attachments`, {
    method: "DELETE",
    body: JSON.stringify({ field_key: "comprovante", attachment_id: attachmentId }),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  for (const k of Object.keys(h.db)) delete h.db[k];
  h.deletes.length = 0;
  h.db.crm_pipelines = [
    { id: FUNIL, organization_id: ORG, settings: { fields: CAMPOS } },
    { id: FUNIL_OUTRA, organization_id: OUTRA, settings: { fields: CAMPOS } },
  ];
  h.db.crm_leads = [
    { id: LEAD, organization_id: ORG, pipeline_id: FUNIL, contact_id: CONTATO },
    { id: LEAD_OUTRA, organization_id: OUTRA, pipeline_id: FUNIL_OUTRA, contact_id: CONTATO },
  ];
  h.db.crm_lead_attachments = [
    anexo(ANEXO, ORG, LEAD, CAMINHO),
    anexo(ANEXO_OUTRA, OUTRA, LEAD_OUTRA, CAMINHO_OUTRA),
  ];
  h.db.contacts = [{ id: CONTATO, organization_id: ORG, avatar_storage_path: null }];
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.remove.mockReset().mockResolvedValue({ error: null });
  h.assinar.mockReset().mockResolvedValue({ data: { signedUrl: "https://storage.local/assinado" }, error: null });
  h.audit.mockReset().mockResolvedValue(undefined);
  h.rpc.mockReset().mockResolvedValue({ data: { already_anonymized: false, counts: {}, media_paths: [] }, error: null });
});

describe("GET da mídia do anexo", () => {
  it("anexo de OUTRA organização: 404 e nenhum link é assinado", async () => {
    const res = await GET_MIDIA(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: LEAD_OUTRA, attachmentId: ANEXO_OUTRA }),
    });
    expect(res.status).toBe(404);
    expect(h.assinar).not.toHaveBeenCalled();
  });

  it("caminho fora do prefixo do negócio: 404 e nenhum link é assinado", async () => {
    h.db.crm_lead_attachments?.push(anexo(ANEXO_FORA, ORG, LEAD, CAMINHO_OUTRA));
    const res = await GET_MIDIA(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: LEAD, attachmentId: ANEXO_FORA }),
    });
    expect(res.status).toBe(404);
    expect(h.assinar).not.toHaveBeenCalled();
  });

  it("anexo da própria organização: 302 para o link curto, sem cache", async () => {
    const res = await GET_MIDIA(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: LEAD, attachmentId: ANEXO }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.local/assinado");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.assinar).toHaveBeenCalledWith(CAMINHO, 60);
  });
});

describe("POST do anexo", () => {
  it("chave fora da régua do funil (`../`) é recusada antes de tocar o Storage", async () => {
    const res = await POST(postArquivo(LEAD, "../../outra"), ctx(LEAD));
    expect(res.status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("campo que não é `file` no funil do negócio é recusado", async () => {
    const res = await POST(postArquivo(LEAD, "obs"), ctx(LEAD));
    expect(res.status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("negócio de OUTRA organização: 404 e nada sobe", async () => {
    const res = await POST(postArquivo(LEAD_OUTRA, "comprovante"), ctx(LEAD_OUTRA));
    expect(res.status).toBe(404);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("upload válido sobe no prefixo da organização e grava a linha dela", async () => {
    const res = await POST(postArquivo(LEAD, "comprovante"), ctx(LEAD));
    expect(res.status).toBe(201);
    const caminho = h.upload.mock.calls[0]?.[0] as string;
    expect(caminho.startsWith(`${ORG}/leads/${LEAD}/comprovante/`)).toBe(true);
    const nova = h.db.crm_lead_attachments?.find((l) => l.storage_path === caminho);
    expect(nova).toMatchObject({ organization_id: ORG, lead_id: LEAD, field_key: "comprovante" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lead.attachment_uploaded" }));
  });
});

describe("DELETE do anexo", () => {
  it("anexo de OUTRA organização: 404, a linha fica e nada sai do Storage", async () => {
    const res = await DELETE(deleteAnexo(LEAD_OUTRA, ANEXO_OUTRA), ctx(LEAD_OUTRA));
    expect(res.status).toBe(404);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments?.some((l) => l.id === ANEXO_OUTRA)).toBe(true);
  });

  it("caminho fora do prefixo do negócio: 404, nada sai do Storage e a linha fica", async () => {
    h.db.crm_lead_attachments?.push(anexo(ANEXO_FORA, ORG, LEAD, CAMINHO_OUTRA));
    const res = await DELETE(deleteAnexo(LEAD, ANEXO_FORA), ctx(LEAD));
    expect(res.status).toBe(404);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments?.some((l) => l.id === ANEXO_FORA)).toBe(true);
  });

  it("negócio que o usuário não enxerga: 404, nada sai do Storage e a linha fica", async () => {
    const caminho = `${ORG}/leads/${LEAD_INVISIVEL}/comprovante/${ANEXO_INVISIVEL}.pdf`;
    h.db.crm_lead_attachments?.push(anexo(ANEXO_INVISIVEL, ORG, LEAD_INVISIVEL, caminho));
    const res = await DELETE(deleteAnexo(LEAD_INVISIVEL, ANEXO_INVISIVEL), ctx(LEAD_INVISIVEL));
    expect(res.status).toBe(404);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments?.some((l) => l.id === ANEXO_INVISIVEL)).toBe(true);
  });

  it("anexo da própria organização: sai do Storage e da tabela", async () => {
    const res = await DELETE(deleteAnexo(LEAD, ANEXO), ctx(LEAD));
    expect(res.status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith([CAMINHO]);
    expect(h.db.crm_lead_attachments?.some((l) => l.id === ANEXO)).toBe(false);
  });
});

describe("cascata de anonimização (LGPD)", () => {
  it("enfileira o arquivo do negócio do titular e apaga a linha — e só a dele", async () => {
    // O negócio do vizinho aponta para o MESMO contato de propósito: só o
    // `organization_id` separa os dois.
    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: "pedido-1" });

    expect(h.db.storage_redaction_queue).toEqual([
      expect.objectContaining({ organization_id: ORG, bucket: "internal-media", object_path: CAMINHO }),
    ]);
    expect(h.db.crm_lead_attachments?.map((l) => l.id)).toEqual([ANEXO_OUTRA]);
    expect(h.deletes).toContainEqual({ tabela: "crm_lead_attachments", filtros: ["organization_id", "lead_id"] });
  });

  it("caminho fora do prefixo do negócio não vai para a fila de remoção", async () => {
    h.db.crm_lead_attachments?.push(anexo(ANEXO_FORA, ORG, LEAD, CAMINHO_OUTRA));
    await cascadeRedactContact({ organizationId: ORG, contactId: CONTATO, requestId: "pedido-2" });

    // controle positivo: o anexo legítimo do mesmo negócio entra.
    expect(h.db.storage_redaction_queue).toEqual([
      expect.objectContaining({ organization_id: ORG, bucket: "internal-media", object_path: CAMINHO }),
    ]);
    expect(h.db.crm_lead_attachments?.map((l) => l.id)).toEqual([ANEXO_OUTRA]);
  });
});

describe("régua de etapa — campo de arquivo conta a tabela, não `custom_fields`", () => {
  const settings = { fields: CAMPOS };
  const destino = { stageId: ETAPA, desfecho: null };

  it("uma lista forjada em `custom_fields` não passa a régua", () => {
    const veredito = validaCamposExigidos({
      lead: { custom_fields: { comprovante: [{ id: "x", name: "falso.pdf" }] } },
      settingsDoFunil: settings,
      destino,
    });
    expect(veredito.faltando.map((f) => f.chave)).toEqual(["comprovante"]);
  });

  it("o anexo na tabela passa a régua", async () => {
    const supabase = { from: h.consulta } as unknown as Parameters<typeof camposComAnexo>[0];
    const comAnexo = await camposComAnexo(supabase, settings, ORG, LEAD);
    expect([...comAnexo]).toEqual(["comprovante"]);
    expect(
      validaCamposExigidos({ lead: { custom_fields: {} }, settingsDoFunil: settings, destino, camposComAnexo: comAnexo })
        .faltando,
    ).toEqual([]);
  });

  it("o anexo do negócio de OUTRA organização não conta", async () => {
    const supabase = { from: h.consulta } as unknown as Parameters<typeof camposComAnexo>[0];
    expect([...(await camposComAnexo(supabase, settings, ORG, LEAD_OUTRA))]).toEqual([]);
  });
});
