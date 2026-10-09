/**
 * A PODA DA CAPTAÇÃO ORDENA O LOTE E NÃO ENGOLE A FALHA — issue #1721.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * A poda de `webhook_lead_captures` nasceu no molde antigo e ficou nele em dois
 * pontos, achados na triagem do #1719 (a poda de rascunhos, a décima do
 * `data-retention`, que a casa acabou de consertar):
 *
 *   1. `.limit(lote)` SEM `order`. O PostgREST 12.2 recusa isso com 400
 *      PGRST109 (medido no v12.2.12 pelo mantenedor; com `order=id` volta
 *      200) — de modo que, em vez de apagar, a poda recebia o erro e devolvia
 *      ZERO. E mesmo onde o banco aceitasse: sem ordem cada lote apaga um
 *      subconjunto ARBITRÁRIO, e duas rodadas com o mesmo backlog não apagam
 *      as mesmas linhas. A drenagem deixa de ser reproduzível.
 *   2. O erro do DELETE era ENGOLIDO: `logger.warn` e `{ apagadas: 0 }`. Na
 *      resposta do cron, "o banco recusou o DELETE" e "não havia nada vencido"
 *      são a MESMA linha. O único sinal vivia num log de contêiner atrás de um
 *      `curl -fsS` que joga tudo para /dev/null.
 *
 * ─── Por que estes casos são do RITUAL, não do detalhe ──────────────────────
 *
 * A régua aqui não é a forma da chamada — é que a poda não possa voltar a ser
 * morda. Por isso o dublê de banco recusa `limit` sem `order` ANTES de devolver
 * qualquer coisa, como o PostgREST 12.2 recusa (o mesmo truque que o mantenedor
 * usou no dublê da décima poda, no #1719): tirar o `.order()` do código faz
 * ESTE arquivo reprovar, e não um teste de presença que passaria por
 * vacuidade. E o canal da falha é medido no HANDLER do cron, que é quem
 * responde — a exceção tem de virar log de erro, linha de trilha com
 * `falhou: true` e Sentry, e o relatório do arquivo forense (que JÁ estava
 * feito) não pode ser engolido junto.
 *
 * O que estes casos NÃO medem: o que o Postgres aceita de fato, medido contra
 * um banco real em `tests/invariants/`. Aqui o dublê só carrega a régua.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { podarHistoricoDeCaptacao } from "@/lib/webhooks/retencao-da-captacao";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    WEBHOOK_LOG_BODY_RETENTION_DAYS: "",
    WEBHOOK_LOG_ROW_RETENTION_DAYS: "",
    LEAD_CAPTURE_RETENTION_DAYS: "",
  },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));
const capturou = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => capturou(...args),
}));

/** O que o DELETE da captação devolve nesta rodada. */
let respostaDelete: { data: { id: string }[]; error: { message: string } | null };
/** As linhas que a busca do arquivo forense enxerga (o outro par da rodada). */
let linhasDoArquivo: { id: string; received_at?: string }[] = [];
/** O que a poda mandou ao banco, na ordem em que mandou. */
let ordensPedidas: { coluna: string }[] = [];
/** O tamanho do lote que chegou no `limit`. */
let lotePedido = 0;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "webhook_lead_captures") {
        // O heart da cerca: `limit` sem `order` LANÇA, como o PostgREST 12.2
        // faz (400 PGRST109). O `ordenado` é lido pelo `limit` abaixo.
        let ordenado = false;
        const apagando: Record<string, unknown> = {
          delete: () => apagando,
          lt: () => apagando,
          select: () => apagando,
          order: (coluna: string) => {
            ordenado = true;
            ordensPedidas.push({ coluna });
            return apagando;
          },
          limit: (n: number) => {
            if (!ordenado) {
              throw new Error("PGRST109: A 'limit' was applied without an explicit 'order'");
            }
            lotePedido = n;
            return apagando;
          },
          then: (r: (v: unknown) => unknown) => Promise.resolve(respostaDelete).then(r),
        };
        return apagando;
      }
      // A busca e o DELETE da poda do ARQUIVO FORENSE: não é o que este
      // arquivo mede, e precisam devolver ALGUMA coisa para a rodada não
      // quebrar. O `delete` devolve lista vazia (o arquivo forense não é o
      // alvo do #1721); o que o handler faz com esse resultado é o que os
      // casos de falha medem — que o trabalho JÁ feito não se perde.
      const busca: Record<string, unknown> = {
        select: () => busca,
        is: () => busca,
        lt: () => busca,
        // `lte`: desde o #2324 o esvaziamento corta por DATA (o `received_at` da
        // última linha do lote), não por lista de ids na URL.
        lte: () => busca,
        order: () => busca,
        update: () => busca,
        in: () => busca,
        delete: () => buscaApagadas,
        limit: () => busca,
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: linhasDoArquivo, error: null }).then(r),
      };
      const buscaApagadas: Record<string, unknown> = {
        select: () => buscaApagadas,
        is: () => buscaApagadas,
        lt: () => buscaApagadas,
        order: () => buscaApagadas,
        limit: () => buscaApagadas,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return busca;
    },
  }),
}));

/**
 * Prepara a rodada: escolhe o que o DELETE devolve e zera o que se mede.
 * Devolve o MESMO cliente que o módulo recebe — o dublê mora no mock acima, e
 * duplicá-lo aqui seria ter dois bancos com a mesma memória.
 */
async function banco(sobrescreve?: Partial<typeof respostaDelete>) {
  respostaDelete = { data: [], error: null, ...sobrescreve };
  ordensPedidas = [];
  lotePedido = 0;
  linhasDoArquivo = [];
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient() as never;
}

describe("o DELETE da captação ordena o lote antes de limitá-lo", () => {
  it("manda `order` pela chave primária, e na ordem crescente", async () => {
    // A coluna e a direção são as da DÉCIMA poda (`app/api/v1/cron/
    // data-retention/route.ts`, `.order("id")`), pela mesma razão: `id` é a
    // chave primária, logo a ordem é estável, o recorte é repetível e o
    // planner não precisa trocar de caminho para casar com o índice de
    // `received_at`. Ordenar por `received_at` pareceria mais "natural" e
    // trocaria a ordem estável por uma que muda quando entra linha nova — e,
    // no PostgREST 12.2, trocaria também a resposta: sem `order` o DELETE
    // inteiro é recusado com 400 PGRST109.
    const admin = await banco({ data: [{ id: "c1" }] });
    await podarHistoricoDeCaptacao(admin, { diasBrutos: "365" });
    expect(ordensPedidas).toEqual([{ coluna: "id" }]);
  });

  it("ordena ANTES de limitar — o dublê recusa `limit` sem `order` (PGRST109)", async () => {
    // A direção que este teste NÃO mede é a do banco real: aqui o dublê LANÇA
    // no `limit` sem `order`, como o PostgREST 12.2 (400 PGRST109, medido pelo
    // mantenedor no v12.2.12). Tirar o `.order()` do código faz este caso
    // reprovar — e, sem o `.order()`, a poda não apagaria NADA em nenhum clone
    // novo, que é o defeito que a casa já corrigiu na décima poda.
    const admin = await banco({ data: [{ id: "c1" }] });
    const r = await podarHistoricoDeCaptacao(admin, { diasBrutos: "365", lote: 7 });
    // Chega aqui porque o `order` veio antes do `limit` — e o lote pedido é o
    // que o chamador mandou.
    expect(r.apagadas).toBe(1);
    expect(lotePedido).toBe(7);
  });

  it("a ordem deixa a drenagem REPRODUZÍVEL: dois lotes do mesmo recorte, mesma ordem", async () => {
    // O motivo de a ordem existir, separado do PGRST109. Sem `order`, o banco
    // devolve um subconjunto qualquer dentro de `lt(received_at, limite)`, e
    // duas rodadas com o mesmo backlog apagam linhas DIFERENTES: a sequência
    // de lotes não é reproduzível, e ninguém consegue dizer, depois, o que a
    // poda pegou. Este caso mede a propriedade com o recorte do chamador
    // fixado: o que a poda pede ao banco é sempre "as N primeiras linhas por
    // `id`", nunca "N linhas quaisquer".
    const admin = await banco({ data: [{ id: "c1" }] });
    await podarHistoricoDeCaptacao(admin, { diasBrutos: "365", lote: 500 });
    const primeira = JSON.stringify(ordensPedidas);
    ordensPedidas = [];
    await podarHistoricoDeCaptacao(admin, { diasBrutos: "365", lote: 500 });
    expect(JSON.stringify(ordensPedidas)).toBe(primeira);
  });
});

describe("a falha do DELETE sobe — ela não vira `apagadas: 0`", () => {
  it("propaga a mensagem do banco, com o nome da tabela na frente", async () => {
    // O `warn` que vivia aqui devolvia zero e seguia: na resposta do cron, "o
    // banco recusou" e "não havia nada vencido" eram a mesma linha. A mensagem
    // precisa chegar ao operador com o NOME da tabela — `webhook_lead_captures`
    // — e não com o texto cru do Postgres, que sozinho não diz qual das duas
    // tabelas da rodada falhou.
    const admin = await banco({
      error: { message: "permission denied for table webhook_lead_captures" },
    });
    await expect(podarHistoricoDeCaptacao(admin, { diasBrutos: "365" })).rejects.toThrow(
      /webhook_lead_captures: permission denied/,
    );
  });

  it("NÃO devolve um resultado de sucesso — o chamador não pode ler `apagadas: 0`", async () => {
    // A direção que segura a porta de vacuidade: um `catch` que devolvesse
    // `{ apagadas: 0 }` satisfaria qualquer asserção de "não lança" e manteria
    // o defeito inteiro. Aqui a promessa é REJEITA.
    const admin = await banco({ error: { message: "connection reset by peer" } });
    await expect(podarHistoricoDeCaptacao(admin, { diasBrutos: "365" })).rejects.toBeInstanceOf(
      Error,
    );
  });
});

describe("o handler do cron — a falha da captação sai pelo mesmo canal das irmãs", () => {
  beforeEach(() => {
    auditou.mockClear();
    capturou.mockClear();
  });

  /** O handler com o cron autorizado, montando a `url` que ele também lê. */
  async function chamarCron(): Promise<Response> {
    const { GET } = await import("@/app/api/v1/cron/webhook-log-retention/route");
    // A `url` é LIDA pelo handler (o ajuste de `?lote=`), então um objeto de
    // cabeçalhos só não basta — é o mesmo formato que o `cron-auth` mede
    // (`tests/unit/cron-auth.test.ts`).
    return GET({
      url: "http://localhost/api/v1/cron/webhook-log-retention",
      headers: new Headers({ authorization: "Bearer segredo" }),
    } as never);
  }

  it("rodada em dia responde 200 e a captação apagou o que veio", async () => {
    await banco({ data: [{ id: "c1" }, { id: "c2" }] });
    const resposta = await chamarCron();
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { captacao: { apagadas: number } } };
    expect(corpo.data.captacao.apagadas).toBe(2);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("banco recusa o DELETE: a linha `falhou` ENTRA na trilha", async () => {
    // O laço de retorno, o mesmo das irmãs: sem esta linha, uma captação que
    // parou de funcionar num clone é indistinguível, na trilha, de um dia sem
    // nada vencido. E a linha tem de dizer QUAL poda falhou — `metadata.poda` é
    // o que separa esta falha da falha do arquivo forense na mesma rodada.
    await banco({ error: { message: "permission denied for table webhook_lead_captures" } });
    await chamarCron();
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, poda: "webhook_lead_captures" },
    });
  });

  it("banco recusa o DELETE: a rodada responde 500, como as irmãs", async () => {
    // O `curl -fsS` do scheduler (`docker/scheduler/entrypoint.sh`) é quem
    // dispara este tique; um 200 de "tudo certo" depois de uma falha seria o
    // defeito que a issue descreve, só que com mais um degrau. O 500 é o mesmo
    // que o `data-retention` e o `media-retention` devolvem quando uma das
    // suas podas falha.
    await banco({ error: { message: "connection reset by peer" } });
    linhasDoArquivo = [{ id: "e1", received_at: "2026-01-01T00:00:00.000000+00:00" }];
    const resposta = await chamarCron();
    expect(resposta.status).toBe(500);
    const corpo = (await resposta.json()) as {
      error: { code: string; details: { arquivo_forense: { esvaziadas: number } } };
    };
    expect(corpo.error.code).toBe("internal_error");
    // E o que o arquivo forense JÁ tinha feito fica no erro — a rodada falhou,
    // e mesmo assim isto é verdade, e descartar seria perder trabalho feito.
    expect(corpo.error.details.arquivo_forense.esvaziadas).toBe(1);
  });

  it("banco recusa o DELETE: o Sentry é chamado", async () => {
    // Terceiro canal, e o único que sobrevive a um contêiner cujo stdout
    // ninguém lê. A chamada é por import DINÂMICO — por isso o `await` de um
    // tique de event loop depois do handler: a promise do `import` é resolvida
    // DEPOIS de a resposta ser devolvida (é o que a deixa `void`, como em
    // `reportAuditFailure`), e um teste que afirmasse no mesmo tique mediria a
    // ordem das microtasks, não o canal. Com `SENTRY_DSN=off` numa instalação
    // real, o `.catch` do fim engole a import que falha — e a falha do banco
    // continua dita pelo log e pela linha de trilha, que são os canais que
    // existem sempre.
    await banco({ error: { message: "connection reset by peer" } });
    await chamarCron();
    await new Promise((r) => setTimeout(r, 0));
    expect(capturou).toHaveBeenCalledTimes(1);
    expect((capturou.mock.calls[0]?.[0] as Error).message).toMatch(/webhook_lead_captures/);
  });
});
