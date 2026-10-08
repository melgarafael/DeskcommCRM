/**
 * A PODA DO ARQUIVO DE WEBHOOKS ORDENA O LOTE E NÃO ENGOLE A FALHA — issue #1769.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * O MESMO cron (`app/api/v1/cron/webhook-log-retention`) tem duas podas, e a
 * segunda ficou no molde antigo que a casa já desmontou duas vezes: a décima
 * poda do `data-retention` (#1719) e a poda irmã de `webhook_lead_captures`
 * (#1721,mergeada em #1768). Esta era a última, e a mais cara de errar:
 *
 *   1. `.limit(lote)` SEM `order` no DELETE. O PostgREST 12.2 recusa isso com
 *      400 PGRST109 (medido no v12.2.12 pelo mantenedor; com `order=id` volta
 *      200) — de modo que, em vez de apagar, a poda recebia o erro e devolvia
 *      ZERO. E aqui ozero é o banco INTEIRO: `webhook_events_log` foi medido em
 *      468 MB de 545 MB, crescendo ~23 MB/dia sem teto contra os 500 MB do
 *      plano gratuito do Supabase, onde a maioria dos clones vive. Onde o
 *      banco aceitasse: sem ordem cada lote apaga um subconjunto ARBITRÁRIO, e
 *      duas rodadas com o mesmo backlog não apagam as mesmas linhas.
 *   2. O erro do DELETE era ENGOLIDO: `logger.warn` e `{ apagadas: 0 }`. Na
 *      resposta do cron, "o banco recusou o DELETE" e "não havia nada vencido"
 *      eram a MESMA linha, e o único sinal vivia num log de contêiner atrás de
 *      um `curl -fsS` que joga tudo para /dev/null.
 *
 * ─── Por que estes casos são do RITUAL, não do detalhe ──────────────────────
 *
 * A régua aqui não é a forma da chamada — é que a poda não possa voltar a ser
 * morda. Por isso o dublê de banco recusa `limit` sem `order` ANTES de devolver
 * qualquer coisa, como o PostgREST 12.2 recusa (o mesmo truque do #1719 e do
 * #1721): tirar o `.order()` do código faz ESTE arquivo reprovar, e não um
 * teste de presença que passaria por vacuidade.
 *
 * E o canal da falha é medido no HANDLER do cron, que é quem responde. Há
 * aqui uma assimetria que é doutrina, e não conveniência: a falha do arquivo
 * forense NÃO leva a captação junto (perder um lote é trabalho de uma rodada,
 * e a próxima roda em 5 min repete), mas a falha é DITA — `logger.error`, a
 * linha `retention.sweep_run` com `falhou: true`, Sentry e 500. O caminho
 * INVERSO também é medido, porque sem o `.order()` a captação deixava de rodar
 * naquela rodada inteira, o que seria trocar uma tabela quebrada por duas.
 *
 * O que estes casos NÃO medem: o que o Postgres aceita de fato, medido contra
 * um banco real em `tests/invariants/`. Aqui o dublê só carrega a régua.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErroAoApagarLinhasVelhas, podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    WEBHOOK_LOG_BODY_RETENTION_DAYS: 7,
    WEBHOOK_LOG_ROW_RETENTION_DAYS: 90,
    LEAD_CAPTURE_RETENTION_DAYS: "",
  },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));
const capturou = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => capturou(...args),
}));

/** O que o DELETE do arquivo forense devolve nesta rodada. */
let respostaDeleteArquivo: { data: { id: string }[]; error: { message: string } | null };
/** O que a busca do arquivo forense enxerga (passo 1, o esvaziamento). */
let linhasDoArquivo: { id: string; received_at: string }[] = [];
/** O que o DELETE da captação devolve — a poda IRMÃ, que roda no mesmo tique. */
let respostaDeleteCaptacao: { data: { id: string }[]; error: { message: string } | null };
/** A ordem que cada poda mandou ao banco, e com que lote. `apagando` diz de que cadeia veio. */
let ordensPedidas: { tabela: string; coluna: string; lote: number; apagando: boolean }[] = [];

/**
 * O dublê de banco das DUAS tabelas, e o coração do arquivo: `limit` sem
 * `order` LANÇA, como o PostgREST 12.2 faz (400 PGRST109). Uma exceção vinda
 * de dentro do `limit` é o que separa "o banco recusou" de "a poda rodou": com
 * ela, o `catch` da função nem é alcançado, e é por isso que tirar o
 * `.order()` reprova os casos de SUCESSO também, e não só os de falha.
 *
 * A superfície é de UM `from` só, e as duas tabelas se distinguem pelo NOME
 * (que é o que a função pede) e pela RESPOSTA que a Promise entrega. Isso é
 * proposital: um dublê com um objeto por tabela teria que adivinhar, para cada
 * chamada, se o chamador está no meio da busca ou no fim do DELETE — e adivinhar
 * errado faz o defeito aparecer como erro de dublê, que é o modo mais caro de
 * não guardar nada. Aqui a distinção é o dado, não o objeto.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const arquivo = tabela === "webhook_events_log";
      // O que a CADEIA de chamadas devolve. A do DELETE é a resposta de um
      // `then` — a própria cadeia é um `thenable` — e a da busca idem; a
      // diferença é que a cadeia que passou por `delete` devolve a resposta de
      // apagar, e a que não passou devolve as linhas do arquivo.
      const respostaDelete = () => (arquivo ? respostaDeleteArquivo : respostaDeleteCaptacao);
      const respostaBusca = () => ({ data: linhasDoArquivo, error: null });

      // A superfície do DELETE: `.delete().lt().select().order().limit()`.
      let ordenado = false;
      // A ordem e o lote que ESTA chamada recebeu, já pareados — o `limit`
      // chega depois do `order`, então o par só se fecha aqui.
      const registro: { coluna: string; lote: number } = { coluna: "", lote: 0 };
      // A CADEIA, e o que ela sabe sobre si mesma: se um `delete` já passou por
      // ela, o `then` no fim devolve a resposta de apagar. A FLAG é local (por
      // closure) e não uma propriedade do objeto, para que o dublê não finja
      // ter um campo `apagando` que o `supabase-js` não tem.
      let apagando = false;
      const cadeia: Record<string, unknown> = {
        delete: () => {
          apagando = true;
          return cadeia;
        },
        lt: () => cadeia,
        lte: () => cadeia,
        is: () => cadeia,
        in: () => cadeia,
        update: () => cadeia,
        select: () => cadeia,
        order: (coluna: string) => {
          ordenado = true;
          // A coluna e a direção: `id` ascendente, a mesma da poda irmã e da
          // décima poda. `received_at` pareceria mais "natural" e trocaria a
          // ordem estável por uma que muda quando entra linha nova.
          registro.coluna = coluna;
          // O `apagando` viaja JUNTO porque esta cadeia faz as duas coisas: a
          // busca do passo 1 também tem `order` (por `received_at`, e isso é
          // dela, não é o defeito), e é o `order` da cadeia APAGADA que a issue
          // mede. Sem marcar, o caso veria as duas e não saberia qual é qual.
          ordensPedidas.push({ tabela, ...registro, apagando });
          return cadeia;
        },
        limit: (n: number) => {
          if (!ordenado) {
            throw new Error("PGRST109: A 'limit' was applied without an explicit 'order'");
          }
          // O registro desta chamada é o ÚLTIMO `order` desta tabela, e o
          // `limit` só chega depois dele — daí percorrer de trás para frente.
          for (let i = ordensPedidas.length - 1; i >= 0; i -= 1) {
            const o = ordensPedidas[i];
            if (o && o.tabela === tabela) {
              o.lote = n;
              break;
            }
          }
          return cadeia;
        },
        then: (r: (v: unknown) => unknown) => {
          const resposta = apagando ? respostaDelete() : respostaBusca();
          return Promise.resolve(resposta).then(r);
        },
      };
      return cadeia;
    },
  }),
}));

/**
 * Prepara a rodada: escolhe o que cada DELETE devolve e zera o que se mede.
 * Devolve o MESMO cliente que o módulo recebe — o dublê mora no mock acima, e
 * duplicá-lo aqui seria ter dois bancos com a mesma memória.
 */
async function banco(sobrescreve?: {
  arquivo?: Partial<typeof respostaDeleteArquivo>;
  captacao?: Partial<typeof respostaDeleteCaptacao>;
}) {
  respostaDeleteArquivo = { data: [], error: null, ...sobrescreve?.arquivo };
  respostaDeleteCaptacao = { data: [], error: null, ...sobrescreve?.captacao };
  linhasDoArquivo = [];
  ordensPedidas = [];
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return createAdminClient() as never;
}

describe("o DELETE do arquivo de webhooks ordena o lote antes de limitá-lo", () => {
  it("manda `order` pela chave primária, e na ordem crescente", async () => {
    // A coluna e a direção são as da PODA IRMÃ (`webhook_lead_captures`, #1721)
    // e as da décima poda do `data-retention`, pela mesma razão: `id` é a chave
    // primária, logo a ordem é estável, o recorte é repetível e o planner não
    // precisa trocar de caminho para casar com o índice de `received_at`.
    //
    // O filtro `apagando` não é um detalhe: a busca do passo 1 também ordena,
    // por `received_at`, e essa ordem é CORRETA e não é o defeito. A issue é
    // sobre o `order` que falta no DELETE, e este caso mede só ele.
    const admin = await banco({ arquivo: { data: [{ id: "e1" }] } });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 });
    expect(ordensPedidas.filter((o) => o.apagando)).toEqual([
      { tabela: "webhook_events_log", coluna: "id", lote: 500, apagando: true },
    ]);
  });

  it("ordena ANTES de limitar — o dublê recusa `limit` sem `order` (PGRST109)", async () => {
    // A direção que este teste NÃO mede é a do banco real: aqui o dublê LANÇA
    // no `limit` sem `order`, como o PostgREST 12.2. Tirar o `.order()` do
    // código faz este caso reprovar — e, sem o `.order()`, a poda que segura o
    // ESPAÇO não apagaria NADA em nenhum clone novo, que é o defeito inteiro.
    const admin = await banco({ arquivo: { data: [{ id: "e1" }, { id: "e2" }] } });
    const r = await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 7 });
    expect(r.apagadas).toBe(2);
    const doArquivo = ordensPedidas.find((o) => o.apagando);
    expect(doArquivo?.lote).toBe(7);
  });

  it("a ordem deixa a drenagem REPRODUZÍVEL: dois lotes do mesmo recorte, mesma ordem", async () => {
    // O motivo de a ordem existir, separado do PGRST109. Sem `order`, o banco
    // devolve um subconjunto qualquer dentro de `lt(received_at, limite)`, e
    // duas rodadas com o mesmo backlog apagam linhas DIFERENTES: a sequência
    // de lotes não é reproduzível, e ninguém consegue dizer, depois, o que a
    // poda pegou. O que a poda pede é sempre "as N primeiras linhas por `id`".
    const admin = await banco({ arquivo: { data: [{ id: "e1" }] } });
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 500 });
    const primeira = ordensPedidas.filter((o) => o.apagando);
    // A comparação das duas rodadas, sozinha, passaria por VACUIDADE sem
    // `.order()`: dos dois lados a lista seria `[]` e `[]` são iguais. É esta
    // linha que impede o caso de bancar o verde com o defeito de pé — a ordem
    // precisa EXISTIR para poder ser estável.
    expect(primeira.length).toBeGreaterThan(0);
    ordensPedidas = [];
    await podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90, lote: 500 });
    expect(ordensPedidas.filter((o) => o.apagando)).toEqual(primeira);
  });
});

describe("a falha do DELETE sobe — ela não vira `apagadas: 0`", () => {
  it("propaga a mensagem do banco, com o nome da tabela na frente", async () => {
    // O `warn` que vivia aqui devolvia zero e seguia: na resposta do cron, "o
    // banco recusou" e "não havia nada vencido" eram a mesma linha. A mensagem
    // precisa chegar ao operador com o NOME da tabela — `webhook_events_log` —
    // e não com o texto cru do Postgres, que sozinho não diz qual das duas
    // tabelas da rodada falhou.
    const admin = await banco({
      arquivo: { error: { message: "permission denied for table webhook_events_log" } },
    });
    await expect(
      podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }),
    ).rejects.toThrow(/webhook_events_log: permission denied/);
  });

  it("NÃO devolve um resultado de sucesso — o chamador não pode ler `apagadas: 0`", async () => {
    // A direção que segura a porta de vacuidade: um `catch` que devolvesse
    // `{ apagadas: 0 }` satisfaria qualquer asserção de "não lança" e manteria
    // o defeito inteiro. Aqui a promessa é REJEITA.
    const admin = await banco({ arquivo: { error: { message: "connection reset by peer" } } });
    await expect(
      podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("carrega o que o passo 1 JÁ esvaziou — a rodada não perde o trabalho feito", async () => {
    // A parte que o molde da irmã não tinha, porque a irmã tem só um passo.
    // Aqui são DOIS: esvaziar o corpo e depois apagar a linha. O DELETE
    // recusado acontece DEPOIS do esvaziamento, então uma rodada que esvaziou
    // 500 linhas e falhou ao apagar não é a mesma que uma que não fez nada.
    // Perder o `esvaziadas: 500` faria a rodada falhar parecendo ociosidade —
    // que é o que aissue descreve, um degrau abaixo.
    const admin = await banco({
      arquivo: { error: { message: "permission denied" } },
    });
    linhasDoArquivo = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      received_at: `2026-01-0${i + 1}T10:00:00.000Z`,
    }));
    const erro = await podarArquivoDeWebhooks(admin, {
      diasComCorpo: 7,
      diasParaApagar: 90,
      lote: 3,
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ErroAoApagarLinhasVelhas);
    const parcial = (erro as InstanceType<typeof ErroAoApagarLinhasVelhas>).parcial;
    expect(parcial.esvaziadas).toBe(3);
    expect(parcial.apagadas).toBe(0);
  });

  it("a falha da BUSCA continua devolvendo zero — só o DELETE é irreversível", async () => {
    // A direção que segura a porta do OUTRO lado, e ela é doutrina, não
    // esquecimento: a busca é idempotente e o mesmo lote volta a ser escolhido
    // na rodada seguinte de 5 em 5 minutos, enquanto o DELETE é a linha que
    // some para sempre. Transformar o `catch` da busca em `throw` derrubaria o
    // 200 por um lote que se refaz sozinho — e o conserto da issue é sobre o
    // DELETE, não sobre a busca. Este caso existe para travar a linha do meio:
    // um refactor "já que a falha sobe, então tudo sobe" voltaria a derrubar
    // a rodada por um motivo que não se repete.
    const admin = {
      from: () => ({
        select: () => ({
          is: () => ({
            lt: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: { message: "timeout" } }),
              }),
            }),
          }),
        }),
      }),
    } as never;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      podarArquivoDeWebhooks(admin, { diasComCorpo: 7, diasParaApagar: 90 }),
    ).resolves.toMatchObject({ esvaziadas: 0, apagadas: 0, temMais: false });
    aviso.mockRestore();
  });
});

describe("o handler do cron — a falha do arquivo sai pelo mesmo canal das irmãs", () => {
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

  it("rodada em dia responde 200 e a poda do arquivo apagou o que veio", async () => {
    await banco({ arquivo: { data: [{ id: "e1" }, { id: "e2" }] } });
    const resposta = await chamarCron();
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      data: { apagadas: number; captacao: { apagadas: number } };
    };
    expect(corpo.data.apagadas).toBe(2);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("banco recusa o DELETE do arquivo: a linha `falhou` ENTRA na trilha", async () => {
    // O laço de retorno, o mesmo das irmãs: sem esta linha, uma poda que
    // parou de funcionar num clone é indistinguível, na trilha, de um dia sem
    // nada vencido. E a linha tem de dizer QUAL poda falhou — `metadata.poda` é
    // o que separa esta falha da falha da captação na mesma rodada.
    await banco({ arquivo: { error: { message: "permission denied for table webhook_events_log" } } });
    await chamarCron();
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.sweep_run",
      metadata: { falhou: true, poda: "webhook_events_log" },
    });
  });

  it("banco recusa o DELETE do arquivo: a rodada responde 500", async () => {
    // O `curl -fsS` do scheduler (`docker/scheduler/entrypoint.sh`) é quem
    // dispara este tique; um 200 de "tudo certo" depois de uma falha seria o
    // defeito que a issue descreve, só que com mais um degrau.
    await banco({ arquivo: { error: { message: "connection reset by peer" } } });
    const resposta = await chamarCron();
    expect(resposta.status).toBe(500);
    const corpo = (await resposta.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("internal_error");
  });

  it("banco recusa o DELETE do arquivo: o Sentry é chamado", async () => {
    // Terceiro canal, e o único que sobrevive a um contêiner cujo stdout
    // ninguém lê. A chamada é por import DINÂMICO — por isso o `await` de um
    // tique de event loop depois do handler: a promise do `import` é resolvida
    // DEPOIS de a resposta ser devolvida (é o que a deixa `void`, como em
    // `reportAuditFailure`), e um teste que afirmasse no mesmo tique mediria a
    // ordem das microtasks, não o canal.
    await banco({ arquivo: { error: { message: "connection reset by peer" } } });
    await chamarCron();
    await new Promise((r) => setTimeout(r, 0));
    expect(capturou).toHaveBeenCalledTimes(1);
    expect((capturou.mock.calls[0]?.[0] as Error).message).toMatch(/webhook_events_log/);
  });

  it("o que o passo 1 esvaziou ANTES da falha vem no corpo do 500", async () => {
    // A parte que só existe porque a poda tem DOIS passos. O relatório do
    // trabalho feito não pode ser engolido pela exceção que veio depois dele:
    // sem isto, uma rodada que esvaziou 3 linhas e falhou ao apagar reportaria
    // `esvaziadas: 0` ao operador, que é a mentira que a issue descreve com
    // outro nome.
    await banco({ arquivo: { error: { message: "permission denied" } } });
    linhasDoArquivo = [
      { id: "e1", received_at: "2026-01-01T10:00:00.000Z" },
      { id: "e2", received_at: "2026-01-02T10:00:00.000Z" },
    ];
    const resposta = await chamarCron();
    expect(resposta.status).toBe(500);
    const corpo = (await resposta.json()) as {
      error: { details: { arquivo_forense: { esvaziadas: number; apagadas: number } } };
    };
    expect(corpo.error.details.arquivo_forense).toMatchObject({ esvaziadas: 2, apagadas: 0 });
  });

  it("a falha do arquivo NÃO leva a captação junto — ela roda no mesmo tique", async () => {
    // A assimetria, que é doutrina e não conveniência. Perder um lote de
    // esvaziamento é trabalho de UMA rodada, e a próxima roda em 5 minutos
    // repete o mesmo lote; a captação é um horizonte longo e não pode ser
    // aguada por causa de uma tabela vizinha. O inverso — a falha da captação
    // derrubando o relatório do arquivo — já é medido no arquivo da irmã.
    await banco({
      arquivo: { error: { message: "permission denied for table webhook_events_log" } },
      captacao: { data: [{ id: "c1" }, { id: "c2" }] },
    });
    const resposta = await chamarCron();
    expect(resposta.status).toBe(500);
    const corpo = (await resposta.json()) as {
      error: {
        details: {
          arquivo_forense: { esvaziadas: number };
          captacao: { apagadas: number };
        };
      };
    };
    expect(corpo.error.details.captacao.apagadas).toBe(2);
  });

  it("as DUAS falhas na mesma rodada: DUAS linhas na trilha, cada uma dizendo qual poda", async () => {
    // A linha que a duplicação do reporte teria quebrado. Sem `poda` no
    // metadata (ou com a mesma `poda` nas duas), o operador veria duas linhas
    // `falhou` idênticas na mesma rodada e não saberia se uma tabela ou duas
    // pararam — que é a pergunta que o `?lote=` do primeiro dia torna urgente.
    await banco({
      arquivo: { error: { message: "permission denied for table webhook_events_log" } },
      captacao: { error: { message: "permission denied for table webhook_lead_captures" } },
    });
    const resposta = await chamarCron();
    expect(resposta.status).toBe(500);
    expect(auditou).toHaveBeenCalledTimes(2);
    const podas = auditou.mock.calls.map((c) => (c[0] as { metadata: { poda: string } }).metadata.poda);
    expect(podas.sort()).toEqual(["webhook_events_log", "webhook_lead_captures"]);
  });
});
