import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAVE_DO_GANCHO,
  prepararGanchoDoTurno,
  type DepsDoGancho,
  type FluxoAtivoDaOrganizacao,
  type TurnoDoGancho,
} from "@/lib/agent-engine/agent/gancho-de-extensao";
import type { FluxoDoTurno } from "@/lib/extensions/fluxo-do-turno";

/**
 * O HOST do gancho de extensão (#3076) — claim, estado por conversa, decisão e
 * os dois efeitos (bolha pela cadeia / passagem com campos coletados).
 *
 * O que este arquivo prova, e por que cada um importa:
 *   - zero extensões ativas = turno idêntico, SEM escrita (item 7);
 *   - retry da mesma mensagem é NO-OP, e não anda a etapa (item 4);
 *   - mídia sem texto não prende nem cala a conversa;
 *   - mensagem fora do fluxo devolve para a IA e ENCERRA o estado;
 *   - a passagem leva os campos e a chave de idempotência da mensagem;
 *   - cadeia de envio vetou = a IA responde no lugar (nunca silêncio).
 */

const AGORA = new Date("2026-10-26T12:00:00.000Z");

const FLUXO: FluxoDoTurno = {
  id: "laudo",
  idiomas: ["pt-BR", "en"],
  gatilhos: [
    { idioma: "pt-BR", texto: "meu laudo está pronto" },
    { idioma: "en", texto: "is my report ready" },
  ],
  perguntas: [
    { campo: "tipo-de-exame", texto: { "pt-BR": "Qual é o tipo de exame?" } },
    { campo: "nome", texto: { "pt-BR": "Qual é o seu nome completo?" } },
  ],
  desfecho: {
    tipo: "passar_para_humano",
    aviso: { "pt-BR": "Vou passar seu caso para a equipe conferir." },
  },
};

const ATIVO: FluxoAtivoDaOrganizacao = { extensao: "acme/laudo", fluxo: FLUXO };

type Consulta = { sql: string; params: unknown[] };
const consultas: Consulta[] = [];
let estadoGravado: unknown = null;

function poolFake(opcoes: { estado?: unknown } = {}) {
  estadoGravado = opcoes.estado ?? null;
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (/select metadata->\$3 as estado/.test(sql)) {
        return { rows: [{ estado: estadoGravado }], rowCount: 1 };
      }
      if (/jsonb_build_object\(\$3::text/.test(sql)) {
        estadoGravado = JSON.parse(String(params[3]));
        return { rows: [], rowCount: 1 };
      }
      if (/coalesce\(metadata, '\{\}'::jsonb\) - \$3::text/.test(sql)) {
        estadoGravado = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

function turno(extra: Partial<TurnoDoGancho> = {}): TurnoDoGancho {
  return {
    organizationId: "org1",
    contactId: "cont1",
    conversationId: "conv1",
    texto: "meu laudo está pronto?",
    messageId: "m1",
    agora: AGORA,
    ...extra,
  };
}

function deps(pool: ReturnType<typeof poolFake>, extra: Partial<DepsDoGancho> = {}): DepsDoGancho {
  return {
    pool: pool as never,
    log: log as never,
    fluxos: async () => [ATIVO],
    enviar: vi.fn(async () => true),
    passarParaHumano: vi.fn(async () => {}),
    ...extra,
  };
}

function estadoDe(etapa: number, extra: Record<string, unknown> = {}) {
  return {
    extensao: "acme/laudo",
    fluxo: "laudo",
    idioma: "pt-BR",
    etapa,
    campos: {},
    sem_progresso: 0,
    mensagens: [] as string[],
    iniciado_em: AGORA.toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  consultas.length = 0;
  log.info.mockClear();
  log.warn.mockClear();
});

describe("item 7 — zero extensões ativas é o turno de hoje", () => {
  it("sem extensão nenhuma: nao_e_comigo, e NENHUMA escrita no metadata", async () => {
    const pool = poolFake();
    const d = deps(pool, { fluxos: async () => [] });
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "sem_extensoes" });
    expect(d.enviar).not.toHaveBeenCalled();
    expect(d.passarParaHumano).not.toHaveBeenCalled();
    // A única consulta feita é a leitura do estado? Não: nem isso — a lista
    // vazia voltou antes.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("extensões ativas mas NENHUMA com fluxo: também nao_e_comigo", async () => {
    const d = deps(poolFake(), { fluxos: async () => [] });
    expect((await prepararGanchoDoTurno(d, turno())).tipo).toBe("nao_e_comigo");
  });

  it("falha na leitura das extensões não derruba o turno", async () => {
    const d = deps(poolFake(), {
      fluxos: async () => {
        throw new Error("banco fora");
      },
    });
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "leitura_falhou" });
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("item 1/2 — assumir: a extensão responde e a IA não roda", () => {
  it("gatilho começa o fluxo: grava estado, manda a 1ª pergunta e devolve 'assumido'", async () => {
    const pool = poolFake();
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toMatchObject({ tipo: "assumido", fluxo: "laudo", porque: "comecou" });
    expect(d.enviar).toHaveBeenCalledWith("Qual é o tipo de exame?", ATIVO);
    // Estoque gravado com o claim da mensagem.
    expect(estadoGravado).toMatchObject({
      fluxo: "laudo",
      extensao: "acme/laudo",
      etapa: 0,
      mensagens: ["m1"],
    });
  });

  it("resposta avança: manda a pergunta seguinte", async () => {
    const pool = poolFake({ estado: estadoDe(0, { mensagens: ["m0"] }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Hemograma completo", messageId: "m1" }));
    expect(r).toMatchObject({ tipo: "assumido", porque: "avancou" });
    expect(d.enviar).toHaveBeenCalledWith("Qual é o seu nome completo?", ATIVO);
    expect(estadoGravado).toMatchObject({
      etapa: 1,
      campos: { "tipo-de-exame": "Hemograma completo" },
      mensagens: ["m0", "m1"],
    });
  });

  it("⭐ item 4 — retry da MESMA mensagem é no-op: não anda a etapa nem manda bolha", async () => {
    const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m1"], campos: { "tipo-de-exame": "Hemograma" } }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Maria Silva", messageId: "m1" }));
    expect(r).toEqual({ tipo: "ja_tratado", fluxo: "laudo" });
    expect(d.enviar).not.toHaveBeenCalled();
    expect(estadoGravado).toMatchObject({ etapa: 1 }); // não andou
  });

  it("⭐ item 6 — a cadeia vetou a bolha: devolve para a IA e APAGA o estado", async () => {
    const pool = poolFake();
    const d = deps(pool, { enviar: vi.fn(async () => false) });
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "envio_vetado" });
    expect(estadoGravado).toBeNull();
  });

  it("falha ao gravar o estado: não manda bolha nenhuma (evita bolha sem claim)", async () => {
    const pool = poolFake();
    pool.query.mockImplementationOnce(async () => ({ rows: [{ estado: null }], rowCount: 1 }));
    pool.query.mockImplementationOnce(async () => {
      throw new Error("metadata travado");
    });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "gravacao_falhou" });
    expect(d.enviar).not.toHaveBeenCalled();
  });
});

describe("item 3 — sempre uma saída", () => {
  it.each(["obrigado", "quanto custa?", "abrem sábado?"])(
    "mensagem fora do fluxo devolve para a IA e ENCERRA o estado: %s",
    async (texto) => {
      const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m0"], campos: { "tipo-de-exame": "Hemograma" } }) });
      const d = deps(pool);
      const r = await prepararGanchoDoTurno(d, turno({ texto, messageId: "m1" }));
      expect(r).toEqual({ tipo: "nao_e_comigo", porque: "fora_do_fluxo" });
      expect(estadoGravado).toBeNull();
      expect(d.enviar).not.toHaveBeenCalled();
    },
  );

  it("⭐ item 4 — mídia sem texto não deixa a conversa calada: repete a pergunta", async () => {
    const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m0"] }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: null, messageId: "m1" }));
    expect(r).toMatchObject({ tipo: "assumido", porque: "repetiu" });
    expect(d.enviar).toHaveBeenCalledWith("Qual é o seu nome completo?", ATIVO);
    expect(estadoGravado).toMatchObject({ sem_progresso: 1 });
  });

  it("teto de turnos sem progresso escala para humano em vez de repetir para sempre", async () => {
    const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m0"], sem_progresso: 5 }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: null, messageId: "m1" }));
    expect(r).toMatchObject({ tipo: "passado", porque: "teto" });
    expect(d.passarParaHumano).toHaveBeenCalledTimes(1);
  });

  it("fluxo sumiu (extensão desligada): estado órfão é recolhido e a IA responde", async () => {
    const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m0"] }) });
    const d = deps(pool, { fluxos: async () => [] });
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Maria", messageId: "m1" }));
    // Com zero fluxos o curto-circuito vem antes da leitura do estado; o estado
    // órfão é inerte e some na primeira vez que a organização tiver extensão.
    expect(r.tipo).toBe("nao_e_comigo");
  });

  it("estado de fluxo que a versão nova não tem mais: recolhe e devolve", async () => {
    const pool = poolFake({ estado: estadoDe(1, { fluxo: "fluxo-antigo" }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Maria", messageId: "m1" }));
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "fluxo_sumiu" });
  });
});

describe("item 2/4 — passo para humano com campos coletados", () => {
  it("última resposta: passa com os campos e a chave de idempotência da mensagem", async () => {
    const pool = poolFake({ estado: estadoDe(1, { mensagens: ["m0"], campos: { "tipo-de-exame": "Hemograma" } }) });
    const d = deps(pool);
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Maria Silva", messageId: "m1" }));
    expect(r).toMatchObject({ tipo: "passado", porque: "coletou" });
    expect(d.passarParaHumano).toHaveBeenCalledWith({
      fluxo: ATIVO,
      campos: { "tipo-de-exame": "Hemograma", nome: "Maria Silva" },
      aviso: "Vou passar seu caso para a equipe conferir.",
      idempotencia: "m1",
    });
    expect(estadoGravado).toBeNull();
  });

  it("a passagem falhou: o turno segue para a IA (nunca fica sem resposta)", async () => {
    const pool = poolFake({ estado: estadoDe(1, { campos: { "tipo-de-exame": "Hemograma" } }) });
    const d = deps(pool, {
      passarParaHumano: vi.fn(async () => {
        throw new Error("passagem falhou");
      }),
    });
    const r = await prepararGanchoDoTurno(d, turno({ texto: "Maria Silva", messageId: "m1" }));
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "passagem_falhou" });
  });
});

describe("ambiguidade e cerca de idioma", () => {
  it("dois fluxos casando a mesma mensagem: NENHUM assume (empate é negação)", async () => {
    const outro: FluxoAtivoDaOrganizacao = {
      extensao: "outra/loja",
      fluxo: { ...FLUXO, id: "laudo-2" },
    };
    const d = deps(poolFake(), { fluxos: async () => [ATIVO, outro] });
    const r = await prepararGanchoDoTurno(d, turno());
    expect(r).toEqual({ tipo: "nao_e_comigo", porque: "sem_gatilho" });
    expect(d.enviar).not.toHaveBeenCalled();
  });

  it("mensagem em idioma fora da cobertura vai para a IA", async () => {
    const d = deps(poolFake());
    const r = await prepararGanchoDoTurno(d, turno({ texto: "hola, mi informe esta listo" }));
    expect(r.tipo).toBe("nao_e_comigo");
    expect(d.enviar).not.toHaveBeenCalled();
  });

  it("o estado é lido pela CHAVE do gancho, no mesmo metadata do claim do roteiro", async () => {
    await prepararGanchoDoTurno(deps(poolFake()), turno());
    const leitura = consultas.find((c) => /select metadata->\$3 as estado/.test(c.sql));
    expect(leitura?.params[2]).toBe(CHAVE_DO_GANCHO);
  });
});
