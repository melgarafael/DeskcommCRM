import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A PASSAGEM QUE NINGUÉM ASSUMIU VOLTA A PEDIR — o segundo braço do vigia.
 *
 * ═══ O defeito, e por que ele não é do vigia de casos ═══
 *
 * O reconhecimento da passagem (migration 0293) só acontece por GESTO de quem
 * chegou: alguém assume a conversa, ou a devolve ao automático. Ninguém cobra a
 * passagem em que ninguém chegou — e dos TREZE caminhos que passam conversa para
 * uma pessoa, exatamente UM nasce de caso. O `case-stale-watcher` varre
 * `agent_cases`; ele não alcançava os outros doze nem por acidente.
 *
 * ⚠️ A população não é hipótese. Medida num CRM em produção com o mesmo desenho
 * de fila (2026-09-14, e o número está escrito no cabeçalho da própria rota):
 * **22 pedidos parados, o mais antigo há 17,6 dias, e ONZE deles eram gente
 * pedindo para falar com uma pessoa.**
 *
 * ═══ O que este arquivo prova, e o que ele deixa para o invariante ═══
 *
 * Prova a decisão do braço: quem entra na varredura, quem NÃO entra, o que
 * acontece com o aviso da Central, e que o contador para no terceiro. A RLS e o
 * gatilho de reconhecimento são de `pnpm test:db`; aqui não há banco.
 */

const SEGREDO = "segredo-de-cron-do-teste";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO, INTERNAL_SECRET: "" },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Linha = Record<string, unknown>;

interface Banco {
  agent_cases: Linha[];
  agent_inbox_items: Linha[];
  passagens_de_atendimento: Linha[];
}

interface Registro {
  inserts: Array<{ tabela: string; linha: Linha }>;
  updates: Array<{ tabela: string; patch: Linha; filtros: Array<[string, unknown]> }>;
  consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }>;
}

const banco: Banco = { agent_cases: [], agent_inbox_items: [], passagens_de_atendimento: [] };
const registro: Registro = { inserts: [], updates: [], consultas: [] };

/**
 * Dublê que APLICA os filtros. Um dublê que os ignorasse deixaria passar a
 * varredura que cobra passagem já reconhecida — e a asserção "não cobra quem já
 * foi assumido" ficaria verde sem medir nada.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // O braço dos CASOS pergunta ao banco quem venceu (`fn_casos_parados_para_lembrar`,
    // migration 0766); a conta da cadência é medida no invariante dela. Aqui o
    // dublê devolve os casos em `awaiting_human` como se todos tivessem vencido.
    rpc: (nome: string) =>
      Promise.resolve(
        nome === "fn_casos_parados_para_lembrar"
          ? { data: banco.agent_cases.filter((c) => c.status === "awaiting_human"), error: null }
          : { data: null, error: { message: `rpc inesperada: ${nome}` } },
      ),
    from: (tabela: keyof Banco) => {
      let linhas = [...(banco[tabela] ?? [])];
      let limite = Infinity;
      const filtros: Array<[string, unknown]> = [];
      let modo: "select" | "insert" | "update" = "select";
      let patch: Linha = {};

      const cadeia: Record<string, unknown> = {
        select: () => {
          registro.consultas.push({ tabela, filtros });
          return cadeia;
        },
        insert: (linha: Linha) => {
          modo = "insert";
          registro.inserts.push({ tabela, linha });
          banco[tabela].push({ id: `novo-${banco[tabela].length}`, status: "open", ...linha });
          return cadeia;
        },
        update: (p: Linha) => {
          modo = "update";
          patch = p;
          return cadeia;
        },
        eq: (col: string, val: unknown) => {
          filtros.push([col, val]);
          linhas = linhas.filter((l) => l[col] === val);
          return cadeia;
        },
        is: (col: string, val: unknown) => {
          filtros.push([`is:${col}`, val]);
          linhas = linhas.filter((l) => (l[col] ?? null) === val);
          return cadeia;
        },
        lt: (col: string, val: unknown) => {
          filtros.push([`lt:${col}`, val]);
          linhas = linhas.filter((l) => (l[col] as number | string) < (val as number | string));
          return cadeia;
        },
        order: (col: string, o: { ascending: boolean }) => {
          linhas = [...linhas].sort(
            (x, y) => String(x[col]).localeCompare(String(y[col])) * (o.ascending ? 1 : -1),
          );
          return cadeia;
        },
        limit: (n: number) => {
          limite = n;
          return cadeia;
        },
        maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          if (modo === "update") {
            registro.updates.push({ tabela, patch, filtros });
            for (const l of linhas) Object.assign(l, patch);
          }
          return Promise.resolve({ data: linhas.slice(0, limite), error: null }).then(res);
        },
      };
      return cadeia;
    },
  }),
}));

const ORG = "org-1";
const CONVERSA = "conv-1";
const ONTEM = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const AGORA = new Date().toISOString();

function passagem(over: Linha = {}): Linha {
  return {
    id: "p1",
    organization_id: ORG,
    conversation_id: CONVERSA,
    criado_em: ONTEM,
    reconhecido_em: null,
    cobrancas: 0,
    ...over,
  };
}

async function rodar() {
  const { GET } = await import("@/app/api/v1/cron/case-stale-watcher/route");
  const res = await GET({ headers: new Headers({ authorization: `Bearer ${SEGREDO}` }) } as never);
  return { status: res.status, body: (await res.json()) as { data?: Record<string, number> } };
}

beforeEach(() => {
  auditou.mockClear();
  banco.agent_cases = [];
  banco.agent_inbox_items = [];
  banco.passagens_de_atendimento = [];
  registro.inserts = [];
  registro.updates = [];
  registro.consultas = [];
});

describe("o vigia cobra a passagem que ninguém assumiu", () => {
  it("passagem parada há mais de um dia vira aviso na Central, apontando para a CONVERSA", async () => {
    // `ref_kind='conversation'` e não `contact`: o botão "Abrir conversa" da
    // Central sai daí, e é na conversa que o cartão com o contexto mora. Um
    // aviso que leva à ficha do contato faria a pessoa procurar o atendimento.
    banco.passagens_de_atendimento = [passagem()];

    const { status, body } = await rodar();

    expect(status).toBe(200);
    expect(body.data?.passagens_cobradas).toBe(1);
    const inserido = registro.inserts.find((i) => i.tabela === "agent_inbox_items");
    expect(inserido?.linha).toMatchObject({
      organization_id: ORG,
      kind: "handoff",
      ref_kind: "conversation",
      ref_id: CONVERSA,
    });
  });

  it("passagem JÁ reconhecida não é cobrada — alguém assumiu", async () => {
    banco.passagens_de_atendimento = [passagem({ reconhecido_em: AGORA })];

    const { body } = await rodar();

    expect(body.data?.passagens_cobradas).toBe(0);
    expect(registro.inserts.filter((i) => i.tabela === "agent_inbox_items")).toEqual([]);
  });

  it("passagem RECENTE não é cobrada — o silêncio de uma hora não é abandono", async () => {
    banco.passagens_de_atendimento = [passagem({ criado_em: AGORA })];

    const { body } = await rodar();

    expect(body.data?.passagens_cobradas).toBe(0);
  });

  it("no terceiro aviso ele para — alarme que nunca cala ensina a ignorar o alarme certo", async () => {
    banco.passagens_de_atendimento = [passagem({ cobrancas: 3 })];

    const { body } = await rodar();

    expect(body.data?.passagens_cobradas).toBe(0);
  });

  it("cada cobrança sobe o contador DAQUELA passagem", async () => {
    banco.passagens_de_atendimento = [passagem({ cobrancas: 1 })];

    await rodar();

    const contador = registro.updates.find(
      (u) => u.tabela === "passagens_de_atendimento" && "cobrancas" in u.patch,
    );
    expect(contador?.patch.cobrancas).toBe(2);
    // O filtro por organização é o que impede o contador de subir na linha de
    // outra instalação num banco compartilhado.
    expect(contador?.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("aviso JÁ ABERTO daquela conversa é REUSADO, não duplicado", async () => {
    // Dois avisos sobre o mesmo atendimento na Central fazem a pessoa resolver
    // um e continuar vendo o outro — e é o que o dedup do produtor já evita.
    banco.agent_inbox_items = [
      {
        id: "i1",
        organization_id: ORG,
        kind: "handoff",
        ref_kind: "conversation",
        ref_id: CONVERSA,
        status: "open",
        created_at: ONTEM,
      },
    ];
    banco.passagens_de_atendimento = [passagem()];

    const { body } = await rodar();

    expect(body.data?.passagens_cobradas).toBe(1);
    expect(registro.inserts.filter((i) => i.tabela === "agent_inbox_items")).toEqual([]);
    expect(
      registro.updates.some((u) => u.tabela === "agent_inbox_items"),
      "o aviso aberto não foi atualizado — a cobrança não diria nada de novo",
    ).toBe(true);
  });

  it("aviso RESOLVIDO sem ninguém ter assumido é REABERTO", async () => {
    // Marcar o aviso como resolvido não é assumir a conversa. Enquanto
    // `reconhecido_em` for nulo, há alguém esperando do outro lado — e o aviso
    // resolvido é a única coisa que some da tela sem o problema sumir junto.
    banco.agent_inbox_items = [
      {
        id: "i1",
        organization_id: ORG,
        kind: "handoff",
        ref_kind: "conversation",
        ref_id: CONVERSA,
        status: "resolved",
        resolved_at: AGORA,
        created_at: ONTEM,
      },
    ];
    banco.passagens_de_atendimento = [passagem()];

    await rodar();

    const reabertura = registro.updates.find((u) => u.tabela === "agent_inbox_items");
    expect(reabertura?.patch).toMatchObject({ status: "open", resolved_at: null });
  });

  it("a rodada que não cobrou ninguém NÃO audita", async () => {
    // Rodada vazia não é mutação. O vigia roda de hora em hora: auditar sempre
    // grava milhares de linhas/mês numa instalação parada, numa tabela
    // append-only sem UPDATE nem DELETE para papel nenhum.
    banco.passagens_de_atendimento = [passagem({ reconhecido_em: AGORA })];

    await rodar();

    expect(auditou).not.toHaveBeenCalled();
  });

  it("a rodada que cobrou AUDITA, com código próprio e a contagem", async () => {
    // A outra direção, que não pode se perder: "parar de auditar" trocaria
    // ruído por cegueira. Código próprio porque a pergunta é outra — caso parado
    // é a IA esperando decisão; passagem parada é um cliente esperando resposta.
    banco.passagens_de_atendimento = [passagem()];

    await rodar();

    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "ai.passagem_parada_cobrada",
      metadata: { cobradas: 1 },
    });
  });

  it("o braço dos CASOS continua de pé — o segundo não substituiu o primeiro", async () => {
    // Guarda de regressão: os dois braços vivem na mesma rota e a varredura de
    // casos é o motivo de ela existir. Quebrá-la ao acrescentar a de passagens
    // seria trocar um buraco por outro.
    banco.agent_cases = [
      {
        id: "c1",
        organization_id: ORG,
        title: "Cliente quer trocar o produto",
        opened_at: ONTEM,
        followup_attempts: 0,
        cobrancas_na_espera: 0,
        teto: 3,
        status: "awaiting_human",
      },
    ];

    const { body } = await rodar();

    expect(body.data?.avisados).toBe(1);
    expect(
      registro.inserts.find((i) => i.tabela === "agent_inbox_items")?.linha,
    ).toMatchObject({ kind: "case_stale", ref_kind: "agent_case" });
  });
});
