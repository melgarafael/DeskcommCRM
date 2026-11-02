/**
 * Status do WhatsApp PELO adapter (#3397).
 *
 * Este arquivo mede o caminho inteiro SEM tocar em provedor: o cliente do
 * transporte é dublê, e o adapter é o DE VERDADE (`getAdapter("waha")`). É de
 * propósito — o que a issue pede não é "o handler chama isto", é que a
 * publicação passe pelo CONTRATO do canal:
 *
 *   - o envelope que chega ao transporte é o do Status (imagem + legenda +
 *     público em JID), montado pelo adapter, não por quem publica;
 *   - quem não publica Status responde pela CAPABILITY, sem que a feature
 *     precise saber qual canal é;
 *   - canal desativado e canal fora do ar recusam ANTES do envio;
 *   - a lista de público depende do acervo do histórico, e a falta dele é
 *     EXPLICADA — nunca consertada ligando o acervo por conta própria (#999);
 *   - a chave de idempotência é reservada antes do efeito: retry não publica
 *     duas vezes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { sendStatusImage } = vi.hoisted(() => ({ sendStatusImage: vi.fn() }));

vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({ sendStatusImage }),
}));

import { lerPublico, publicarStatusDoWhatsapp } from "./publicacao-de-status";
import { getAdapter } from "./index";
import type { PublishStatusInput } from "./types";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const IMG = "A".repeat(200);

type Linha = Record<string, unknown>;
type Filtro = [string, unknown];

const SESSAO: Linha = {
  id: CANAL,
  provider: "waha",
  status: "WORKING",
  archived_at: null,
  waha_session_name: "loja",
  meta_phone_number_id: null,
  zernio_account_id: null,
  datafy_phone_number_id: null,
  metadata: { guardar_historico: true },
};

/**
 * Banco falso: `channel_sessions` só é LIDO (e as escritas são CONTADAS, para
 * provar que a publicação não liga o acervo sozinha), e `idempotency_keys`
 * implementa o mínimo que `comIdempotencia` usa — unicidade por
 * (endpoint, chave), filtro de janela e recibo terminal na mesma linha.
 */
function bancoFalso(opcoes: { sessao?: Linha | null; idem?: Map<string, Linha> } = {}) {
  const idem = opcoes.idem ?? new Map<string, Linha>();
  const contagem = { escritasEmCanais: 0 };

  const casa = (l: Linha, filtros: Filtro[]) => filtros.every(([c, v]) => l[c] === v);
  const chaveDe = (l: Linha) => `${String(l.endpoint)}|${String(l.key)}`;

  const selecaoIdem = () => {
    const filtros: Filtro[] = [];
    let dentroDaJanela: Filtro | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      gt: (c: string, v: unknown) => {
        dentroDaJanela = [c, v];
        return b;
      },
      maybeSingle: async () => {
        const achada = [...idem.values()].find(
          (l) =>
            casa(l, filtros) &&
            (dentroDaJanela === null ||
              String(l[dentroDaJanela[0]]) > String(dentroDaJanela[1])),
        );
        return { data: achada ?? null, error: null };
      },
    };
    return b;
  };

  const insercaoIdem = (linha: Linha) => {
    const gravar = async () => {
      if (idem.has(chaveDe(linha))) {
        return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      idem.set(chaveDe(linha), { ...linha, id: `idem-${idem.size + 1}` });
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      maybeSingle: gravar,
      then: (r?: (v: unknown) => unknown) => gravar().then(r ?? ((v: unknown) => v)),
    };
    return b;
  };

  const atualizacaoIdem = (patch: Linha) => {
    const filtros: Filtro[] = [];
    const aplicar = () => {
      const alvos = [...idem.values()].filter((l) => casa(l, filtros));
      for (const alvo of alvos) Object.assign(alvo, patch);
      return alvos;
    };
    const b: Record<string, unknown> = {
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      select: () => b,
      maybeSingle: async () => {
        const alvos = aplicar();
        return { data: alvos[0] ? { id: alvos[0].id } : null, error: null };
      },
      then: (r?: (v: unknown) => unknown) => {
        aplicar();
        return Promise.resolve({ data: null, error: null }).then(r ?? ((v: unknown) => v));
      },
    };
    return b;
  };

  const selecaoSessao = () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: opcoes.sessao ?? null, error: null }),
    };
    return b;
  };

  const escritaProibida = () => {
    contagem.escritasEmCanais += 1;
    const resultado = { data: null, error: null };
    return {
      select: () => ({ maybeSingle: async () => resultado }),
      maybeSingle: async () => resultado,
      then: (r?: (v: unknown) => unknown) => Promise.resolve(resultado).then(r ?? ((v: unknown) => v)),
    };
  };

  const db = {
    from: (tabela: string) =>
      tabela === "idempotency_keys"
        ? {
            select: () => selecaoIdem(),
            insert: (linha: Linha) => insercaoIdem(linha),
            update: (patch: Linha) => atualizacaoIdem(patch),
          }
        : {
            select: () => selecaoSessao(),
            insert: escritaProibida,
            update: escritaProibida,
          },
  };

  return { db: db as unknown as SupabaseClient, contagem, idem };
}

const entrada = (over: Partial<Parameters<typeof publicarStatusDoWhatsapp>[0]> = {}) => ({
  canalId: CANAL,
  organizationId: ORG,
  imagem: { mime: "image/jpeg" as const, base64: IMG },
  contatos: ["+55 (15) 99999-9999"],
  ...over,
});

describe("publicação de Status — o caminho passa pelo adapter do canal", () => {
  beforeEach(() => {
    sendStatusImage.mockReset().mockResolvedValue({ id: { id: "ST-1" } });
  });

  it("manda ao provedor o envelope do Status, com o público já em JID (o adapter traduz)", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    const feita = await publicarStatusDoWhatsapp({
      db,
      ...entrada({ contatos: ["+55 (15) 99999-9999", "5515988887777"], legenda: "Promo" }),
    });

    expect(sendStatusImage).toHaveBeenCalledWith("loja", {
      mimetype: "image/jpeg",
      data: IMG,
      caption: "Promo",
      contacts: ["5515999999999@c.us", "5515988887777@c.us"],
    });
    expect(feita).toEqual({
      publicado: true,
      statusId: "ST-1",
      publico: "2 contato(s)",
      deduplicado: false,
    });
  });

  it("`todos` sai SEM lista: no provedor, sem lista é o número inteiro", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined, todos: true }) });

    const envelope = sendStatusImage.mock.calls[0]![1] as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("contacts");
    expect(feita.publico).toBe("todos");
  });

  it("quem publica é o MÉTODO do adapter, e o público chega NEUTRO (dígitos, não JID)", async () => {
    // A prova de que a publicação passa pelo CONTRATO e não por uma chamada
    // direta ao provedor: o adapter recebe o público sem dialeto nenhum. Quem
    // vira `@c.us` é ele, uma camada abaixo — e é essa divisão que permite
    // outro canal publicar Status sem que a feature mude uma linha.
    const adapter = getAdapter("waha");
    const original = adapter.publishStatus;
    if (!original) throw new Error("o adapter WAHA deveria implementar publishStatus");
    const vistos: PublishStatusInput[] = [];
    adapter.publishStatus = async (publicacao) => {
      vistos.push(publicacao);
      return original.call(adapter, publicacao);
    };

    try {
      const { db } = bancoFalso({ sessao: SESSAO });
      await publicarStatusDoWhatsapp({ db, ...entrada({ legenda: "Promo" }) });
    } finally {
      adapter.publishStatus = original;
    }

    expect(vistos).toHaveLength(1);
    expect(vistos[0]?.sessionRef).toBe("loja");
    expect(vistos[0]?.publico).toEqual({ tipo: "contatos", numeros: ["5515999999999"] });
    expect(vistos[0]?.legenda).toBe("Promo");
    expect(vistos[0]?.imagem).toEqual({ mime: "image/jpeg", base64: IMG });
  });

  it("canal desativado pelo operador recusa antes de publicar", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, metadata: { disabled: true, guardar_historico: true } } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/canal_desativado/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("canal que não publica Status responde pela capability, sem a feature saber qual é", async () => {
    const { db } = bancoFalso({
      sessao: { ...SESSAO, provider: "meta_cloud", waha_session_name: null, meta_phone_number_id: "123" },
    });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/canal_sem_status/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("canal fora do ar recusa com o estado na mensagem", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, status: "SCAN_QR_CODE" } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/SCAN_QR_CODE/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("lista de público sem acervo do histórico EXPLICA o que falta e não liga nada", async () => {
    const { db, contagem } = bancoFalso({ sessao: { ...SESSAO, metadata: {} } });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada() })).rejects.toThrow(/acervo_desligado/);
    expect(sendStatusImage).not.toHaveBeenCalled();
    // A decisão da #999: quem liga o acervo é o operador, na tela. A publicação
    // não pode "resolver" a falta escrevendo no canal.
    expect(contagem.escritasEmCanais).toBe(0);
  });

  it("sem acervo, publicar para TODOS continua valendo (o acervo só governa a lista)", async () => {
    const { db } = bancoFalso({ sessao: { ...SESSAO, metadata: {} } });

    const feita = await publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined, todos: true }) });

    expect(feita.publicado).toBe(true);
    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });

  it("o público é escolha declarada: nem omitido, nem os dois", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await expect(publicarStatusDoWhatsapp({ db, ...entrada({ contatos: undefined }) })).rejects.toThrow(
      /publico_ausente/,
    );
    await expect(
      publicarStatusDoWhatsapp({ db, ...entrada({ contatos: ["5515999999999"], todos: true }) }),
    ).rejects.toThrow(/publico_ambiguo/);
    expect(sendStatusImage).not.toHaveBeenCalled();
  });

  it("idempotência: a mesma chave devolve a primeira publicação e NÃO publica de novo", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });
    const comum = entrada({ idempotencyKey: "run-1:step-3", legenda: "Promo" });

    const primeira = await publicarStatusDoWhatsapp({ db, ...comum });
    const segunda = await publicarStatusDoWhatsapp({ db, ...comum });

    expect(sendStatusImage).toHaveBeenCalledTimes(1);
    expect(primeira.deduplicado).toBe(false);
    expect(segunda).toEqual({ ...primeira, deduplicado: true });
  });

  it("a mesma chave com OUTRA imagem é conflito, não replay", async () => {
    const { db } = bancoFalso({ sessao: SESSAO });

    await publicarStatusDoWhatsapp({ db, ...entrada({ idempotencyKey: "run-2" }) });
    await expect(
      publicarStatusDoWhatsapp({
        db,
        ...entrada({ idempotencyKey: "run-2", imagem: { mime: "image/jpeg", base64: "B".repeat(200) } }),
      }),
    ).rejects.toThrow(/idempotency_conflict/);
    expect(sendStatusImage).toHaveBeenCalledTimes(1);
  });
});

describe("lerPublico — a régua é o dígito, não a máscara", () => {
  it("aceita os formatos em que as pessoas escrevem telefone", () => {
    expect(lerPublico(["+55 (15) 99999-9999", "5515 98888-7777"])).toEqual({
      tipo: "contatos",
      numeros: ["5515999999999", "5515988887777"],
    });
  });

  it("recusa o que não é telefone, dizendo QUAL entrada errou", () => {
    expect(() => lerPublico(["abc"])).toThrow(/contato_invalido/);
    expect(() => lerPublico(["1234"])).toThrow(/contato_invalido/);
  });

  it("não repete o mesmo número (mandar duas vezes é ruído, não público)", () => {
    expect(lerPublico(["+55 15 99999-9999", "5515999999999"])).toEqual({
      tipo: "contatos",
      numeros: ["5515999999999"],
    });
  });

  it("lista vazia não é 'todos'", () => {
    expect(() => lerPublico([])).toThrow(/publico_ausente/);
    expect(() => lerPublico(undefined)).toThrow(/publico_ausente/);
  });
});
