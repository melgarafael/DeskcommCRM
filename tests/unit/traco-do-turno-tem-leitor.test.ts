/**
 * O TRAÇO DO TURNO TEM LEITOR — GET /api/v1/ai/turn-traces (#3201).
 *
 * A issue é explícita: "nada lê a tabela. Até a tela existir, o traço é escrito
 * e não tem leitor". Esta rota é o leitor mínimo verificável, e o que ela
 * precisa provar é mais do que "respondeu 200":
 *
 *   1. LÊ DA ORGANIZAÇÃO DA SESSÃO — `.eq("organization_id", …)` na query, e
 *      não no corpo do pedido;
 *   2. a janela dela é a MESMA da poda (`AI_TELEMETRY_RETENTION_DAYS`), então o
 *      expurgo nunca apaga o que ela mostra; pedir além da retenção é
 *      TRUNCADO e DITO, não silenciado;
 *   3. o caso vazio diz POR QUE está vazio. Uma lista `[]` sem motivo é
 *      indistinguível de "a rota quebrou" — e é justamente o que a issue pede
 *      para a tela não fazer;
 *   4. os filtros que a tela vai usar (conversa, contato, status, prévia) viram
 *      cláusulas da query, e o limite é validado (nem NaN, nem -5, nem infinito).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { AI_TELEMETRY_RETENTION_DAYS: undefined } }));

const { GET } = await import("@/app/api/v1/ai/turn-traces/route");
const { COLUNAS_DO_TRACO, LIMITE_MAXIMO } =
  await import("@/lib/agent-engine/agent/recibo-do-traco");
const { JANELA_PADRAO_DIAS, janelaDaLeitura } = await import("@/lib/retencao/janela-do-traco");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const JOB = "66666666-6666-4666-8666-666666666666";

type Chamada = { metodo: string; args: unknown[] };

/** Cliente Supabase de mentira: registra a cadeia e devolve as linhas pedidas. */
function bancoFalso(linhas: Record<string, unknown>[] = []) {
  const chamadas: Chamada[] = [];
  const construtor: Record<string, unknown> = {};
  for (const metodo of ["select", "eq", "gte", "lt", "order", "limit"]) {
    construtor[metodo] = (...args: unknown[]) => {
      chamadas.push({ metodo, args });
      return construtor;
    };
  }
  construtor.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(resolve);
  const cliente = {
    from: (tabela: string) => {
      chamadas.push({ metodo: "from", args: [tabela] });
      return construtor;
    },
  };
  return { chamadas, cliente };
}

const chamadasDe = (chamadas: Chamada[], metodo: string) =>
  chamadas.filter((c) => c.metodo === metodo);
const argsDe = (chamadas: Chamada[], metodo: string) =>
  chamadasDe(chamadas, metodo).map((c) => c.args);

function sessao() {
  return {
    ok: true as const,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" as const },
    org: { orgId: ORG_ID, role: "manager" as const },
  };
}

async function pedir(qs = "") {
  return GET(new NextRequest(`http://localhost/api/v1/ai/turn-traces${qs}`));
}

const corpo = async (res: Response) =>
  ((await res.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue(sessao() as never);
});

describe("o leitor lê a organização da sessão", () => {
  it("a query filtra organization_id pela sessão — nunca pelo pedido", async () => {
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const res = await pedir(`?conversation_id=${CONVERSA}`);
    expect(res.status).toBe(200);

    expect(argsDe(chamadas, "from")).toEqual([["agent_turn_traces"]]);
    expect(argsDe(chamadas, "eq")).toContainEqual(["organization_id", ORG_ID]);
    // A query NÃO pede `select *`: a projeção é nominal (PII).
    expect(argsDe(chamadas, "select")).toEqual([[COLUNAS_DO_TRACO]]);
  });

  it("sem sessão, a resposta do portão sobe inteira (não consulta o banco)", async () => {
    const negado = { ok: false as const, response: new Response("nope", { status: 403 }) };
    vi.mocked(requireRole).mockResolvedValue(negado as never);
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const res = await pedir();
    expect(res.status).toBe(403);
    expect(chamadasDe(chamadas, "from")).toHaveLength(0);
  });
});

describe("os filtros da tela viram cláusulas", () => {
  it("conversa, contato, job, status e tipo de execução", async () => {
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    await pedir(
      `?conversation_id=${CONVERSA}&contact_id=${CONTATO}&job_id=${JOB}&status=failed&tipo=previa&limite=10`,
    );

    const eqs = argsDe(chamadas, "eq");
    expect(eqs).toContainEqual(["conversation_id", CONVERSA]);
    expect(eqs).toContainEqual(["contact_id", CONTATO]);
    expect(eqs).toContainEqual(["job_id", JOB]);
    expect(eqs).toContainEqual(["status", "failed"]);
    // "previa" é `is_dry_run = true` na coluna — o vocabulário é da tela, não do banco.
    expect(eqs).toContainEqual(["is_dry_run", true]);
    expect(argsDe(chamadas, "limit")).toEqual([[10]]);
    expect(argsDe(chamadas, "order")).toEqual([["created_at", { ascending: false }]]);
  });

  it("tipo=real e tipo=previa não se confundem", async () => {
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    await pedir("?tipo=real");
    expect(argsDe(chamadas, "eq")).toContainEqual(["is_dry_run", false]);
  });
});

describe("o limite é validado — não é Number() solto", () => {
  it.each(["0", "-5", "201", "abc", "1.5"])("limite=%s → 422", async (bruto) => {
    const { cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const res = await pedir(`?limite=${bruto}`);
    expect(res.status).toBe(422);
    expect(LIMITE_MAXIMO).toBe(200);
  });

  it("sem limite, o padrão é 50", async () => {
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    await pedir();
    expect(argsDe(chamadas, "limit")).toEqual([[50]]);
  });
});

describe("a janela do leitor é a janela da poda", () => {
  it("o padrão é o mesmo default de AI_TELEMETRY_RETENTION_DAYS (400)", async () => {
    const { cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const dados = await corpo(await pedir());
    // 400 é RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO: o MESMO número que o cron
    // passa para fn_expurgar_traco_do_turno_vencido.
    expect(dados.retencao_dias).toBe(400);
    expect(dados.truncado_pela_retencao).toBe(false);
    expect((dados.janela as { dias: number }).dias).toBe(JANELA_PADRAO_DIAS);
  });

  it("pedir além da retenção é TRUNCADO e dito, não silenciado", async () => {
    const { chamadas, cliente } = bancoFalso();
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const dados = await corpo(await pedir("?desde=2024-01-01"));
    expect(dados.truncado_pela_retencao).toBe(true);
    // A janela pedida começa em 2024 e a resposta começa no limite do que existe.
    expect((dados.janela as { de: string }).de > "2024-01-01").toBe(true);
    const [desde] = argsDe(chamadas, "gte")[0] as [string];
    expect(desde > "2024-01-01").toBe(true);
  });

  it("janelaDaLeitura é pura: mesma entrada, mesma saída", () => {
    const agora = new Date("2026-10-26T12:00:00.000Z");
    const a = janelaDaLeitura({}, 400, agora);
    const b = janelaDaLeitura({}, 400, agora);
    expect(a).toEqual(b);
    expect(a.dias).toBe(JANELA_PADRAO_DIAS);
    // Pedir 10 dias atrás NÃO é truncado: está dentro dos 400.
    expect(janelaDaLeitura({ desde: "2026-10-16" }, 400, agora).truncada).toBe(false);
    // Pedir 500 dias atrás é.
    expect(janelaDaLeitura({ desde: "2025-06-01" }, 400, agora).truncada).toBe(true);
  });
});

describe("o caso vazio DIZ por que está vazio", () => {
  it("sem nenhum traço na janela: motivo nomeado, lista vazia e 200", async () => {
    const { cliente } = bancoFalso([]);
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const res = await pedir();
    expect(res.status).toBe(200);
    const dados = await corpo(res);
    expect(dados.tracos).toEqual([]);
    expect(dados.total).toBe(0);
    expect(dados.motivo_do_vazio).toBe("nenhum_turno_na_janela");
  });

  it("janela truncada mas ainda consultável não afirma que houve expurgo", async () => {
    const { cliente } = bancoFalso([]);
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const dados = await corpo(await pedir("?desde=2023-01-01"));
    expect(dados.motivo_do_vazio).toBe("nenhum_turno_na_janela");
  });

  it("com traço, o motivo do vazio é nulo (o contrário também tem de ser medido)", async () => {
    const { cliente } = bancoFalso([
      { id: "t1", status: "completed", created_at: "2026-10-26T10:00:00Z" },
    ]);
    vi.mocked(createClient).mockResolvedValue(cliente as never);

    const dados = await corpo(await pedir());
    expect(dados.motivo_do_vazio).toBeNull();
    expect(dados.total).toBe(1);
    expect((dados.tracos as unknown[])[0]).toMatchObject({ id: "t1" });
  });
});

describe("o leitor não inventa PII", () => {
  it("a projeção é de METADADOS do turno — nenhuma coluna de texto de mensagem", () => {
    // A projeção permanece fechada. Erros legados podem conter texto pessoal;
    // os controles de conteúdo e JSON estão nos testes próprios do recibo.
    expect(COLUNAS_DO_TRACO).toContain("ferramentas");
    expect(COLUNAS_DO_TRACO).toContain("tokens_in");
    expect(COLUNAS_DO_TRACO).toContain("created_at");
    expect(COLUNAS_DO_TRACO).not.toMatch(/\bbody\b|message_body|conteudo|texto_da_mensagem/);
  });
});
