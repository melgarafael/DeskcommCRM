// @vitest-environment node
/**
 * QUEM SÓ LÊ (viewer) LÊ OS ANEXOS DO NEGÓCIO — issue #3431.
 *
 * ─── O defeito, medido na main antes do conserto ────────────────────────────
 *
 * O campo personalizado do tipo "Arquivo" (#3229) já existe, e o negócio já tem
 * anexo. Um usuário `viewer` abre o negócio: o `FileUploadCustomField` está
 * travado (ele não edita) e busca a lista assim mesmo. O `GET` da lista e o
 * `GET` da mídia pediam `agent`, então a rota respondia 403 `forbidden_role`, o
 * componente mostrava "Não foi possível carregar os anexos." e o cabeçalho do
 * campo dizia "0 arquivos" — um zero FALSO para quem só queria ver o documento.
 *
 * ─── O que estes casos provam ───────────────────────────────────────────────
 *
 * 1. `viewer` recebe a LISTA de anexos do negócio (é a leitura que o campo
 *    travado faz para mostrar a contagem e o link);
 * 2. `viewer` ABRE a mídia do anexo (302 para o link assinado) — ler o negócio
 *    inclui ler o documento dele;
 * 3. CONTROLE — `viewer` continua sem SUBIR arquivo (POST segue `agent`);
 * 4. CONTROLE — `viewer` continua sem APAGAR (DELETE segue `agent`);
 * 5. CONTROLE — `agent` continua lendo a lista (o afrouxamento não tirou nada
 *    de quem já podia).
 *
 * O `requireRole` falso abaixo respeita o ranking real (`ROLE_RANK`): a sessão
 * tem `papelDaSessao`, e a rota recusa se o mínimo que ela pede for maior. É o
 * que faz o caso 1 e o caso 3 conviverem: a leitura passa, a escrita não.
 *
 * Sabotagem prevista (escrita ANTES de reverter, ver ANEXO-VIEWER-SABOTAGEM.md):
 * devolvendo os dois `GET` para `requireRole("agent")`, caem os casos 1 e 2
 * (2 de 5) e os três controles seguem verdes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLE_RANK, type Role } from "@/lib/auth/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA = "66666666-6666-4666-8666-666666666666";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ANEXO = "88888888-8888-4888-8888-888888888888";
const CAMINHO = `${ORG}/leads/${LEAD}/comprovante/${ANEXO}.pdf`;

interface Resultado {
  data: unknown;
  error: { message: string } | null;
}

const h = vi.hoisted(() => {
  const db: Record<string, Record<string, unknown>[]> = {};
  const upload = vi.fn();
  const remove = vi.fn();
  const assinar = vi.fn();
  const audit = vi.fn();

  /**
   * Consulta encadeável que APLICA os `eq`/`in` vistos — sem isso uma rota que
   * esquecesse o `organization_id` passaria aqui por construção, e o teste
   * estaria mentindo a favor do produto.
   */
  function consulta(tabela: string) {
    const filtros: ((l: Record<string, unknown>) => boolean)[] = [];
    const executa = (): Resultado => ({
      data: (db[tabela] ?? []).filter((l) => filtros.every((f) => f(l))),
      error: null,
    });
    const primeira = async (): Promise<Resultado> => {
      const r = executa();
      const linhas = r.data as Record<string, unknown>[];
      return { data: linhas[0] ?? null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] === valor);
        return b;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push((l) => valores.includes(l[coluna]));
        return b;
      },
      maybeSingle: primeira,
      single: primeira,
      then: (ok: (r: Resultado) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(executa()).then(ok, falha),
    };
    return b;
  }

  return { db, consulta, upload, remove, assinar, audit };
});

let papelDaSessao: Role = "viewer";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (minimo: Role) => {
    if (ROLE_RANK[papelDaSessao] < ROLE_RANK[minimo]) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return {
      ok: true,
      user: { id: "55555555-5555-4555-8555-555555555555", idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: papelDaSessao },
    };
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.consulta }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: h.consulta,
    storage: { from: () => ({ upload: h.upload, remove: h.remove, createSignedUrl: h.assinar }) },
  }),
}));

import { DELETE, GET, POST } from "@/app/api/v1/leads/[id]/attachments/route";
import { GET as GET_MIDIA } from "@/app/api/v1/leads/[id]/attachments/[attachmentId]/media/route";

const ctx = { params: Promise.resolve({ id: LEAD }) };
const ctxDaMidia = { params: Promise.resolve({ id: LEAD, attachmentId: ANEXO }) };

const pedido = (metodo: string) =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: metodo });

beforeEach(() => {
  papelDaSessao = "viewer";
  for (const k of Object.keys(h.db)) delete h.db[k];
  h.db.crm_leads = [{ id: LEAD, organization_id: ORG, pipeline_id: FUNIL }];
  h.db.crm_pipelines = [
    {
      id: FUNIL,
      organization_id: ORG,
      settings: {
        fields: [
          { key: "comprovante", label: "Comprovante", type: "file", obrigatorio_em: { etapas: [ETAPA] } },
        ],
      },
    },
  ];
  h.db.crm_lead_attachments = [
    {
      id: ANEXO,
      organization_id: ORG,
      lead_id: LEAD,
      field_key: "comprovante",
      file_name: "contrato.pdf",
      file_size: 1024,
      mime_type: "application/pdf",
      storage_path: CAMINHO,
      created_at: "2026-10-24T10:00:00Z",
    },
  ];
  h.upload.mockReset().mockResolvedValue({ error: null });
  h.remove.mockReset().mockResolvedValue({ error: null });
  h.assinar
    .mockReset()
    .mockResolvedValue({ data: { signedUrl: "https://storage.local/assinado" }, error: null });
  h.audit.mockReset().mockResolvedValue(undefined);
});

describe("anexos do negócio — quem só lê (viewer) lê (#3431)", () => {
  it("viewer recebe a LISTA de anexos — o anexo que existe aparece, não '0 arquivos'", async () => {
    const res = await GET(pedido("GET"), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: { id: string; name: string }[] } };
    expect(corpo.data?.files).toHaveLength(1);
    expect(corpo.data?.files?.[0]).toMatchObject({ id: ANEXO, name: "contrato.pdf" });
  });

  it("viewer ABRE a mídia do anexo — 302 para o link assinado", async () => {
    const res = await GET_MIDIA(pedido("GET"), ctxDaMidia);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.local/assinado");
    expect(h.assinar).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: viewer NÃO sobe arquivo — o POST segue exigindo agent", async () => {
    const res = await POST(pedido("POST"), ctx);

    expect(res.status).toBe(403);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("forbidden_role");
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("CONTROLE: viewer NÃO apaga — o DELETE segue exigindo agent", async () => {
    const res = await DELETE(pedido("DELETE"), ctx);

    expect(res.status).toBe(403);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.db.crm_lead_attachments).toHaveLength(1);
  });

  it("CONTROLE: agent continua lendo a lista", async () => {
    papelDaSessao = "agent";

    const res = await GET(pedido("GET"), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { files?: unknown[] } };
    expect(corpo.data?.files).toHaveLength(1);
  });
});
