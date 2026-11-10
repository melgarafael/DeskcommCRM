// @vitest-environment node
/**
 * AS DUAS ROTAS DA FILA DO CARD (#3316) — e as duas provas que fecharam o #3415.
 *
 * ─── O que este arquivo MEDE ───────────────────────────────────────────────
 *
 * O #3415 tinha rota verde e três defeitos que o teste de rota não pegava:
 *
 *  1. **Auditoria com conteúdo pessoal.** `lead.field_confirmed` gravava
 *     `valor_gravado` e `lead.field_rejected` gravava `valor_recusado` — o dado
 *     do passageiro lido do voucher copiado para o audit, que é append-only e
 *     não tem `lead_id` nem caminho de limpeza. As provas aqui são
 *     DISCRIMINANTES: o valor pessoal é uma string única, e o teste reprova se
 *     ela aparecer em QUALQUER lugar do metadata (inclusive aninhada).
 *  2. **`expires_at` que ninguém cobrava.** A leitura da fila devolvia proposta
 *     vencida e a decisão a aceitava. Aqui o banco falso APLICA o `.gt()` e o
 *     `.lt()` de verdade — tirar o filtro faz o teste falhar, em vez de passar
 *     por construção —, e a decisão de uma vencida é cobrada como 409 SEM
 *     chamar a porta que grava.
 *
 * O falso de Supabase aplica `eq`/`gt`/`lt` e guarda o que foi atualizado: é o
 * mínimo para que "filtrou de verdade" seja uma asserção e não uma suposição.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";

type Linha = Record<string, unknown>;
interface Resultado {
  data: unknown;
  error: { message: string; code?: string } | null;
}

const h = vi.hoisted(() => {
  const estado = {
    db: {} as Record<string, Linha[]>,
    auditados: [] as { action: string; metadata?: unknown }[],
    gravacoesNoCard: [] as { leadId: string; patch: unknown }[],
    /** O funil de hoje — o teste pode trocá-lo antes de decidir. */
    funil: null as unknown,
    erroProfundo: null as { message: string; code?: string } | null,
    erroNaGravacao: null as Error | null,
  };
  return estado;
});

const ORG = "9a0b7e00-0000-4000-8000-000000000001";
const LEAD = "c2b0b7e0-0000-4000-8000-000000000003";
const PID = "f4b0b7e0-0000-4000-8000-000000000005";
/** O dado do passageiro — único, para o teste poder caçá-lo no audit. */
const VALOR_PESSOAL = "LOCALIZADOR-SECRETO-DO-PASSAGEIRO";

const FUNIL = {
  fields: [
    { key: "localizador", label: "Localizador", type: "text" },
    { key: "destino", label: "Destino", type: "text" },
  ],
};

/** Um cliente Supabase mínimo que APLICA os filtros e registra updates. */
function clienteFalso() {
  function consulta(tabela: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    let op: "select" | "update" = "select";
    let patch: Linha | null = null;
    const linhas = () => (h.db[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const executa = (): Resultado => {
      if (h.erroProfundo) return { data: null, error: h.erroProfundo };
      if (op === "update" && patch) {
        const alvo = linhas();
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      return { data: linhas(), error: null };
    };
    const b = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] === valor);
        return b;
      },
      gt: (coluna: string, valor: unknown) => {
        filtros.push((l) => String(l[coluna]) > String(valor));
        return b;
      },
      lt: (coluna: string, valor: unknown) => {
        filtros.push((l) => String(l[coluna]) < String(valor));
        return b;
      },
      update: (p: Linha) => {
        op = "update";
        patch = p;
        return b;
      },
      maybeSingle: async (): Promise<Resultado> => {
        const r = executa();
        const arr = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
        return { data: arr[0] ?? null, error: r.error };
      },
      single: async (): Promise<Resultado> => {
        const r = executa();
        const arr = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
        return { data: arr[0] ?? null, error: r.error };
      },
      then: (ok: (r: Resultado) => unknown) => Promise.resolve(executa()).then(ok),
    };
    return b;
  }
  return { from: (tabela: string) => consulta(tabela) };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteFalso() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    org: { orgId: ORG },
    user: { id: "u1", idioma: "pt-BR" },
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async (e: { action: string; metadata?: unknown }) => {
    h.auditados.push({ action: e.action, metadata: e.metadata });
  },
}));
vi.mock("@/lib/leads/campos-exigidos", () => ({ settingsDoFunil: async () => h.funil }));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  updateLeadHandler: async (_db: unknown, _ctx: unknown, leadId: string, patch: unknown) => {
    if (h.erroNaGravacao) throw h.erroNaGravacao;
    h.gravacoesNoCard.push({ leadId, patch });
    return { id: leadId };
  },
}));

import { GET } from "@/app/api/v1/leads/[id]/field-proposals/route";
import { POST } from "@/app/api/v1/leads/[id]/field-proposals/[pid]/route";
import { confereCampoLido } from "@/lib/leads/proposta-de-campos-por-documento";

function ctx(id = LEAD, pid = PID) {
  return { params: Promise.resolve({ id, pid }) };
}

function proposta(over: Linha = {}): Linha {
  return {
    id: PID,
    organization_id: ORG,
    lead_id: LEAD,
    campo: "localizador",
    valor_proposto: VALOR_PESSOAL,
    valor_anterior: null,
    trecho: `Localizador: ${VALOR_PESSOAL}`,
    status: "pending",
    attachment_id: null,
    proposed_at: "2026-10-20T10:00:00.000Z",
    expires_at: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    decided_at: null,
    ...over,
  };
}

function requisicao(corpo?: unknown) {
  return new NextRequest("http://localhost/api/v1/leads/x/field-proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: corpo === undefined ? null : JSON.stringify(corpo),
  });
}

beforeEach(() => {
  h.db = {
    crm_leads: [{ id: LEAD, organization_id: ORG, pipeline_id: "p1", custom_fields: {} }],
    lead_field_proposals: [],
  };
  h.auditados = [];
  h.gravacoesNoCard = [];
  h.funil = FUNIL;
  h.erroProfundo = null;
  h.erroNaGravacao = null;
});

describe("a confirmação conserva o número que a revisão mostrou", () => {
  it.each([
    { tipo: "number", documento: "1,234", esperado: 1.234 },
    { tipo: "number", documento: "1.234,567", esperado: 1234.567 },
    { tipo: "currency", documento: "-1,234", esperado: -1.234 },
    { tipo: "number", documento: "1234.56", esperado: 1234.56 },
  ] as const)("$tipo: $documento não muda de escala ao salvar", async ({ tipo, documento, esperado }) => {
    const campo = { key: "medida", label: "Medida", type: tipo };
    // A mesma leitura que cria a proposta: o jsonb guarda um NÚMERO, não o
    // texto regional do documento. A decisão usa esse dado já tipado.
    const leitura = confereCampoLido(campo, documento);
    expect(leitura).toEqual({ ok: true, valor: esperado });
    if (!leitura.ok) return;
    h.funil = { fields: [campo] };
    h.db.lead_field_proposals = [proposta({ campo: campo.key, valor_proposto: leitura.valor })];

    const r = await POST(requisicao({ decision: "accept" }), ctx());

    expect(r.status).toBe(200);
    expect(h.gravacoesNoCard).toEqual([
      { leadId: LEAD, patch: { custom_fields: { medida: esperado } } },
    ]);
    expect((await r.json()).data.valor).toBe(esperado);
  });

  it("correção digitada continua sendo lida como texto do formulário", async () => {
    h.funil = { fields: [{ key: "medida", label: "Medida", type: "number" }] };
    h.db.lead_field_proposals = [proposta({ campo: "medida", valor_proposto: 1.234 })];

    const r = await POST(requisicao({ decision: "accept", valor: "9,876" }), ctx());

    expect(r.status).toBe(200);
    expect(h.gravacoesNoCard).toEqual([
      { leadId: LEAD, patch: { custom_fields: { medida: 9.876 } } },
    ]);
  });

  it("número já tipado continua sujeito ao padrão atual do funil", async () => {
    h.funil = { fields: [{ key: "medida", label: "Medida", type: "number", padrao: "^[0-9]+$" }] };
    h.db.lead_field_proposals = [proposta({ campo: "medida", valor_proposto: 1.234 })];

    const r = await POST(requisicao({ decision: "accept" }), ctx());

    expect(r.status).toBe(422);
    expect(h.gravacoesNoCard).toHaveLength(0);
    expect(h.db.lead_field_proposals[0]!.status).toBe("pending");
  });
});

// ─── A LEITURA ──────────────────────────────────────────────────────────────

describe("GET da fila: proposta vencida NÃO é elegível (#3316)", () => {
  it("⭐ a vencida some da fila e a viva fica — o filtro é do banco", async () => {
    h.db.lead_field_proposals = [
      proposta({ id: "vencida", campo: "localizador", expires_at: "2020-01-01T00:00:00.000Z" }),
      proposta({
        id: "viva",
        campo: "destino",
        valor_proposto: "Maceió",
        expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }),
    ];

    const r = await GET(requisicao() as never, { params: Promise.resolve({ id: LEAD }) });
    const corpo = (await r.json()) as { data: { propostas: { id: string }[] } };

    expect(r.status).toBe(200);
    expect(corpo.data.propostas.map((p) => p.id)).toEqual(["viva"]);
  });

  it("o prazo limite (`expires_at` = agora) também não passa — vencida é `<=`", async () => {
    // O `.gt()` do banco e o `propostaVencida` do lib têm de concordar no sinal:
    // um deles usando `<` deixaria a proposta do instante exato em um lado só.
    h.db.lead_field_proposals = [
      proposta({ id: "no-limite", expires_at: new Date(Date.now() - 1000).toISOString() }),
    ];

    const r = await GET(requisicao() as never, { params: Promise.resolve({ id: LEAD }) });
    const corpo = (await r.json()) as { data: { propostas: unknown[] } };
    expect(corpo.data.propostas).toHaveLength(0);
  });
});

// ─── A DECISÃO: PRAZO ───────────────────────────────────────────────────────

describe("POST da decisão: expiração vale ANTES de qualquer gravação (#3316)", () => {
  it("⭐ vencida: 409, encerrada como `expired` e o card NÃO é tocado", async () => {
    h.db.lead_field_proposals = [
      proposta({ expires_at: "2020-01-01T00:00:00.000Z" }),
    ];

    const r = await POST(requisicao({ decision: "accept" }), ctx());
    const corpo = (await r.json()) as { error: { code: string; message: string } };

    expect(r.status).toBe(409);
    expect(corpo.error.code).toBe("proposal_expired");
    expect(corpo.error.message).toContain("venceu");
    // A linha deixou de ser pendente: a varredura não precisa passar por ela.
    expect(h.db.lead_field_proposals[0]!.status).toBe("expired");
    // E o card NÃO recebeu nada — aceitar uma leitura de um prazo que passou
    // gravaria no card um dado que o documento já não garante.
    expect(h.gravacoesNoCard).toHaveLength(0);
  });

  it("vencida nem se DESCARTA: o 409 é o mesmo, e nada é decidido em nome de quem clicou", async () => {
    h.db.lead_field_proposals = [proposta({ expires_at: "2020-01-01T00:00:00.000Z" })];

    const r = await POST(requisicao({ decision: "dismiss" }), ctx());

    expect(r.status).toBe(409);
    expect(h.db.lead_field_proposals[0]!.status).toBe("expired");
  });

  it("viva e pendente: aceita, grava pela porta de edição e devolve 200", async () => {
    h.db.lead_field_proposals = [proposta()];

    const r = await POST(requisicao({ decision: "accept" }), ctx());

    expect(r.status).toBe(200);
    expect(h.gravacoesNoCard).toEqual([
      { leadId: LEAD, patch: { custom_fields: { localizador: VALOR_PESSOAL } } },
    ]);
    expect(h.db.lead_field_proposals[0]!.status).toBe("accepted");
  });
});

describe("falha ao gravar o card mantém a proposta pendente e o protocolo da API", () => {
  it("erro inesperado devolve JSON 500 genérico sem copiar conteúdo pessoal", async () => {
    h.db.lead_field_proposals = [proposta()];
    h.erroNaGravacao = new Error(`Falha inesperada com ${VALOR_PESSOAL}`);

    const r = await POST(requisicao({ decision: "accept" }), ctx());
    const corpo = await r.json();

    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("x-request-id")).toBeTruthy();
    expect(corpo).toEqual({
      error: { code: "internal_error", message: "Não foi possível gravar o dado." },
    });
    expect(JSON.stringify(corpo)).not.toContain(VALOR_PESSOAL);
    expect(h.db.lead_field_proposals[0]).toMatchObject({
      status: "pending", decided_at: null, decided_by_user_id: null,
    });
    expect(h.auditados).toHaveLength(0);
  });

  it("ApiError conserva o código, a mensagem e o status esperados", async () => {
    h.db.lead_field_proposals = [proposta()];
    h.erroNaGravacao = new ApiError(
      422, "custom_field_pattern_mismatch", undefined, "pedido-da-prova", "Valor fora do padrão.",
    );

    const r = await POST(requisicao({ decision: "accept" }), ctx());

    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      error: { code: "custom_field_pattern_mismatch", message: "Valor fora do padrão." },
    });
    expect(h.db.lead_field_proposals[0]).toMatchObject({
      status: "pending", decided_at: null, decided_by_user_id: null,
    });
    expect(h.auditados).toHaveLength(0);
  });
});

// ─── A AUDITORIA: SÓ METADADO ───────────────────────────────────────────────

describe("a auditoria da decisão NÃO copia o conteúdo pessoal (#3316)", () => {
  it("⭐ `lead.field_confirmed` sem o valor gravado — nem na raiz, nem aninhado", async () => {
    h.db.lead_field_proposals = [proposta()];

    const r = await POST(requisicao({ decision: "accept" }), ctx());
    expect(r.status).toBe(200);

    const evento = h.auditados.find((a) => a.action === "lead.field_confirmed");
    expect(evento).toBeDefined();

    // A prova DISCRIMINANTE: se `valor_gravado` (ou qualquer cópia do valor)
    // voltar ao metadata, esta linha reprova. O `#3415` gravava exatamente
    // `valor_gravado: conferido.valor`.
    const serializado = JSON.stringify(evento?.metadata ?? {});
    expect(serializado).not.toContain(VALOR_PESSOAL);
    expect(serializado).not.toContain("valor_gravado");

    // E o que PRECISA estar: a rastreabilidade sem conteúdo.
    expect(evento?.metadata).toMatchObject({
      proposal_id: PID,
      campo: "localizador",
      origem: "documento",
      corrigido_pela_pessoa: false,
    });
  });

  it("⭐ `lead.field_rejected` sem o valor recusado e sem o motivo livre", async () => {
    h.db.lead_field_proposals = [proposta()];

    const r = await POST(
      // O motivo cita o dado de propósito: é texto de PESSOA, e o lugar dele é
      // `motivo_recusa` (coluna redigida pela cascata), nunca o audit.
      requisicao({ decision: "dismiss", motivo: `leu errado: ${VALOR_PESSOAL}` }),
      ctx(),
    );
    expect(r.status).toBe(200);

    const evento = h.auditados.find((a) => a.action === "lead.field_rejected");
    const serializado = JSON.stringify(evento?.metadata ?? {});
    expect(serializado).not.toContain(VALOR_PESSOAL);
    expect(serializado).not.toContain("valor_recusado");
    expect(evento?.metadata).toMatchObject({
      proposal_id: PID,
      campo: "localizador",
      origem: "documento",
      tem_motivo: true,
    });

    // O motivo livre foi para a coluna que a cascata redige.
    expect(h.db.lead_field_proposals[0]!.motivo_recusa).toContain(VALOR_PESSOAL);
  });

  it("a expiração também só audita metadado (motivo: prazo)", async () => {
    h.db.lead_field_proposals = [proposta({ expires_at: "2020-01-01T00:00:00.000Z" })];

    await POST(requisicao({ decision: "accept" }), ctx());

    const evento = h.auditados.find((a) => a.action === "lead.field_rejected");
    expect(JSON.stringify(evento?.metadata ?? {})).not.toContain(VALOR_PESSOAL);
    expect(evento?.metadata).toMatchObject({ motivo: "prazo", origem: "documento" });
    expect(evento?.metadata).toHaveProperty("proposal_id", PID);
  });
});
