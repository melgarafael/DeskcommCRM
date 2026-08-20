import { describe, expect, it } from "vitest";

import { derivarMarca } from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import {
  camadaDoAmbiente,
  resolverMarca,
  type CamadaDeMarca,
} from "@/lib/branding/resolve";
import {
  ALGORITMO_ATUAL,
  envelopeDeSemente,
  esquemaDaCorDaMarca,
  FORMATO_ATUAL,
} from "@/lib/branding/schema";

const REGUA = REGUA_DO_PRODUTO;

/** Envelope da versão de hoje, com os campos que o teste quiser trocar. */
const envelope = (patch: Record<string, unknown> = {}) => ({
  ...envelopeDeSemente("#2563eb"),
  ...patch,
});

const codigos = (m: { motivos: readonly { codigo: string }[] }) =>
  m.motivos.map((x) => x.codigo);

describe("envelope — a forma do que se grava", () => {
  it("guarda ENTRADA e nunca saída", () => {
    // O teste que impede o retrofit impossível: se algum dia alguém gravar os
    // 11 stops derivados, uma correção no gerador de contraste deixa de alcançar
    // quem já configurou — e não há como saber, depois, que a linha está velha.
    expect(Object.keys(envelopeDeSemente("#2563eb")).sort()).toEqual([
      "algo",
      "format",
      "papel_da_semente",
      "semente_hex",
    ]);
  });

  it("normaliza o hex ao montar", () => {
    expect(envelopeDeSemente("#ABC").semente_hex).toBe("#aabbcc");
    expect(envelopeDeSemente("  #2563EB  ").semente_hex).toBe("#2563eb");
  });

  it("não lança ao montar a partir de lixo — quem recusa é o resolvedor", () => {
    // `normalizarHex` LANÇA de propósito (rampa.ts), e esta função roda no
    // caminho de render do layout. Montar tem de ser total.
    expect(() => envelopeDeSemente("nao-e-hex")).not.toThrow();
    expect(envelopeDeSemente("nao-e-hex").semente_hex).toBe("nao-e-hex");
  });

  it("aceita chave desconhecida em vez de lançar (o `.catchall`)", () => {
    // ESTE É O TESTE DO ROLLBACK. O `update.sh` aplica o baseline ANTES de puxar
    // a imagem e o `agent.sh` reverte só o APP_IMAGE: código velho sobre schema
    // novo é o estado NORMAL de um rollback, não a exceção. Com `.strict()` o
    // parse lançaria, e como o resolvedor é chamado no app/layout.tsx isso é 500
    // em todas as telas do produto.
    const lido = esquemaDaCorDaMarca.safeParse(
      envelope({ campo_do_futuro: { qualquer: "coisa" } }),
    );
    expect(lido.success).toBe(true);
  });
});

describe("resolvedor — nunca lança", () => {
  const hostis: unknown[] = [
    undefined,
    null,
    "",
    "#2563eb",
    0,
    [],
    {},
    { format: 1 },
    { format: "1", algo: 1, semente_hex: "#2563eb" },
    { format: 1, algo: 1, semente_hex: 42 },
    { format: 1, algo: 1, semente_hex: "javascript:alert(1)" },
    { format: 1, algo: 1, semente_hex: "#2563eb", papel_da_semente: 7 },
    { format: -1, algo: 0, semente_hex: "#2563eb" },
    { format: 1.5, algo: 1, semente_hex: "#2563eb" },
    { format: 99, algo: 99, semente_hex: "#2563eb", extra: [1, 2, 3] },
  ];

  it.each(hostis.map((v, i) => [i, v] as const))(
    "entrada hostil #%i devolve marca válida em vez de exceção",
    (_i, cor) => {
      const marca = resolverMarca([{ origem: "teste", cor }], REGUA);
      expect(typeof marca.name).toBe("string");
      expect(marca.name.length).toBeGreaterThan(0);
    },
  );

  it("uma semente que não é hex vira motivo, não exceção", () => {
    const marca = resolverMarca([{ origem: "teste", cor: envelope({ semente_hex: "roxo" }) }], REGUA);
    expect(marca.cor).toBeNull();
    expect(codigos(marca)).toEqual(["semente_invalida"]);
  });

  it("distingue semente inválida de envelope malformado", () => {
    // Os dois casos batem no MESMO caminho (`semente_hex`) e precisam sair com
    // códigos diferentes: "o operador digitou uma cor errada" manda olhar o
    // valor; "falta campo / tipo errado" manda olhar a gravação. Trocá-los faz o
    // operador procurar no lugar errado.
    const semCampo = resolverMarca(
      [{ origem: "teste", cor: { algo: 1, semente_hex: "#2563eb" } }],
      REGUA,
    );
    expect(codigos(semCampo)).toEqual(["envelope_malformado"]);
    expect(semCampo.motivos[0]?.detalhe).toContain("format");

    const ausente = resolverMarca([{ origem: "teste", cor: { format: 1, algo: 1 } }], REGUA);
    expect(codigos(ausente)).toEqual(["envelope_malformado"]);
    expect(ausente.motivos[0]?.detalhe).toContain("semente_hex");

    const tipoErrado = resolverMarca(
      [{ origem: "teste", cor: envelope({ semente_hex: 42 }) }],
      REGUA,
    );
    expect(codigos(tipoErrado)).toEqual(["envelope_malformado"]);

    const corErrada = resolverMarca(
      [{ origem: "teste", cor: envelope({ semente_hex: "#zzz" }) }],
      REGUA,
    );
    expect(codigos(corErrada)).toEqual(["semente_invalida"]);
  });
});

describe("skew de versão — código de hoje sobre dado de amanhã", () => {
  it("`algo` desconhecido continua pintando, porque o que se grava é ENTRADA", () => {
    // O caso do rollback, escrito como o `update.sh` o produz: a versão nova
    // gravou com outro gerador e um campo que esta versão não conhece.
    const cor = {
      format: FORMATO_ATUAL,
      algo: 99,
      semente_hex: "#2563eb",
      papel_da_semente: "accent",
      contraste_alvo: { texto: 4.5 },
    };
    const marca = resolverMarca([{ origem: "futuro", cor }], REGUA);

    // `not.toBeNull()` num optional chaining passa com `undefined` — asserção
    // que não distingue "derivou" de "nem chegou lá". Aqui o valor é concreto.
    expect(marca.cor?.derivada?.origemDaRampa).toBe("semente");
    expect(marca.cor?.semente).toBe("#2563eb");
    expect(marca.cor?.derivada?.rampa).toHaveLength(11);
    expect(codigos(marca)).toContain("algoritmo_desconhecido");
    // Derivou com o algoritmo DESTA versão — é isso que faz uma correção de
    // contraste alcançar quem configurou antes dela existir.
    expect(marca.motivos.find((m) => m.codigo === "algoritmo_desconhecido")?.detalhe).toContain(
      String(ALGORITMO_ATUAL),
    );
  });

  it("`format` desconhecido cai no padrão do produto, sem lançar", () => {
    // `format` governa o significado dos campos: ler `semente_hex` de um formato
    // que não se conhece é adivinhar, e pintar o produto inteiro com o palpite é
    // pior que não pintar.
    const marca = resolverMarca([{ origem: "futuro", cor: envelope({ format: 99 }) }], REGUA);
    expect(marca.cor).toBeNull();
    expect(codigos(marca)).toEqual(["formato_desconhecido"]);
  });

  it("papel desconhecido não pinta, mas mantém a identidade", () => {
    const marca = resolverMarca(
      [{ origem: "futuro", cor: envelope({ papel_da_semente: "so_no_email" }) }],
      REGUA,
    );
    expect(marca.cor?.derivada).toBeNull();
    expect(marca.cor?.semente).toBe("#2563eb");
    expect(codigos(marca)).toEqual(["papel_desconhecido"]);
  });

  it("papel `marca` é identidade sem pintar a interface", () => {
    const marca = resolverMarca(
      [{ origem: "env", cor: envelopeDeSemente("#2563eb", "marca") }],
      REGUA,
    );
    expect(marca.cor?.derivada).toBeNull();
    expect(codigos(marca)).toEqual(["papel_nao_pinta"]);
  });
});

describe("precedência POR CAMPO", () => {
  const organizacao: CamadaDeMarca = {
    origem: "organizacao",
    logoUrl: "https://cdn.exemplo.com/org.svg",
  };
  const ambiente: CamadaDeMarca = camadaDoAmbiente({
    APP_NAME: "Revenda XPTO",
    APP_LOGO_URL: "https://cdn.exemplo.com/revenda.svg",
    APP_ACCENT_HEX: "#2563eb",
  });

  it("quem define só o logo mantém o nome da camada de baixo", () => {
    const marca = resolverMarca([organizacao, ambiente], REGUA);
    expect(marca.logoUrl).toBe("https://cdn.exemplo.com/org.svg");
    expect(marca.name).toBe("Revenda XPTO");
    expect(marca.origens).toEqual({ nome: "env", logoUrl: "organizacao", cor: "env" });
  });

  it("campo vazio não conta como definido", () => {
    // `install.sh` grava a chave declarada e vazia quando o operador não
    // responde. Tratar "" como definido apagaria a marca da camada de baixo.
    const vazia: CamadaDeMarca = { origem: "organizacao", nome: "   ", logoUrl: "" };
    const marca = resolverMarca([vazia, ambiente], REGUA);
    expect(marca.name).toBe("Revenda XPTO");
    expect(marca.origens.logoUrl).toBe("env");
  });

  it("cor quebrada em cima cai na cor válida de baixo, não na do produto", () => {
    // Numa instalação de revendedor, uma organização que grava lixo tem de cair
    // na marca do revendedor — cair na NOSSA seria trocar o dono da tela.
    const quebrada: CamadaDeMarca = { origem: "organizacao", cor: { format: 1 } };
    const marca = resolverMarca([quebrada, ambiente], REGUA);
    expect(marca.origens.cor).toBe("env");
    expect(marca.cor?.semente).toBe("#2563eb");
    expect(codigos(marca)).toContain("envelope_malformado");
  });

  it("sem nenhuma camada, tudo é o padrão do produto", () => {
    const marca = resolverMarca([], REGUA);
    expect(marca.name).toBe("CarlosCostaPrev – Sistema Integrado de Gestão");
    expect(marca.cor).toBeNull();
    expect(marca.origens).toEqual({ nome: "padrao", logoUrl: "padrao", cor: "padrao" });
    expect(marca.motivos).toEqual([]);
  });
});

describe("camada do .env", () => {
  it("instalação de fábrica não produz motivo nenhum", () => {
    // Avisar sobre o caso NORMAL é como um log deixa de ser lido. Chave ausente
    // e chave declarada-e-vazia são os dois estados de fábrica.
    for (const fonte of [{}, { APP_ACCENT_HEX: "" }, { APP_ACCENT_HEX: "   " }]) {
      const marca = resolverMarca([camadaDoAmbiente(fonte)], REGUA);
      expect(marca.cor).toBeNull();
      expect(marca.motivos).toEqual([]);
    }
  });

  it("campo presente e vazio numa camada que fala de cor VIRA motivo", () => {
    // Diferente do caso acima: aqui a camada declarou `cor` e mandou nada — é
    // anomalia de dado (jsonb `{}`), não instalação de fábrica.
    const marca = resolverMarca([{ origem: "organizacao", cor: {} }], REGUA);
    expect(codigos(marca)).toEqual(["cor_ausente"]);
  });

  it("um hex no .env vira envelope da versão de hoje", () => {
    const camada = camadaDoAmbiente({ APP_ACCENT_HEX: "#F5C518" });
    expect(camada.cor).toEqual({
      format: FORMATO_ATUAL,
      algo: ALGORITMO_ATUAL,
      semente_hex: "#f5c518",
      papel_da_semente: "accent",
    });
  });
});

describe("diagnóstico não vaza identidade", () => {
  it("nenhum motivo carrega o hex da marca", () => {
    // Mesma disciplina de `contraste.ts`: com a tabela por organização, esses
    // motivos passam a conviver num log só, e a cor de uma empresa não tem por
    // que aparecer no diagnóstico de outra.
    const sementes = ["#f5c518", "#808080", "#0f172a", "#dc2626"];
    for (const hex of sementes) {
      const marca = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: hex })], REGUA);
      expect(marca.motivos.length).toBeGreaterThan(0);
      for (const m of marca.motivos) {
        expect(`${m.detalhe} ${m.alvo ?? ""}`).not.toContain(hex);
      }
    }
  });
});

describe("memoização da derivação", () => {
  it("duas resoluções da mesma semente reusam o mesmo objeto derivado", () => {
    // Guarda de vacuidade do cache: sem ele, o layout refaz até 21 deslocamentos
    // × todos os pares × 2 temas em CADA requisição, para um valor que muda uma
    // vez por deploy.
    const a = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: "#14b8a6" })], REGUA);
    const b = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: "#14b8a6" })], REGUA);
    expect(a.cor?.derivada).toBe(b.cor?.derivada);
  });

  it("réguas diferentes não compartilham cache", () => {
    // Cachear só pelo hex devolveria a marca derivada de uma régua ao chamador
    // de outra — e o preview da fase seguinte usa réguas distintas de propósito.
    const outra = { ...REGUA, claro: { ...REGUA.claro } };
    const a = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: "#4b0082" })], REGUA);
    const b = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: "#4b0082" })], outra);
    expect(a.cor?.derivada).not.toBe(b.cor?.derivada);
    expect(a.cor?.derivada).toEqual(b.cor?.derivada);
  });

  it("o cache devolve o mesmo que a derivação direta (não uma cópia velha)", () => {
    const direto = derivarMarca("#7c3aed", REGUA);
    const pelaCamada = resolverMarca(
      [camadaDoAmbiente({ APP_ACCENT_HEX: "#7c3aed" })],
      REGUA,
    );
    expect(pelaCamada.cor?.derivada).toEqual(direto);
  });
});
