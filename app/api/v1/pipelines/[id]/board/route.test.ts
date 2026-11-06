/**
 * O QUADRO DEIXA DE TRAZER OS ENCERRADOS ANTIGOS (#2995).
 *
 * O quadro do funil traz TODO negócio não arquivado — os ganhos e as perdas de
 * meses atrás inclusive — e a tela não oferecia nada para tirá-los: num funil
 * com histórico longo ele fica ilegível. A opção é POR FUNIL e mora no
 * `settings` que o funil já tem (`ocultar_encerrados_dias`), sem coluna nova e
 * sem migration.
 *
 * Estes casos exercitam a ROTA de verdade (dublê de banco que APLICA os
 * filtros) porque é a rota que monta a lista; um teste só da regra pura ficaria
 * verde com a regra nunca chamada. As réguas do aceite:
 *
 *  1. ligada em 30 dias: ganho há 40 NÃO sai, ganho há 2 SAI;
 *  2. encerrado SEM data de encerramento SAI — não se inventa encerramento;
 *  3. negócio ABERTO há 40 dias SAI sempre (por antigo que seja);
 *  4. o corte é por DATA DE ENCERRAMENTO, não por `is_active` nem por última
 *     atividade: ganho de ontem cuja última atividade é de meses atrás fica, e
 *     perda de 90 dias atrás sai;
 *  5. sem a opção (ou com `0`), o quadro traz EXATAMENTE o que trazia.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
  })),
}));

import { PIPE, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const STAGE = "e2";
const DIA = 24 * 60 * 60 * 1000;
/** A data como o banco a devolve, sempre em ISO — `closed_at` é `timestamptz`. */
const haDias = (dias: number) => new Date(Date.now() - dias * DIA).toISOString();

/**
 * O funil de controle, com um negócio de cada régua. Os DIAS são folgados de
 * propósito quanto à fronteira: 40 × 2 contra um corte de 30, para o caso não
 * depender do relógio parado entre a montagem e a leitura.
 */
const QUADRO = [
  negocio("ganho-40", STAGE, { status: "won", closed_at: haDias(40), position_in_stage: 10 }),
  negocio("ganho-2", STAGE, { status: "won", closed_at: haDias(2), position_in_stage: 20 }),
  negocio("perdido-90", STAGE, { status: "lost", closed_at: haDias(90), position_in_stage: 30 }),
  negocio("encerrado-sem-data", STAGE, {
    status: "lost",
    closed_at: null,
    position_in_stage: 40,
  }),
  negocio("aberto-40", STAGE, {
    status: "open",
    closed_at: null,
    created_at: haDias(40),
    last_activity_at: haDias(40),
    position_in_stage: 50,
  }),
  negocio("ganho-2-atividade-velha", STAGE, {
    status: "won",
    closed_at: haDias(2),
    last_activity_at: haDias(120),
    updated_at: haDias(120),
    position_in_stage: 60,
  }),
];

/** Os que FICAM no quadro com a opção ligada em 30 dias. */
const COM_RECORTE = [
  "aberto-40",
  "encerrado-sem-data",
  "ganho-2",
  "ganho-2-atividade-velha",
];

const SEM_RECORTE = QUADRO.map((l) => l.id).sort();

function dbDoFunil(settings: Record<string, unknown>, leads = QUADRO) {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings })],
    leads,
  });
}

async function quadroDoBoard(qs = ""): Promise<{ status: number; ids: string[] }> {
  const { GET } = await import("./route");
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board${qs}`),
    { params: Promise.resolve({ id: PIPE }) },
  );
  const body = (await res.json()) as { data?: { leads: Array<{ id: string }> } };
  return { status: res.status, ids: (body.data?.leads ?? []).map((l) => l.id).sort() };
}

describe("GET /board — recorte de encerrados antigos (#2995)", () => {
  it("⭐ com a opção em 30 dias, o ganho de 40 dias sai e o de 2 dias fica", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 30 });

    const { status, ids } = await quadroDoBoard();

    expect(status).toBe(200);
    expect(ids).toEqual(COM_RECORTE);
    // Explícito, para a leitura do vermelho dizer o defeito sem cruzar listas:
    // hoje (sem o recorte) estes dois vêm no quadro.
    expect(ids).not.toContain("ganho-40");
    expect(ids).not.toContain("perdido-90");
  });

  it("⭐ o negócio pedido em `?lead=` fica no quadro mesmo escondido pelo recorte — o dossiê abre", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 30 });

    const { status, ids } = await quadroDoBoard("?lead=perdido-90");

    expect(status).toBe(200);
    expect(ids).toEqual([...COM_RECORTE, "perdido-90"].sort());
    expect(ids).not.toContain("ganho-40");
  });

  it("⭐ sem a opção, o quadro traz exatamente o que trazia — a leitura de hoje", async () => {
    dbDoFunil({ fields: [], lost_reasons: [] });

    const { status, ids } = await quadroDoBoard();

    expect(status).toBe(200);
    expect(ids).toEqual(SEM_RECORTE);
  });

  it("com a opção em 0 (desligada), também traz tudo", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 0 });

    expect((await quadroDoBoard()).ids).toEqual(SEM_RECORTE);
  });

  it("o corte é por DATA de encerramento: ganho de 2 dias fica mesmo com atividade de 120", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 30 });

    const { ids } = await quadroDoBoard();

    // `last_activity_at`/`updated_at` velhos não são encerramento: quem decide é
    // `closed_at`. Trocar a régua por "última atividade" tiraria do quadro o
    // negócio fechado ontem que ninguém tocou desde o começo do ano.
    expect(ids).toContain("ganho-2-atividade-velha");
  });

  it("negócio ABERTO há 40 dias fica sempre — é o que precisa de atenção", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 1 });

    const { ids } = await quadroDoBoard();

    expect(ids).toContain("aberto-40");
    expect(ids).not.toContain("ganho-2");
  });

  it("funil que só tem ganho antigo fica VAZIO com o recorte ligado (o settings é do funil pedido)", async () => {
    dbDoFunil({ ocultar_encerrados_dias: 30 }, [QUADRO[0]!]);

    const { ids } = await quadroDoBoard();

    expect(ids).toEqual([]);
  });
});

describe("GET /board — a ordem do quadro é ESTÁVEL (#3461)", () => {
  /**
   * Dois cards que empatam em `position_in_stage` (o lote antigo gravava a
   * mesma posição em N linhas) saíam na ordem que o plano devolvesse — ordem
   * que o Postgres não promete entre duas leituras. Na tela isso é o card
   * trocando de lugar a cada render, sem ninguém arrastar.
   *
   * O desempate por `id` vive na TELA também (`compararNaEtapa`, coberto em
   * `lib/kanban/entrada-na-etapa.test.ts`), mas o contrato do servidor é este:
   * a leitura precisa PEDIR o desempate. Sem isso, o cliente recebe uma lista
   * cuja ordem entre empatados já nasceu arbitrária, e comparador nenhum
   * conserta — ele só reordena o que já veio.
   *
   * Prova o pedido, não a obediência do Postgres (`ORDER BY ... , id` é
   * determinístico por definição).
   */
  it("a leitura do quadro pede `id` como desempate depois da posição", () => {
    const fonte = readFileSync(
      join(process.cwd(), "app/api/v1/pipelines/[id]/board/route.ts"),
      "utf8",
    );
    // Os COMENTÁRIOS saem antes da medida: eles citam `.order("id")` para
    // explicar a régua, e um comentário não ordena nada. Sem esta linha, apagar
    // a chamada de verdade deixaria o caso verde — medido na sabotagem S3.
    const codigo = fonte
      .split("\n")
      .filter((linha) => !linha.trim().startsWith("//"))
      .join("\n");
    expect(codigo).toMatch(/\.order\("position_in_stage"\)[\s\S]{0,200}\.order\("id"\)/);
  });
});
