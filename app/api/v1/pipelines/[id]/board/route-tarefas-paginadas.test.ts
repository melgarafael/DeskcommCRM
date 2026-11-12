/**
 * O SELO DE TAREFAS DO QUADRO NÃO PODE CORTAR CALADO (#4321).
 *
 * A leitura dos NEGÓCIOS já foi paginada (#4331): o PostgREST cortava em 1.000
 * e o quadro chegava incompleto. Mas o quadro não lê só os negócios: para o
 * selo do card ele lê `crm_tasks` de todos eles — e essa leitura, como as
 * outras de apoio, ia num `.in(lead_id, lote)` SEM `.range()`. `buscaEmLotes`
 * quebra o `.in()` em lotes de 100 ids (pelo teto de URL do header), e cada
 * lote era UMA consulta: o PostgREST cortava aquele lote em 1.000 linhas, sem
 * erro. `crm_tasks` é justamente a tabela que cresce COM O FILHO — uma dúzia de
 * tarefas abertas por negócio é rotina num funil grande —, então os cards do
 * fim do lote perdiam o selo e a tela dizia "nenhuma tarefa pendente".
 *
 * As réguas deste arquivo:
 *
 *  (a) 100 negócios com 12 tarefas abertas cada (1.200 linhas, acima do
 *      `max_rows = 1000`) devolvem o selo em TODOS os 100 cards — o número que
 *      o defeito escondia é este: antes vinham 1.000 linhas e ~17 cards sem
 *      selo;
 *  (b) a leitura de `crm_tasks` passou a pedir `.range()` — provado no builder
 *      capturado, não por leitura do texto da rota;
 *  (c) o quadro pequeno continua sem aviso nenhum: `truncado` só aparece quando
 *      alguma leitura NÃO conseguiu provar o fim.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
  })),
}));

import { createClient } from "@/lib/supabase/server";
import {
  ORG_ID,
  PIPE,
  etapa,
  funilRow,
  makeDb,
  negocio,
  type DbOpts,
} from "@/tests/helpers/stages-db-double";

const NEGOCIOS = 100;
const TAREFAS_POR_NEGOCIO = 12; // 1.200 linhas — acima dos 1.000 do PostgREST

/** O funil com `settings` vazio: nenhum campo `file`, nenhum recorte ligado. */
function banco(opts: DbOpts = {}) {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
    stages: [etapa({ id: "e1", name: "Novo", position: 1000 })],
    ...opts,
  });
}

function semearNegocios(total: number) {
  // `status` e `position_in_stage` NÃO são decoração: a leitura do quadro filtra
  // `.neq("status","archived")` (e o dublê, como o SQL, descarta NULL) e ordena
  // por posição. Sem elas o quadro voltaria vazio e o teste mediria o dublê.
  return Array.from({ length: total }, (_, i) =>
    negocio(`n${String(i).padStart(4, "0")}`, "e1", {
      status: "open",
      position_in_stage: i * 10,
      contact_id: null,
    }),
  );
}

function semearTarefas(negocios: Array<{ id: string }>) {
  return negocios.flatMap((n) =>
    Array.from({ length: TAREFAS_POR_NEGOCIO }, (_, k) => ({
      id: `t-${n.id}-${String(k).padStart(2, "0")}`,
      organization_id: ORG_ID,
      lead_id: n.id,
      status: "pending" as const,
      due_date: null,
    })),
  );
}

async function lerQuadro(): Promise<{
  status: number;
  corpo: {
    data?: { leads?: Array<Record<string, unknown>>; truncado?: true };
  };
  headers: Headers;
}> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
    params: Promise.resolve({ id: PIPE }),
  });
  return { status: res.status, corpo: (await res.json()) as never, headers: res.headers };
}

/**
 * Dublê que CAPTURA o builder — a mesma técnica do `route-paginacao.test.ts`,
 * e pelo mesmo motivo: um `.range()` que só existe dentro de um comentário não
 * pagina nada, e o teste tem de medir a consulta MONTADA.
 */
function bancoQueRegistra(opts: DbOpts = {}) {
  const db = banco(opts);
  const real = db.client as unknown as {
    from: (t: string) => Record<string, unknown>;
    rpc: unknown;
    auth: unknown;
  };
  const consultas: Array<{ tabela: string; chamadas: Array<{ metodo: string; args: unknown[] }> }> =
    [];

  const client = {
    rpc: real.rpc,
    auth: real.auth,
    from(tabela: string) {
      const alvo = real.from(tabela);
      const registro = { tabela, chamadas: [] as Array<{ metodo: string; args: unknown[] }> };
      consultas.push(registro);
      const soma: unknown = new Proxy(alvo, {
        get(obj, prop) {
          const valor = Reflect.get(obj, prop);
          if (typeof valor !== "function") return valor;
          return (...args: unknown[]) => {
            registro.chamadas.push({ metodo: String(prop), args });
            const r = (valor as (...a: unknown[]) => unknown).apply(obj, args);
            return r === obj ? soma : r;
          };
        },
      });
      return soma;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return {
    db,
    /** As consultas emitidas contra `crm_tasks`. */
    leiturasDeTarefas() {
      const achadas = consultas.filter((c) => c.tabela === "crm_tasks");
      if (achadas.length === 0) throw new Error("a rota não leu crm_tasks");
      return achadas.flatMap((c) => c.chamadas);
    },
  };
}

const selo = (lead: Record<string, unknown>): number | undefined =>
  (lead.tarefas as { abertas?: number } | undefined)?.abertas;

describe("GET /board — o selo de tarefas não corta em 1.000 (#4321)", () => {
  it("⭐ (a) 100 negócios × 12 tarefas abertas: TODOS os cards têm o selo (1.200 linhas)", async () => {
    const leads = semearNegocios(NEGOCIOS);
    banco({ leads, tasks: semearTarefas(leads), maxRows: 1000 });

    const { status, corpo } = await lerQuadro();
    expect(status).toBe(200);

    const cards = corpo.data?.leads ?? [];
    expect(cards).toHaveLength(NEGOCIOS);

    const comSelo = cards.filter((c) => selo(c) === TAREFAS_POR_NEGOCIO);
    const semSelo = cards.filter((c) => selo(c) !== TAREFAS_POR_NEGOCIO).map((c) => String(c.id));

    // O corte silencioso de 1.000 é exatamente o defeito: 1.000 das 1.200
    // linhas voltavam, e os ~17 últimos cards vinham sem selo nenhum.
    expect(
      semSelo,
      `cards sem o selo de ${TAREFAS_POR_NEGOCIO} tarefas (a leitura de crm_tasks cortou em 1.000): ${semSelo.join(", ")}`,
    ).toEqual([]);
    expect(comSelo).toHaveLength(NEGOCIOS);
    // O total que o quadro anuncia é o total que existe — nada sumiu no caminho.
    expect(cards.reduce((soma, c) => soma + (selo(c) ?? 0), 0)).toBe(
      NEGOCIOS * TAREFAS_POR_NEGOCIO,
    );
    // E o fim foi provado: não há recorte a anunciar.
    expect(corpo.data?.truncado).toBeUndefined();
  });

  it("⭐ (b) a leitura de crm_tasks pede `.range()` — a prova de fim saiu do lote", async () => {
    const leads = semearNegocios(3);
    const registro = bancoQueRegistra({ leads, tasks: semearTarefas(leads), maxRows: 1000 });

    const { status } = await lerQuadro();
    expect(status).toBe(200);

    const chamadas = registro.leiturasDeTarefas();
    const faixas = chamadas.filter((c) => c.metodo === "range").map((c) => c.args);
    expect(faixas[0]).toEqual([0, 999]);
    // A ordem da página é determinística — sem o desempate por `id`, a página
    // seguinte poderia repetir ou pular linha.
    expect(chamadas.filter((c) => c.metodo === "order").map((c) => c.args[0])).toContain("id");
    // A primeira página pede o `count` exato: é ele que prova onde o lote acaba.
    expect(chamadas.filter((c) => c.metodo === "select")[0]?.args[1]).toEqual({ count: "exact" });
  });

  it("⭐ (c) quadro pequeno continua sem aviso de recorte", async () => {
    const leads = semearNegocios(4);
    banco({ leads, tasks: semearTarefas(leads), maxRows: 1000 });

    const { status, corpo, headers } = await lerQuadro();
    expect(status).toBe(200);
    expect(corpo.data?.truncado).toBeUndefined();
    expect(headers.get("X-Quadro-Truncado")).toBeNull();
    expect((corpo.data?.leads ?? []).every((c) => selo(c) === TAREFAS_POR_NEGOCIO)).toBe(true);
  });
});
