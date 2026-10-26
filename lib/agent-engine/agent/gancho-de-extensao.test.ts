import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ExtensionPermission } from "@/lib/extensions/capacidades";
import type { FluxoDoTurno } from "@/lib/extensions/fluxo-do-turno";

import {
  CHAVE_DO_GANCHO,
  lerFluxosAtivosDaOrganizacao,
  prepararGanchoDoTurno,
  type DecisaoDoTurno,
  type FluxoAtivoDaOrganizacao,
} from "./gancho-de-extensao";

/**
 * O GANCHO NO TURNO, MEDIDO PELO COMPORTAMENTO — e o que o #3456 exigiu que existisse.
 *
 * Cada bloco abaixo corresponde a uma exigência do mantenedor, e nenhum deles afirma
 * "chamou a função": todos olham o EFEITO (bolha enviada ou não, passagem gravada ou não,
 * atividade na timeline, estado da conversa). A razão é a lição do próprio PR fechado: cinco
 * checks verdes não exercitavam a concessão nova, porque mediam a forma e não a autoridade.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

function fluxoDeLaudo(over: Partial<FluxoDoTurno> = {}): FluxoDoTurno {
  return {
    id: "laudo",
    idiomas: ["pt-BR"],
    gatilhos: [{ idioma: "pt-BR", texto: "laudo" }],
    perguntas: [
      { campo: "exame", texto: { "pt-BR": "Qual é o tipo de exame?" } },
      { campo: "paciente", texto: { "pt-BR": "Qual é o nome do paciente?" } },
    ],
    desfecho: {
      tipo: "passar_para_humano",
      aviso: { "pt-BR": "Vou passar para a equipe conferir." },
    },
    ...over,
  };
}

const AMBAS: ExtensionPermission[] = ["turn.send", "turn.handoff"];

interface LinhaDeExtensao {
  extensao: string;
  fluxo: FluxoDoTurno;
  permissoes: ExtensionPermission[];
  aceitas: ExtensionPermission[];
}

/**
 * Um `pg.Pool` de mentira com as DUAS leituras que o gancho faz: as extensões ativas (com
 * permissões declaradas e aceites) e o estado da conversa. SQL inesperado LANÇA — um fake que
 * responde qualquer coisa deixaria passar consulta nova sem teste.
 */
function bancoDeMentira(opts: {
  extensoes?: LinhaDeExtensao[];
  estado?: unknown;
} = {}) {
  const estado = { valor: opts.estado ?? null };
  const consultas: string[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      consultas.push(sql);
      if (sql.includes("from organization_extensions oe")) {
        return {
          rows: (opts.extensoes ?? []).map((linha) => ({
            extensao: linha.extensao,
            fluxo: linha.fluxo,
            permissoes: linha.permissoes,
            aceitas: linha.aceitas,
          })),
        };
      }
      if (sql.includes("select metadata->")) return { rows: [{ estado: estado.valor }] };
      if (sql.includes("set metadata = coalesce(metadata, '{}'::jsonb) ||")) {
        estado.valor = JSON.parse(String(params?.[3]));
        return { rows: [] };
      }
      if (sql.includes("set metadata = coalesce(metadata, '{}'::jsonb) -")) {
        estado.valor = null;
        return { rows: [] };
      }
      throw new Error(`SQL inesperado no teste: ${sql}`);
    },
  };
  return { pool: pool as never, estado, consultas };
}

function dependencias(pool: never, over: Partial<Parameters<typeof prepararGanchoDoTurno>[0]> = {}) {
  const enviadas: string[] = [];
  const passagens: Array<{ campos: Record<string, string>; aviso: string; idempotencia: string | null }> = [];
  const atividades: Array<{ tipo: string; extensao: string; fluxo: string; motivo: string }> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    pool,
    log,
    fluxos: () => lerFluxosAtivosDaOrganizacao(pool, ORG, log),
    enviar: async (texto: string) => {
      enviadas.push(texto);
      return true;
    },
    passarParaHumano: async (args: {
      campos: Record<string, string>;
      aviso: string;
      idempotencia: string | null;
    }) => {
      passagens.push({ campos: args.campos, aviso: args.aviso, idempotencia: args.idempotencia });
    },
    registrarAtividade: async (args: {
      tipo: string;
      extensao: string;
      fluxo: string;
      motivo: string;
    }) => {
      atividades.push(args);
    },
    ...over,
  };
  return { deps, enviadas, passagens, atividades, log };
}

function turno(texto: string | null, messageId: string | null = MSG) {
  return {
    organizationId: ORG,
    contactId: CONTATO,
    conversationId: CONVERSA,
    texto,
    messageId,
    agora: new Date("2026-10-26T12:00:00Z"),
  };
}

const EXTENSAO: LinhaDeExtensao = {
  extensao: "deskcomm/laudo-do-exame",
  fluxo: fluxoDeLaudo(),
  permissoes: AMBAS,
  aceitas: AMBAS,
};

describe("sem extensão, o turno é o de sempre (item 7 da doutrina)", () => {
  it("organização sem extensão ativa: não envia, não grava, não registra atividade", async () => {
    const { pool, estado } = bancoDeMentira({ extensoes: [] });
    const { deps, enviadas, atividades, passagens } = dependencias(pool as never);
    const decisao = await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"));
    expect(decisao).toEqual({ tipo: "nao_e_comigo", porque: "sem_extensoes" });
    expect(enviadas).toEqual([]);
    expect(passagens).toEqual([]);
    expect(atividades).toEqual([]);
    expect(estado.valor).toBeNull();
  });
});

describe("sem ACEITE, a extensão não age (exigência 2)", () => {
  it("extensão ativa, fluxo válido e NENHUM aceite: a IA responde e nada é enviado", async () => {
    const { pool, estado } = bancoDeMentira({
      extensoes: [{ ...EXTENSAO, aceitas: [] }],
    });
    const { deps, enviadas, atividades, log } = dependencias(pool as never);
    const decisao = await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"));
    expect(decisao).toEqual({ tipo: "nao_e_comigo", porque: "sem_extensoes" });
    expect(enviadas).toEqual([]);
    expect(atividades).toEqual([]);
    expect(estado.valor).toBeNull();
    // O log diz QUAL elo faltou — sem isso, "não age" vira adivinhação.
    expect(
      log.info.mock.calls.some(
        ([msg, campos]) =>
          String(msg).includes("sem concessão") &&
          (campos as { motivo?: string }).motivo === "sem_aceite",
      ),
    ).toBe(true);
  });

  it("aceite só do envio não basta para um fluxo que passa a conversa a uma pessoa", async () => {
    const { pool } = bancoDeMentira({
      extensoes: [{ ...EXTENSAO, aceitas: ["turn.send"] }],
    });
    const { deps, enviadas, log } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "sem_extensoes",
    });
    expect(enviadas).toEqual([]);
    expect(
      log.info.mock.calls.some(
        ([, campos]) => (campos as { motivo?: string }).motivo === "aceite_desatualizado",
      ),
    ).toBe(true);
  });

  it("manifesto sem permissão de turno é ignorado antes do aceite (sem_permissao_declarada)", async () => {
    const { pool } = bancoDeMentira({
      extensoes: [{ ...EXTENSAO, permissoes: ["navigation.tasks"], aceitas: AMBAS }],
    });
    const { deps, enviadas, log } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "sem_extensoes",
    });
    expect(enviadas).toEqual([]);
    expect(
      log.info.mock.calls.some(
        ([, campos]) => (campos as { motivo?: string }).motivo === "sem_permissao_declarada",
      ),
    ).toBe(true);
  });

  it("com o aceite das duas, a MESMA mensagem é atendida pela extensão", async () => {
    const { pool, estado } = bancoDeMentira({ extensoes: [EXTENSAO] });
    const { deps, enviadas, atividades } = dependencias(pool as never);
    const decisao: DecisaoDoTurno = await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"));
    expect(decisao).toEqual({ tipo: "assumido", fluxo: "laudo", porque: "comecou" });
    expect(enviadas).toEqual(["Qual é o tipo de exame?"]);
    expect(atividades.map((a) => a.tipo)).toEqual(["extension_turn_assumed"]);
    // O claim fica gravado ANTES do envio (retry não repete a bolha), com a etapa da
    // primeira pergunta e nenhum campo coletado ainda.
    expect(estado.valor).toMatchObject({
      extensao: EXTENSAO.extensao,
      etapa: 0,
      campos: {},
      mensagens: [MSG],
    });
  });
});

describe("atualização: permissão nova ⇒ aceite novo; removida ⇒ nada quebra (exigência 3)", () => {
  it("versão que passa a pedir `turn.handoff` para de agir até o aceite novo", async () => {
    // A organização aceitou o conjunto da v1 (só encerrava a coleta). A v2 vigente passou a
    // entregar a conversa a uma pessoa — e NÃO herda o aceite antigo.
    const v2: LinhaDeExtensao = { ...EXTENSAO, aceitas: ["turn.send"] };
    const { pool } = bancoDeMentira({ extensoes: [v2] });
    const { deps, enviadas } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "sem_extensoes",
    });
    expect(enviadas).toEqual([]);

    // Aceite novo — agora as duas — e a mesma mensagem volta a ser atendida.
    const aceito = bancoDeMentira({ extensoes: [{ ...EXTENSAO, aceitas: AMBAS }] });
    const segunda = dependencias(aceito.pool as never);
    expect(await prepararGanchoDoTurno(segunda.deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "assumido",
      fluxo: "laudo",
      porque: "comecou",
    });
    expect(segunda.enviadas).toHaveLength(1);
  });

  it("versão que REMOVE uma permissão continua agindo: o aceite antigo cobre o que sobrou", async () => {
    // Manifesto vigente pede só `turn.send` (desfecho que encerra a coleta); a organização
    // aceitou um conjunto maior no passado. Exigir igualdade aqui pararia a conversa de quem
    // não mudou nada — é o lado da exigência 3 que o hash do conjunto quebraria.
    const vMenor: LinhaDeExtensao = {
      ...EXTENSAO,
      fluxo: fluxoDeLaudo({
        desfecho: { tipo: "assumir", texto: { "pt-BR": "Anotei, obrigado!" } },
      }),
      permissoes: ["turn.send"],
      aceitas: ["turn.send", "turn.handoff"],
    };
    const { pool } = bancoDeMentira({ extensoes: [vMenor] });
    const { deps, enviadas } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "assumido",
      fluxo: "laudo",
      porque: "comecou",
    });
    expect(enviadas).toEqual(["Qual é o tipo de exame?"]);
  });
});

describe("reversão: desligar/desinstalar devolve o turno à IA (exigência 4)", () => {
  it("desligada no meio de uma coleta: o estado é recolhido, a timeline registra a DEVOLUÇÃO", async () => {
    // A conversa está no meio do fluxo (etapa 1) e a extensão deixou de dirigir — mas OUTRA
    // extensão com fluxo segue ativa, então o leitor roda e o estado órfão é recolhido.
    const outra: LinhaDeExtensao = {
      extensao: "deskcomm/outra",
      fluxo: fluxoDeLaudo({ id: "outra", gatilhos: [{ idioma: "pt-BR", texto: "outra-coisa" }] }),
      permissoes: AMBAS,
      aceitas: AMBAS,
    };
    const { pool, estado } = bancoDeMentira({
      extensoes: [outra],
      estado: {
        extensao: EXTENSAO.extensao,
        fluxo: "laudo",
        idioma: "pt-BR",
        etapa: 1,
        campos: { exame: "sangue" },
        sem_progresso: 0,
        mensagens: [],
        iniciado_em: "2026-10-26T11:00:00Z",
      },
    });
    const { deps, enviadas, atividades } = dependencias(pool as never);
    const decisao = await prepararGanchoDoTurno(deps, turno("Maria"));
    expect(decisao).toEqual({ tipo: "nao_e_comigo", porque: "fluxo_sumiu" });
    expect(enviadas).toEqual([]);
    expect(estado.valor).toBeNull();
    expect(atividades).toEqual([
      {
        tipo: "extension_turn_returned",
        extensao: EXTENSAO.extensao,
        fluxo: "laudo",
        motivo: "extensao_nao_dirige_mais",
      },
    ]);
  });

  it("nenhuma extensão ativa (desligada/removida): a IA responde e não há escrita", async () => {
    const { pool } = bancoDeMentira({ extensoes: [] });
    const { deps, enviadas } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Maria"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "sem_extensoes",
    });
    expect(enviadas).toEqual([]);
  });

  it("a leitura filtra vínculo desligado e instalação removida NO BANCO", async () => {
    // Sem estes dois filtros, uma extensão removida da instalação voltaria a dirigir a conversa
    // no turno seguinte — a reversão não aconteceria na prática, só no teste de lista vazia.
    const { pool, consultas } = bancoDeMentira({ extensoes: [] });
    await prepararGanchoDoTurno(dependencias(pool as never).deps, turno("Preciso do meu laudo"));
    const leitura = consultas.find((sql) => sql.includes("from organization_extensions oe")) ?? "";
    expect(leitura).toContain("oe.enabled");
    expect(leitura).toContain("i.removed_at is null");
    // E o aceite é lido da LINHA da organização, não do manifesto.
    expect(leitura).toContain("accepted_permissions");
  });
});

describe("as atividades de assumir e devolver (exigência 6)", () => {
  it("assumir uma vez, e devolver ao concluir — duas linhas, não uma por mensagem", async () => {
    const encerra: LinhaDeExtensao = {
      ...EXTENSAO,
      fluxo: fluxoDeLaudo({
        desfecho: { tipo: "assumir", texto: { "pt-BR": "Anotei, obrigado!" } },
      }),
      permissoes: ["turn.send"],
      aceitas: ["turn.send"],
    };
    const { pool } = bancoDeMentira({ extensoes: [encerra] });
    const { deps, enviadas, atividades } = dependencias(pool as never);

    // Turno 1: o gatilho assume.
    expect((await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo", "m1"))).tipo).toBe(
      "assumido",
    );
    expect(atividades.map((a) => a.tipo)).toEqual(["extension_turn_assumed"]);

    // Turno 2: primeira resposta. NÃO muda de dono — nenhuma atividade nova.
    expect((await prepararGanchoDoTurno(deps, turno("sangue", "m2"))).tipo).toBe("assumido");
    expect(atividades.map((a) => a.tipo)).toEqual(["extension_turn_assumed"]);

    // Turno 3: última resposta — conclui e devolve.
    expect((await prepararGanchoDoTurno(deps, turno("Maria", "m3"))).tipo).toBe("concluido");
    expect(atividades.map((a) => a.tipo)).toEqual([
      "extension_turn_assumed",
      "extension_turn_returned",
    ]);
    expect(atividades[1]!.motivo).toBe("concluido:coletou");
    expect(enviadas).toEqual([
      "Qual é o tipo de exame?",
      "Qual é o nome do paciente?",
      "Anotei, obrigado!",
    ]);
  });

  it("mensagem fora do fluxo devolve a conversa E registra a devolução", async () => {
    const { pool, estado } = bancoDeMentira({
      extensoes: [EXTENSAO],
      estado: {
        extensao: EXTENSAO.extensao,
        fluxo: "laudo",
        idioma: "pt-BR",
        etapa: 1,
        campos: {},
        sem_progresso: 0,
        mensagens: [],
        iniciado_em: "2026-10-26T11:00:00Z",
      },
    });
    const { deps, atividades, enviadas } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("quanto custa?"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "fora_do_fluxo",
    });
    expect(enviadas).toEqual([]);
    expect(estado.valor).toBeNull();
    expect(atividades).toEqual([
      {
        tipo: "extension_turn_returned",
        extensao: EXTENSAO.extensao,
        fluxo: "laudo",
        motivo: "devolvido:fora_do_fluxo",
      },
    ]);
  });
});

describe("a jornada completa: gatilho, perguntas e passagem com os campos", () => {
  it("duas respostas levam a passagem para humano com os campos coletados", async () => {
    const { pool, estado } = bancoDeMentira({ extensoes: [EXTENSAO] });
    const { deps, enviadas, passagens, atividades } = dependencias(pool as never);

    expect((await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo", "m1"))).tipo).toBe(
      "assumido",
    );
    expect((await prepararGanchoDoTurno(deps, turno("sangue", "m2"))).tipo).toBe("assumido");
    const final = await prepararGanchoDoTurno(deps, turno("Maria Silva", "m3"));

    expect(final).toEqual({
      tipo: "passado",
      fluxo: "laudo",
      porque: "coletou",
      campos: { exame: "sangue", paciente: "Maria Silva" },
    });
    expect(passagens).toHaveLength(1);
    expect(passagens[0]).toEqual({
      campos: { exame: "sangue", paciente: "Maria Silva" },
      aviso: "Vou passar para a equipe conferir.",
      // A chave do retry é a MENSAGEM reivindicada (#3063): o mesmo turno reexecutado não
      // grava duas passagens.
      idempotencia: "m3",
    });
    // Passar NÃO vira atividade de "devolver": quem conta essa passagem é `handoff_triggered`,
    // emitida pelo próprio handoff. Três linhas para o mesmo turno seria a timeline repetindo.
    expect(atividades.map((a) => a.tipo)).toEqual(["extension_turn_assumed"]);
    // O gancho mandou as duas perguntas; o AVISO é do handoff (o chamador o envia pela mesma
    // cadeia), e não uma terceira bolha daqui — por isso ele está em `passagens[0]`, não em
    // `enviadas`.
    expect(enviadas).toEqual(["Qual é o tipo de exame?", "Qual é o nome do paciente?"]);
    expect(estado.valor).toBeNull();
  });

  it("retry do mesmo turno não manda a bolha duas vezes (claim)", async () => {
    const { pool } = bancoDeMentira({
      extensoes: [EXTENSAO],
      estado: {
        extensao: EXTENSAO.extensao,
        fluxo: "laudo",
        idioma: "pt-BR",
        etapa: 1,
        campos: { exame: "sangue" },
        sem_progresso: 0,
        mensagens: ["m2"],
        iniciado_em: "2026-10-26T11:00:00Z",
      },
    });
    const { deps, enviadas } = dependencias(pool as never);
    expect(await prepararGanchoDoTurno(deps, turno("Maria", "m2"))).toEqual({
      tipo: "ja_tratado",
      fluxo: "laudo",
    });
    expect(enviadas).toEqual([]);
  });

  it("envio vetado pela cadeia devolve o turno à IA em vez de deixar a conversa muda", async () => {
    const { pool, estado } = bancoDeMentira({ extensoes: [EXTENSAO] });
    const { deps, atividades } = dependencias(pool as never, {
      enviar: async () => false,
    });
    expect(await prepararGanchoDoTurno(deps, turno("Preciso do meu laudo"))).toEqual({
      tipo: "nao_e_comigo",
      porque: "envio_vetado",
    });
    expect(estado.valor).toBeNull();
    expect(atividades).toEqual([]);
  });
});

describe("a posição no turno é o contrato", () => {
  /**
   * O gancho precisa ficar DEPOIS dos silenciadores e ANTES do roteiro e da IA. O teste lê o
   * texto do turno (como o do #1130 faz com o roteiro): a ordem não é observável por unidade, e
   * trocá-la reabre o defeito medido no #1130 — a extensão falando com quem pediu para parar.
   */
  const fonte = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );

  it("entra depois da trava de opt-out e antes do roteiro e da IA", () => {
    const chamada = fonte.indexOf("prepararGanchoDoTurno(");
    const roteiro = fonte.indexOf("prepararRoteiroDoTurno(");
    expect(chamada).toBeGreaterThan(0);
    expect(roteiro).toBeGreaterThan(0);
    expect(chamada).toBeLessThan(roteiro);
    // A condição exata da chamada: prévia nunca, job de entrada e nunca com opt-out.
    expect(fonte).toContain(
      "if (!preview && liveJob().kind === 'inbound_turn' && !optedOutThisTurn) {",
    );
  });

  it("o estado do gancho mora no metadata da conversa, sem tabela por pacote", () => {
    expect(CHAVE_DO_GANCHO).toBe("gancho_de_extensao");
    const bloco = fonte.slice(fonte.indexOf("prepararGanchoDoTurno("));
    expect(bloco.slice(0, 4000)).toContain("lerFluxosAtivosDaOrganizacao(pool, tenantId, runLog)");
  });
});
