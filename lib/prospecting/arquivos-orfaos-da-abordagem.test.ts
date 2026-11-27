import { describe, expect, it } from "vitest";

import {
  type ArquivoDaAbordagemNoBucket,
  BUCKET_DOS_ARQUIVOS_DA_ABORDAGEM,
  CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS,
  type ClienteDeStorageDaAbordagem,
  caminhoPertenceAPastaDaAbordagem,
  drenarArquivosOrfaosDaAbordagem,
  type FonteDaProspeccao,
  limparArquivosOrfaosDaAbordagem,
  pastaDosArquivosDaAbordagem,
} from "./arquivos-orfaos-da-abordagem";

const AGORA = new Date("2026-11-22T12:00:00.000Z");
const ORG = "11111111-1111-1111-1111-111111111111";
const OUTRA_ORG = "22222222-2222-2222-2222-222222222222";

function diasAtras(dias: number): Date {
  return new Date(AGORA.getTime() - dias * 86_400_000);
}

/** Um arquivo do bucket com idade e tamanho controlados pelo teste. */
function arquivo(
  caminho: string,
  opcoes: { dias?: number; bytes?: number | null; semIdade?: boolean } = {},
): ArquivoDaAbordagemNoBucket {
  return {
    caminho,
    bytes: opcoes.bytes === undefined ? 1_000 : opcoes.bytes,
    criadoEm: opcoes.semIdade ? null : diasAtras(opcoes.dias ?? 30),
    atualizadoEm: opcoes.semIdade ? null : diasAtras(opcoes.dias ?? 30),
  };
}

/**
 * Storage FALSO: guarda o conteúdo num Map e devolve o caminho completo no
 * `list`, como o adaptador do Supabase faz. `list` recebe a pasta sem barra
 * final; `remove` tira as chaves. Sem rede.
 */
function storageFalso(inicial: ArquivoDaAbordagemNoBucket[]): {
  cliente: ClienteDeStorageDaAbordagem;
  restante: () => string[];
  removidos: string[];
  listagens: string[];
} {
  const objetos = new Map(inicial.map((a) => [a.caminho, a]));
  const removidos: string[] = [];
  const listagens: string[] = [];
  const cliente: ClienteDeStorageDaAbordagem = {
    async list(prefixo) {
      listagens.push(prefixo);
      // Devolve TUDO, inclusive caminho de outro dono: é proposital. A cerca de
      // `{org}/prospecting/` é da REGRA, não do adaptador — o teste do "arquivo
      // de outra organização" depende de o falso mostrar o alheio para que a
      // regra tenha o que recusar.
      return { arquivos: [...objetos.values()], erro: null };
    },
    async remove(caminhos) {
      const confirmados: string[] = [];
      for (const caminho of caminhos) {
        if (objetos.delete(caminho)) {
          confirmados.push(caminho);
          removidos.push(caminho);
        }
      }
      return { removidos: confirmados, erro: null };
    },
  };
  return { cliente, restante: () => [...objetos.keys()].sort(), removidos, listagens };
}

describe("caminhoPertenceAPastaDaAbordagem — a cerca do dono e da pasta", () => {
  it("aceita só `{org}/prospecting/<arquivo>` desta organização", () => {
    expect(caminhoPertenceAPastaDaAbordagem(`${ORG}/prospecting/a.pdf`, ORG)).toBe(true);
    // Outra organização: outro dono.
    expect(caminhoPertenceAPastaDaAbordagem(`${OUTRA_ORG}/prospecting/a.pdf`, ORG)).toBe(false);
    // Mesma organização, outra pasta: mídia de conversa, resposta rápida, proposta.
    expect(caminhoPertenceAPastaDaAbordagem(`${ORG}/conv-1/a.pdf`, ORG)).toBe(false);
    expect(caminhoPertenceAPastaDaAbordagem(`${ORG}/templates/a.pdf`, ORG)).toBe(false);
    // Travessia e barra final vazia não passam.
    expect(caminhoPertenceAPastaDaAbordagem(`${ORG}/prospecting/../x/a.pdf`, ORG)).toBe(false);
    expect(caminhoPertenceAPastaDaAbordagem(`${ORG}/prospecting/`, ORG)).toBe(false);
  });

  it("a pasta do `list` não leva barra final, mas o caminho do arquivo leva", () => {
    expect(pastaDosArquivosDaAbordagem(ORG)).toBe(`${ORG}/prospecting`);
    expect(BUCKET_DOS_ARQUIVOS_DA_ABORDAGEM).toBeTruthy();
  });
});

describe("limparArquivosOrfaosDaAbordagem — o caso da issue", () => {
  it("sobe A, troca por B e roda a limpeza: A some, B fica", async () => {
    const A = `${ORG}/prospecting/a.pdf`;
    const B = `${ORG}/prospecting/b.pdf`;
    const storage = storageFalso([arquivo(A, { dias: 30 }), arquivo(B, { dias: 30 })]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [B], // a configuração atual aponta para B
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([A]);
    expect(storage.restante()).toEqual([B]);
    expect(r.removidos).toBe(1);
    expect(r.caminhos_removidos).toEqual([{ caminho: A, bytes: 1_000 }]);
    expect(r.preservados_por_referencia).toBe(1);
    expect(r.erro).toBeNull();
  });

  it("arquivo referenciado NUNCA some, por mais velho que seja", async () => {
    const referenciado = `${ORG}/prospecting/velho.pdf`;
    const storage = storageFalso([arquivo(referenciado, { dias: 3650 })]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [referenciado],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([]);
    expect(storage.restante()).toEqual([referenciado]);
    expect(r.removidos).toBe(0);
    expect(r.preservados_por_referencia).toBe(1);
  });

  it("arquivo de OUTRA organização não é tocado, mesmo aparecendo no list", async () => {
    const nosso = `${ORG}/prospecting/a.pdf`;
    const alheio = `${OUTRA_ORG}/prospecting/x.pdf`;
    // O falso devolve o alheio de propósito: a regra tem de recusar sozinha.
    const storage = storageFalso([arquivo(nosso, { dias: 30 }), arquivo(alheio, { dias: 30 })]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([nosso]);
    expect(storage.restante()).toContain(alheio);
    expect(r.preservados_fora_da_pasta).toBe(1);
  });

  it("arquivo dentro da carência não some (upload ainda sem configuração salva)", async () => {
    const recente = `${ORG}/prospecting/recente.pdf`;
    const storage = storageFalso([arquivo(recente, { dias: 1 })]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([]);
    expect(r.preservados_pela_carencia).toBe(1);
    expect(r.removidos).toBe(0);
  });

  it("sem idade conhecida no list, preserva — não dá para provar que está velho", async () => {
    const semIdade = `${ORG}/prospecting/sem-idade.pdf`;
    const storage = storageFalso([arquivo(semIdade, { semIdade: true })]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([]);
    expect(r.preservados_sem_idade).toBe(1);
  });

  it("a carência é uma constante declarada (7 dias) e é respeitada", async () => {
    expect(CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS).toBe(7);
    const naBorda = `${ORG}/prospecting/borda.pdf`;
    const logoAlem = `${ORG}/prospecting/alem.pdf`;
    const storage = storageFalso([
      arquivo(naBorda, { dias: CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS - 1 }),
      arquivo(logoAlem, { dias: CARENCIA_DOS_ARQUIVOS_ORFAOS_DIAS + 1 }),
    ]);

    await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(storage.removidos).toEqual([logoAlem]);
  });
});

describe("limparArquivosOrfaosDaAbordagem — falhas e trilha", () => {
  it("falha do list devolve erro e não remove nada", async () => {
    const storage: ClienteDeStorageDaAbordagem = {
      async list() {
        return { arquivos: [], erro: "storage fora" };
      },
      async remove() {
        throw new Error("não deveria remover");
      },
    };

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage,
      agora: AGORA,
    });

    expect(r.erro).toBe("storage fora");
    expect(r.removidos).toBe(0);
  });

  it("falha do remove devolve erro e contagens zeradas", async () => {
    const orfao = `${ORG}/prospecting/a.pdf`;
    const storage: ClienteDeStorageDaAbordagem = {
      async list() {
        return { arquivos: [arquivo(orfao, { dias: 30 })], erro: null };
      },
      async remove() {
        return { removidos: [], erro: "sem permissão" };
      },
    };

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage,
      agora: AGORA,
    });

    expect(r.erro).toBe("sem permissão");
    expect(r.removidos).toBe(0);
    expect(r.caminhos_removidos).toEqual([]);
  });

  it("registra caminho + bytes; bytes nulos quando o list não informa tamanho", async () => {
    const comTamanho = `${ORG}/prospecting/a.pdf`;
    const semTamanho = `${ORG}/prospecting/b.pdf`;
    const storage = storageFalso([
      arquivo(comTamanho, { dias: 30, bytes: 2_048 }),
      arquivo(semTamanho, { dias: 30, bytes: null }),
    ]);

    const r = await limparArquivosOrfaosDaAbordagem({
      organizationId: ORG,
      referenciados: [],
      storage: storage.cliente,
      agora: AGORA,
    });

    expect(r.removidos).toBe(2);
    expect(r.bytes_removidos).toBe(2_048);
    expect(r.caminhos_removidos).toEqual(
      expect.arrayContaining([
        { caminho: comTamanho, bytes: 2_048 },
        { caminho: semTamanho, bytes: null },
      ]),
    );
  });
});

describe("drenarArquivosOrfaosDaAbordagem — a instalação inteira", () => {
  it("varre cada organização com o SEU conjunto de referências", async () => {
    const daOrg = `${ORG}/prospecting/a.pdf`;
    const daOutra = `${OUTRA_ORG}/prospecting/b.pdf`;
    const storages = new Map<string, ReturnType<typeof storageFalso>>([
      [ORG, storageFalso([arquivo(daOrg, { dias: 30 })])],
      [OUTRA_ORG, storageFalso([arquivo(daOutra, { dias: 30 })])],
    ]);
    const referenciadosPorOrg = new Map<string, string[]>([
      [ORG, []],
      [OUTRA_ORG, [daOutra]], // a outra organização ainda usa o dela
    ]);
    const fonte: FonteDaProspeccao = {
      async organizacoes() {
        return [ORG, OUTRA_ORG];
      },
      async caminhosReferenciados(org) {
        return referenciadosPorOrg.get(org) ?? [];
      },
      storageDaAbordagem(org) {
        return storages.get(org)!.cliente;
      },
    };

    const r = await drenarArquivosOrfaosDaAbordagem(fonte, { agora: AGORA });

    expect(r.organizacoes).toBe(2);
    expect(r.removidos).toBe(1);
    expect(r.caminhos).toEqual([{ caminho: daOrg, bytes: 1_000 }]);
    expect(storages.get(ORG)!.restante()).toEqual([]);
    expect(storages.get(OUTRA_ORG)!.restante()).toEqual([daOutra]);
    expect(r.falhas).toEqual([]);
  });

  it("falha de uma organização vira linha nomeada e as outras SEGUEM", async () => {
    const daOrg = `${ORG}/prospecting/a.pdf`;
    const daOutra = `${OUTRA_ORG}/prospecting/b.pdf`;
    const storages = new Map<string, ReturnType<typeof storageFalso>>([
      [ORG, storageFalso([arquivo(daOrg, { dias: 30 })])],
      [OUTRA_ORG, storageFalso([arquivo(daOutra, { dias: 30 })])],
    ]);
    const fonte: FonteDaProspeccao = {
      async organizacoes() {
        return [ORG, OUTRA_ORG];
      },
      async caminhosReferenciados(org) {
        if (org === ORG) throw new Error("banco fora");
        return [];
      },
      storageDaAbordagem(org) {
        return storages.get(org)!.cliente;
      },
    };

    const r = await drenarArquivosOrfaosDaAbordagem(fonte, { agora: AGORA });

    expect(r.falhas).toHaveLength(1);
    expect(r.falhas[0]).toContain(ORG);
    expect(r.falhas[0]).toContain("banco fora");
    // A segunda organização rodou mesmo com a primeira quebrada.
    expect(r.removidos).toBe(1);
    expect(storages.get(OUTRA_ORG)!.restante()).toEqual([]);
  });
});
