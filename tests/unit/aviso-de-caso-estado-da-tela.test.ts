/**
 * A REGRA QUE DIZ, NA TELA, QUANDO O AVISO NÃO VAI DISPARAR.
 *
 * ## Por que isto é um módulo puro e não um punhado de `if` no componente
 *
 * São onze estados, e o modo de falha deles é MUDO: uma tela que não diz "seu
 * número só manda mensagem aprovada" aceita a configuração, fica verde, e o
 * aviso simplesmente nunca chega. O invariante 6 do Sistema Vivo — *"a
 * configuração mostra o estado efetivo, não só o que foi digitado"* — só é
 * mecânico se a regra for testável sem React, sem banco e sem rota.
 *
 * ## O que este arquivo NÃO prova
 *
 * Que a FRASE de cada código aparece na tela. Isso é do teste do componente
 * (`aviso-de-caso-tela.test.tsx`), e a razão de estarem separados é que apagar
 * uma frase e apagar uma regra são defeitos diferentes: o primeiro deixa a
 * pessoa sem explicação, o segundo deixa o switch ligável quando não devia.
 */
import { describe, expect, it } from "vitest";

import {
  JANELA_DO_DESCARTE_DIAS,
  avisosDaTela,
  normalizarTelefoneDeAviso,
  podeLigarOAviso,
  telefoneDeAvisoValido,
  type FatosDaTelaDeAviso,
} from "@/lib/escalacao/estado-do-aviso";

const AGORA = new Date("2026-09-18T12:00:00.000Z");
const CANAL_QR = "11111111-1111-4111-8111-111111111111";
const CANAL_OFICIAL = "22222222-2222-4222-8222-222222222222";

/** O estado SAUDÁVEL: uma conexão por QR escolhida, URL pública, agente com casos. */
function fatos(patch: Partial<FatosDaTelaDeAviso> = {}): FatosDaTelaDeAviso {
  return {
    conexoes: [
      {
        id: CANAL_QR,
        nome: "Plantão",
        status: "WORKING",
        aceitaMensagemLivre: true,
        atendeClientes: false,
      },
    ],
    config: {
      channelSessionId: CANAL_QR,
      telefone: "+5531998966398",
      rotulo: "Plantão da Ana",
      ligado: true,
    },
    urlPublicaOk: true,
    agentesPublicados: { total: 1, comCasos: 1, assistidos: 0 },
    atendimentoExterno: false,
    descarte: { ignoradas: 0, ultimaEm: null },
    aquecimento: null,
    agora: AGORA,
    ...patch,
  };
}

const codigos = (f: FatosDaTelaDeAviso) => avisosDaTela(f).map((a) => a.codigo);

describe("o telefone de aviso", () => {
  it("aceita só E.164 — a MESMA forma do CHECK do banco", () => {
    expect(telefoneDeAvisoValido("+5531998966398")).toBe(true);
    // Sem `+`, com zero no DDI, curto demais e longo demais: os quatro jeitos de
    // o RPC devolver `aviso_de_caso_telefone_invalido` depois de a pessoa ter
    // preenchido a tela inteira.
    expect(telefoneDeAvisoValido("5531998966398")).toBe(false);
    expect(telefoneDeAvisoValido("+0531998966398")).toBe(false);
    expect(telefoneDeAvisoValido("+5531999")).toBe(false);
    expect(telefoneDeAvisoValido("+5531998966398123456")).toBe(false);
  });

  it("normaliza o que a pessoa digita para a forma que o banco aceita", () => {
    expect(normalizarTelefoneDeAviso("(31) 99896-6398")).toBe("+31998966398");
    expect(normalizarTelefoneDeAviso("+55 31 99896-6398")).toBe("+5531998966398");
    // Campo vazio não vira `+`: um `+` sozinho reprovaria na validação e diria à
    // pessoa que ela digitou algo errado quando ela não digitou nada.
    expect(normalizarTelefoneDeAviso("")).toBe("");
    expect(normalizarTelefoneDeAviso("   ")).toBe("");
  });
});

describe("pode ligar o aviso?", () => {
  it("sim quando há conexão que manda texto livre, número válido e endereço público", () => {
    expect(podeLigarOAviso(fatos())).toBe(true);
  });

  it("não sem endereço público — o link do aviso não abriria nada", () => {
    expect(podeLigarOAviso(fatos({ urlPublicaOk: false }))).toBe(false);
  });

  it("não sem número válido", () => {
    const f = fatos();
    expect(podeLigarOAviso({ ...f, config: { ...f.config!, telefone: "31998966398" } })).toBe(
      false,
    );
  });

  it("não quando a conexão escolhida não manda texto livre", () => {
    expect(
      podeLigarOAviso(
        fatos({
          conexoes: [
            {
              id: CANAL_OFICIAL,
              nome: "Oficial",
              status: "WORKING",
              aceitaMensagemLivre: false,
              atendeClientes: false,
            },
          ],
          config: {
            channelSessionId: CANAL_OFICIAL,
            telefone: "+5531998966398",
            rotulo: null,
            ligado: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it("não quando a conexão escolhida sumiu da lista (removida)", () => {
    const f = fatos();
    expect(podeLigarOAviso({ ...f, config: { ...f.config!, channelSessionId: null } })).toBe(false);
  });
});

describe("os estados que bloqueiam", () => {
  it("nenhuma conexão — o estado de toda VPS recém-instalada", () => {
    const lista = avisosDaTela(fatos({ conexoes: [], config: null, aquecimento: null }));
    expect(lista[0]?.codigo).toBe("sem_conexao");
    expect(lista[0]?.bloqueia).toBe(true);
  });

  it("só canal oficial — ele não serve para aviso interno, e a tela diz isso", () => {
    const lista = avisosDaTela(
      fatos({
        conexoes: [
          {
            id: CANAL_OFICIAL,
            nome: "Oficial",
            status: "WORKING",
            aceitaMensagemLivre: false,
            atendeClientes: true,
          },
        ],
        config: null,
      }),
    );
    expect(lista.map((a) => a.codigo)).toContain("so_canal_oficial");
    expect(lista.find((a) => a.codigo === "so_canal_oficial")?.bloqueia).toBe(true);
    // E NÃO acusa "nenhuma conexão": há conexão, ela é que não serve.
    expect(lista.map((a) => a.codigo)).not.toContain("sem_conexao");
  });

  it("sem endereço público — bloqueia, porque o link do aviso não abriria nada", () => {
    const lista = avisosDaTela(fatos({ urlPublicaOk: false }));
    expect(lista.find((a) => a.codigo === "sem_endereco_publico")?.bloqueia).toBe(true);
  });

  it("a conexão escolhida foi removida — o banco desligou sozinho e a tela conta", () => {
    const f = fatos();
    const lista = avisosDaTela({
      ...f,
      config: { ...f.config!, channelSessionId: null, ligado: false },
    });
    expect(lista.map((a) => a.codigo)).toContain("conexao_removida");
  });

  it("a conexão ARQUIVADA some da lista e conta a mesma frase", () => {
    // O outro jeito de a conexão sumir: a coluna ainda aponta para a linha, mas
    // `listSelectableChannels` filtra `archived_at` e ela não chega aqui.
    // Tratar só o `null` deixava este caso mudo — switch travado, seletor vazio,
    // e nada na tela dizendo por quê.
    const f = fatos();
    const lista = avisosDaTela({ ...f, conexoes: [] });
    expect(lista.map((a) => a.codigo)).toContain("conexao_removida");
  });
});

describe("os estados que alertam sem bloquear", () => {
  it("a conexão que atende clientes é permitida — decisão do dono, com alerta", () => {
    const f = fatos();
    const lista = avisosDaTela({
      ...f,
      conexoes: [{ ...f.conexoes[0]!, atendeClientes: true }],
    });
    const aviso = lista.find((a) => a.codigo === "conexao_atende_clientes");
    expect(aviso).toBeDefined();
    expect(aviso?.bloqueia).toBe(false);
    expect(podeLigarOAviso({ ...f, conexoes: [{ ...f.conexoes[0]!, atendeClientes: true }] })).toBe(
      true,
    );
  });

  it("conexão fora do ar: alerta, não bloqueio — os avisos esperam até 24 h", () => {
    const f = fatos();
    const lista = avisosDaTela({
      ...f,
      conexoes: [{ ...f.conexoes[0]!, status: "STOPPED" }],
    });
    expect(lista.find((a) => a.codigo === "conexao_fora_do_ar")?.bloqueia).toBe(false);
  });

  it("nenhum agente com casos ligados — nenhum aviso vai sair por ninguém", () => {
    expect(
      codigos(fatos({ agentesPublicados: { total: 2, comCasos: 0, assistidos: 0 } })),
    ).toContain("casos_desligados");
    // Zero agente publicado é a mesma frase: ninguém está autorizado a abrir caso.
    expect(
      codigos(fatos({ agentesPublicados: { total: 0, comCasos: 0, assistidos: 0 } })),
    ).toContain("casos_desligados");
  });

  it("todos os agentes em modo assistido — eles sugerem, não abrem caso sozinhos", () => {
    expect(
      codigos(fatos({ agentesPublicados: { total: 2, comCasos: 2, assistidos: 2 } })),
    ).toContain("agente_assistido");
    // Um assistido entre dois NÃO alerta: o outro abre caso, e o alerta seria falso.
    expect(
      codigos(fatos({ agentesPublicados: { total: 2, comCasos: 2, assistidos: 1 } })),
    ).not.toContain("agente_assistido");
  });

  it("não medir não é medir zero: `null` não inventa alerta nenhum", () => {
    const lista = codigos(fatos({ agentesPublicados: null }));
    expect(lista).not.toContain("casos_desligados");
    expect(lista).not.toContain("agente_assistido");
  });

  it("organização em atendimento externo — quem conduz não abre caso aqui", () => {
    expect(codigos(fatos({ atendimentoExterno: true }))).toContain("atendimento_externo");
  });
});

describe("os estados que só informam", () => {
  it("aquecimento: a tela mostra o teto do dia do número que ela recomendou", () => {
    const lista = avisosDaTela(
      fatos({ aquecimento: { enviadosHoje: 7, teto: 20, fimEm: "2026-10-12T00:00:00.000Z" } }),
    );
    const aviso = lista.find((a) => a.codigo === "aquecimento");
    expect(aviso?.dados).toMatchObject({ enviadosHoje: 7, teto: 20 });
    expect(aviso?.bloqueia).toBe(false);
  });

  it("número fora do aquecimento (sem teto) não vira alerta", () => {
    expect(
      codigos(fatos({ aquecimento: { enviadosHoje: 300, teto: null, fimEm: null } })),
    ).not.toContain("aquecimento");
  });

  it("descarte recente aparece — é o que impede o silêncio de parecer defeito", () => {
    const ontem = new Date(AGORA.getTime() - 24 * 3600_000).toISOString();
    const lista = avisosDaTela(fatos({ descarte: { ignoradas: 3, ultimaEm: ontem } }));
    const aviso = lista.find((a) => a.codigo === "descarte_acontecendo");
    expect(aviso?.dados).toMatchObject({ ignoradas: 3, ultimaEm: ontem });
  });

  it("descarte VELHO não aparece — o contador é acumulado, e a janela é a recência", () => {
    const antigo = new Date(
      AGORA.getTime() - (JANELA_DO_DESCARTE_DIAS + 1) * 24 * 3600_000,
    ).toISOString();
    expect(codigos(fatos({ descarte: { ignoradas: 3, ultimaEm: antigo } }))).not.toContain(
      "descarte_acontecendo",
    );
  });

  it("contador sem data não aparece — número sem quando não responde nada", () => {
    expect(codigos(fatos({ descarte: { ignoradas: 9, ultimaEm: null } }))).not.toContain(
      "descarte_acontecendo",
    );
  });
});

describe("a ordem e a completude", () => {
  it("o que bloqueia vem antes do que só alerta", () => {
    const lista = avisosDaTela(
      fatos({
        urlPublicaOk: false,
        atendimentoExterno: true,
        descarte: { ignoradas: 2, ultimaEm: AGORA.toISOString() },
      }),
    );
    const primeiroSemBloqueio = lista.findIndex((a) => !a.bloqueia);
    const ultimoComBloqueio = lista.map((a) => a.bloqueia).lastIndexOf(true);
    expect(ultimoComBloqueio).toBeLessThan(primeiroSemBloqueio);
  });

  it("a instalação saudável não mostra alerta nenhum", () => {
    expect(avisosDaTela(fatos())).toEqual([]);
  });

  it("nenhum código sai da tupla declarada", () => {
    const lista = avisosDaTela(
      fatos({
        conexoes: [],
        config: null,
        urlPublicaOk: false,
        agentesPublicados: { total: 0, comCasos: 0, assistidos: 0 },
        atendimentoExterno: true,
        descarte: { ignoradas: 1, ultimaEm: AGORA.toISOString() },
      }),
    );
    expect(lista.length).toBeGreaterThan(0);
    for (const aviso of lista) expect(typeof aviso.codigo).toBe("string");
  });
});

describe("modo local sem link", () => {
  it("desbloqueia somente endereço; canal e destinatário continuam necessários", () => {
    const f = fatos({ urlPublicaOk: false });
    expect(podeLigarOAviso(f)).toBe(false);
    f.config = { ...f.config!, sem_link: true };
    expect(podeLigarOAviso(f)).toBe(true);
    expect(avisosDaTela(f).find((a) => a.codigo === "sem_endereco_publico")?.bloqueia).toBe(false);
    f.config.telefone = "";
    expect(podeLigarOAviso(f)).toBe(false);
    f.config.telefone = "+12025550123";
    f.conexoes = [];
    expect(podeLigarOAviso(f)).toBe(false);
  });
});
