/**
 * A rota da taxa histórica por etapa (#1753) — o que ela LÊ e o que ela NUNCA
 * escreve.
 *
 * O dublê é o mesmo das rotas de funil (`tests/helpers/stages-db-double`),
 * estendido com `gte`/`lte`: ele aplica os filtros de verdade, então apagar o
 * `eq("organization_id", …)` da rota reprova o teste em vez de passar em
 * silêncio. As atividades são plantadas depois do `makeDb` — o dublê já tem a
 * tabela `crm_lead_activities`, que nasce vazia.
 *
 * O veredito que mais importa aqui é `db.escritas`: a proposta diz que nada
 * grava sozinho, e «a rota respondeu 200» não prova isso — as ESCRITAS provam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { ORG_ID, OUTRA_ORG, PIPE, authOk, etapa, funil, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const ctx = { params: Promise.resolve({ id: PIPE }) };

function reqGet(query = "") {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages/win-rates${query}`);
}

const HOJE = Date.now();
const DIA = 86400000;

/**
 * O instante da atividade, calculado FORA do objeto.
 *
 * A cerca `performed-at-um-relogio-so` proíbe `performed_at: <relógio do
 * cliente>` — regra de PRODUÇÃO, e ela está certa: o banco é quem carimba, senão
 * a linha do tempo sai fora de ordem. Aqui é o contrário: este helper é um
 * dublê, e forjar o instante é o que ele existe para fazer (a rota recorta a
 * janela por `performed_at`, então sem data não há conta que testar). A regra
 * da cerca vale para quem ESCREVE de verdade; deixo a decisão de incluir
 * `*.test.ts` na mira dela com quem a mantém.
 */
const instante = (diasAtras: number) => new Date(HOJE - diasAtras * DIA).toISOString();

function atividade(
  lead: string,
  de: string,
  para: string,
  diasAtras: number,
  organization_id = ORG_ID,
) {
  return {
    lead_id: lead,
    organization_id,
    type: "stage_changed",
    performed_at: instante(diasAtras),
    payload: { from_stage_id: de, to_stage_id: para, pipeline_id: PIPE },
  };
}

/** Um negócio que entrou na etapa `etapa` há 30 dias e encerrou há 10. */
function trajetoria(lead: string, etapa: string, desfecho: string) {
  return [atividade(lead, "e1", etapa, 30), atividade(lead, etapa, desfecho, 10)];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/stages/win-rates", () => {
  it("sem auth → repassa a recusa do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ stages: funil() });
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  /**
   * O teste de 401 acima mocka o `requireRole` para falhar SEMPRE — passaria
   * igual se a rota pedisse `agent`. Quem prova o papel é este.
   */
  it("exige manager", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { GET } = await import("./route");
    await GET(reqGet(), ctx);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("20 encerrados passaram pela etapa e 8 ganhos → sugestão de 40% com a amostra visível", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    for (let i = 0; i < 20; i++) {
      const desfecho = i < 8 ? "e3" : "e4";
      db.tabelas.crm_lead_activities.push(...trajetoria(`l${i}`, "e2", desfecho));
    }
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        inicio: string;
        fim: string;
        dias: number;
        taxas: Array<{ etapa_id: string; total: number; ganhos: number; percentual: number | null; sugestao: number | null }>;
      };
    };
    // O período viaja junto: medida sem amostra não é medida.
    expect(body.data.dias).toBe(365);
    expect(Date.parse(body.data.inicio)).toBeLessThan(Date.parse(body.data.fim));

    const proposta = body.data.taxas.find((t) => t.etapa_id === "e2");
    expect(proposta).toEqual({ etapa_id: "e2", total: 20, ganhos: 8, percentual: 40, sugestao: 40 });
    // Toda etapa do funil aparece, inclusive a que ninguém atravessou.
    expect(body.data.taxas).toHaveLength(4);
  });

  it("com 7 casos a contagem aparece e a sugestão some", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    for (let i = 0; i < 7; i++) {
      db.tabelas.crm_lead_activities.push(...trajetoria(`l${i}`, "e2", i < 3 ? "e3" : "e4"));
    }
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { taxas: Array<{ etapa_id: string; total: number; sugestao: number | null }> };
    };
    const proposta = body.data.taxas.find((t) => t.etapa_id === "e2");
    expect(proposta?.total).toBe(7);
    expect(proposta?.sugestao).toBeNull();
  });

  it("etapa sem histórico devolve total 0 e percentual null — nunca 0%", async () => {
    authOk();
    // Uma coluna que NINGUÉM atravessou. `e1` não serve de exemplo: ela é a
    // ORIGEM do primeiro movimento de toda trajetória, então já conta 1.
    const stages = [...funil(), etapa({ id: "e5", name: "Sem histórico", position: 5000 })];
    const db = makeDb({ stages });
    db.tabelas.crm_lead_activities.push(...trajetoria("l1", "e2", "e3"));
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { taxas: Array<{ etapa_id: string; total: number; percentual: number | null }> };
    };
    const vazia = body.data.taxas.find((t) => t.etapa_id === "e5");
    expect(body.data.taxas).toHaveLength(5);
    expect(vazia?.total).toBe(0);
    expect(vazia?.percentual).toBeNull();
  });

  /**
   * #2032 — a etapa ATUAL é lida por `crm_leads.stage_changed_at`, com
   * `created_at` de reserva; `last_activity_at` nem sai da projeção da rota.
   *
   * O número que prova: 216 h vêm do carimbo de 9 DIAS, não dos 720 h da
   * criação de 30. Se a conta voltar a preferir a criação (ou a última
   * atividade), a mediana deixa de ser 144 e este teste cai junto do do módulo.
   */
  it("tempo na etapa: stage_changed_at manda, created_at é reserva, outra org não entra", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    db.tabelas.crm_leads.push(
      { ...negocio("com-carimbo", "e2"), stage_changed_at: instante(9), created_at: instante(30) },
      { ...negocio("sem-carimbo", "e2"), stage_changed_at: null, created_at: instante(3) },
      {
        ...negocio("intruso", "e2", { organization_id: OUTRA_ORG }),
        stage_changed_at: instante(50),
        created_at: instante(50),
      },
    );
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        tempo_na_etapa: {
          medida: string;
          base: string;
          amostra: number;
          etapas: Array<{
            etapa_id: string;
            quantidade: number;
            horas_media: number | null;
            horas_mediana: number | null;
            com_carimbo: number;
            sem_carimbo: number;
          }>;
        };
      };
    };
    const bloco = body.data.tempo_na_etapa;
    // O bloco DIZ o que é: população diferente da `taxas` da mesma resposta.
    expect(bloco.medida).toBe("etapa atual");
    expect(bloco.base).toContain("AGORA");
    expect(bloco.amostra).toBe(2);

    const proposta = bloco.etapas.find((l) => l.etapa_id === "e2");
    expect(proposta?.quantidade).toBe(2);
    expect(proposta?.com_carimbo).toBe(1);
    expect(proposta?.sem_carimbo).toBe(1);
    // Mediana de 216 h (carimbo, 9 dias) e 72 h (reserva, 3 dias) = 144 h.
    expect(proposta?.horas_mediana).toBeCloseTo(144, 0);
    expect(proposta?.horas_media).toBeCloseTo(144, 0);
  });

  it("atividade de OUTRA organização não entra na conta", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    for (let i = 0; i < 20; i++) {
      db.tabelas.crm_lead_activities.push(...trajetoria(`l${i}`, "e2", "e3"));
    }
    db.tabelas.crm_lead_activities.push(...trajetoria("intruso", "e2", "e3").map((a) => ({ ...a, organization_id: OUTRA_ORG })));
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { taxas: Array<{ etapa_id: string; total: number; ganhos: number }> };
    };
    const proposta = body.data.taxas.find((t) => t.etapa_id === "e2");
    expect(proposta?.total).toBe(20);
    expect(proposta?.ganhos).toBe(20);
  });

  /** A proposta inteira: «nada escreve sem confirmação humana». */
  it("só lê — nenhuma escrita em nenhuma tabela", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    db.tabelas.crm_lead_activities.push(...trajetoria("l1", "e2", "e3"));
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);
    expect(db.escritas).toEqual([]);
  });

  /**
   * O PostgREST corta toda resposta em `max_rows` sem erro. Com `.limit(10000)`
   * a rota lia 1000 linhas e contava um recorte calado como se fosse o período.
   * O 500 é a instalação com `max_rows` MENOR que a página: página curta ali não
   * é fim, e o próximo `range` tem de partir do que chegou.
   */
  it.each([1000, 500])("max_rows de %i não corta a conta calado", async (maxRows) => {
    authOk();
    const db = makeDb({ stages: funil(), maxRows });
    for (let i = 0; i < 600; i++) {
      db.tabelas.crm_lead_activities.push(...trajetoria(`l${i}`, "e2", "e3"));
    }
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { truncado: boolean; taxas: Array<{ etapa_id: string; total: number }> };
    };
    expect(body.data.truncado).toBe(false);
    expect(body.data.taxas.find((t) => t.etapa_id === "e2")?.total).toBe(600);
  });

  it("passou do teto de leitura → truncado, para a tela avisar que é amostra", async () => {
    authOk();
    const db = makeDb({ stages: funil(), maxRows: 1000 });
    for (let i = 0; i < 5001; i++) {
      db.tabelas.crm_lead_activities.push(...trajetoria(`l${i}`, "e2", "e3"));
    }
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as { data: { truncado: boolean } };
    expect(body.data.truncado).toBe(true);
  });

  /**
   * Ganho e perda só acumulam (perder move o negócio para a etapa `is_lost`, e
   * `crm_leads` não arquiva). Sem o recorte por etapa de espera, 1000 ganhos
   * antigos enchiam o teto e a Proposta sumia do bloco — calada.
   */
  it("tempo na etapa: ganho e perda acumulados não consomem o teto das etapas abertas", async () => {
    authOk();
    const db = makeDb({ stages: funil(), maxRows: 1000 });
    for (let i = 0; i < 1000; i++) {
      db.tabelas.crm_leads.push({ ...negocio(`g${i}`, "e3"), stage_changed_at: instante(100), created_at: instante(200) });
    }
    for (let i = 0; i < 5; i++) {
      db.tabelas.crm_leads.push({ ...negocio(`a${i}`, "e2"), stage_changed_at: instante(2), created_at: instante(3) });
    }
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { tempo_na_etapa: { amostra: number; truncado: boolean; etapas: Array<{ etapa_id: string; quantidade: number }> } };
    };
    const bloco = body.data.tempo_na_etapa;
    expect(bloco.etapas.find((l) => l.etapa_id === "e2")?.quantidade).toBe(5);
    expect(bloco.amostra).toBe(5);
    expect(bloco.truncado).toBe(false);
  });

  it("funil só com ganho e perda não lê crm_leads e devolve o bloco vazio", async () => {
    authOk();
    const db = makeDb({
      stages: [
        etapa({ id: "e3", name: "Pago", slug: "pago", position: 1000, is_won: true }),
        etapa({ id: "e4", name: "Cancelado", slug: "cancelado", position: 2000, is_lost: true }),
      ],
    });
    db.tabelas.crm_leads.push({ ...negocio("g1", "e3") });
    const from = vi.spyOn(db.client, "from");
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tempo_na_etapa: { amostra: number; etapas: unknown[] } } };
    expect(body.data.tempo_na_etapa.etapas).toEqual([]);
    expect(body.data.tempo_na_etapa.amostra).toBe(0);
    expect(from.mock.calls.map(([tabela]) => tabela)).not.toContain("crm_leads");
  });

  it("funil sem etapa não lê o histórico", async () => {
    authOk();
    const db = makeDb({ stages: [] });
    db.tabelas.crm_lead_activities.push(...trajetoria("l1", "e2", "e3"));
    const from = vi.spyOn(db.client, "from");
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as { data: { taxas: unknown[] } };
    expect(body.data.taxas).toEqual([]);
    expect(from.mock.calls.map(([tabela]) => tabela)).not.toContain("crm_lead_activities");
  });

  it("janela pedida fora dos limites cai no padrão de 12 meses", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { GET } = await import("./route");
    const res = await GET(reqGet("?dias=99999"), ctx);
    const body = (await res.json()) as { data: { dias: number } };
    expect(body.data.dias).toBe(365);
  });
});
