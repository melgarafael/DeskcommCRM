/**
 * A MARCA NAS SAÍDAS SEM DOM — `lib/branding/saida.ts`.
 *
 * O que este arquivo guarda, e por quê:
 *
 *  1. O CONTRATO "nunca lança". É o único gate que existe para ele: nenhum
 *     e-mail deste produto tem teste de integração, e a falha real (banco fora
 *     do ar durante um envio de LGPD) não acontece em nenhuma suíte. Sem este
 *     caso, tirar o `try/catch` passaria em typecheck, lint e nos 4369 testes.
 *  2. O PISO importado, e não redigitado. A asserção compara com a régua
 *     (`REGUA_DO_PRODUTO`), nunca com o literal `#506d48` — um teste que
 *     escrevesse o hex à mão criaria a QUINTA cópia dele e passaria a verde no
 *     dia em que o produto mudasse de cor.
 *  3. O TEMA CLARO. E-mail não tem tema, e um `escuro` trocado por engano
 *     produziria um botão que ninguém enxerga contra o fundo branco do Gmail.
 *
 * O `createAdminClient` é mockado por arquivo (é a fronteira de I/O), mas as
 * asserções são sobre a DECISÃO — cor, frente, nome, origem —, nunca sobre a
 * query montada. Mock do transporte prova que a query saiu; nunca que a regra
 * está certa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { stop } from "@/lib/branding/rampa";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

/** O que a leitura de `organizations` vai devolver no caso corrente. */
let respostaDaOrganizacao: { data: unknown; error: unknown } = { data: null, error: null };
/** Quando ligado, `createAdminClient()` explode — a simulação do banco fora. */
let clienteExplode = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (clienteExplode) throw new Error("conexão recusada");
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => respostaDaOrganizacao,
          }),
        }),
      }),
    };
  },
}));

/**
 * `marcaDaInstalacao` é memoizada por 30s em módulo. Sem este mock, o primeiro
 * caso do arquivo gravaria a resposta dele no memo e os seguintes mediriam a
 * fixture do vizinho — o modo de falha clássico de suíte com estado de módulo.
 */
let linhaDaInstalacao: {
  app_name?: string | null;
  logo_url?: string | null;
  accent_hex?: string | null;
} | null = null;

vi.mock("@/lib/branding/instalacao", () => ({
  marcaDaInstalacao: async () => linhaDaInstalacao,
}));

/** A régua manda: nada de literal. Grau 600 do tema claro do produto. */
const ACCENT_DO_PRODUTO = stop(
  REGUA_DO_PRODUTO.rampaDoProduto,
  REGUA_DO_PRODUTO.claro.indices.accent,
);

async function carregar() {
  vi.resetModules();
  return import("@/lib/branding/saida");
}

beforeEach(() => {
  respostaDaOrganizacao = { data: null, error: null };
  clienteExplode = false;
  linhaDaInstalacao = null;
  // A marca do OPERADOR nao pode decidir o resultado destes testes: eles
  // afirmam o piso DO PRODUTO. O mock acima cobre `marcaDaInstalacao`, mas
  // `lib/branding/resolve.ts` tambem le `APP_NAME`/`APP_ACCENT_HEX` do `.env`
  // — e numa instalacao white-label essas chaves vem PREENCHIDAS, que e o caso
  // normal deste repo (docs/white-label.md). Sem os stubs abaixo, quem troca a
  // marca pelo caminho documentado herda tres testes vermelhos que nao tem
  // relacao nenhuma com a mudanca dele.
  //
  // Vazio e nao `delete`: chave declarada e vazia e exatamente o estado que o
  // `install.sh` grava quando o operador aperta Enter, e `resolve.ts` ja o
  // trata como "ninguem configurou". Stubar com o valor real do caminho real
  // prova o piso sem inventar um terceiro estado.
  vi.stubEnv("APP_NAME", "");
  vi.stubEnv("APP_ACCENT_HEX", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("marcaDaSaida — o piso", () => {
  it("sem marca em lugar nenhum, devolve o accent DO PRODUTO, lido da régua", async () => {
    const { marcaDaSaida } = await carregar();
    const marca = await marcaDaSaida(null);

    expect(marca.accent).toBe(ACCENT_DO_PRODUTO);
    expect(marca.origens.cor).toBe("padrao");
  });

  it("o piso é o grau que a régua declara como accent claro, não um hex escrito aqui", async () => {
    // Controle positivo do item 2 do cabeçalho: se alguém trocar o índice em
    // `saida.ts` por outro grau, a igualdade abaixo continua valendo pelo lado
    // errado — por isso a asserção seguinte prende o ÍNDICE, que é a decisão.
    expect(REGUA_DO_PRODUTO.claro.indices.accent).toBe(6);
    expect(ACCENT_DO_PRODUTO).toBe(REGUA_DO_PRODUTO.rampaDoProduto[6]);
  });

  it("a frente do accent é CALCULADA, nunca branco fixo", async () => {
    const { marcaDaSaida } = await carregar();
    // Amarelo é o caso que o `#ffffff` fixo estragava: texto branco sobre
    // amarelo é ilegível, e é justamente a cor que um cliente cola sem avisar.
    linhaDaInstalacao = { accent_hex: "#f5c518" };

    const marca = await marcaDaSaida(null);
    expect(marca.accentFg).toBe(melhorFrenteSobre(marca.accent));
    expect(["#000000", "#ffffff"]).toContain(marca.accentFg);
  });
});

describe("marcaDaSaida — as duas classes", () => {
  it("classe B (sem organização) resolve a marca da INSTALAÇÃO", async () => {
    const { marcaDaSaida } = await carregar();
    linhaDaInstalacao = { app_name: "Vendas Turbo", accent_hex: "#2563eb" };

    const marca = await marcaDaSaida(null);
    expect(marca.nome).toBe("Vendas Turbo");
    expect(marca.origens.nome).toBe("banco");
    expect(marca.accent).not.toBe(ACCENT_DO_PRODUTO);
  });

  it("classe A (com organização) põe a marca da ORGANIZAÇÃO acima da instalação", async () => {
    const { marcaDaSaida } = await carregar();
    linhaDaInstalacao = { app_name: "Vendas Turbo", accent_hex: "#2563eb" };
    respostaDaOrganizacao = {
      data: { settings: { branding: { app_name: "Clínica Bem Viver" } } },
      error: null,
    };

    const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
    // Precedência POR CAMPO: a organização definiu só o nome, então a COR
    // continua sendo a do revendedor. Um resolvedor que trocasse a camada
    // inteira apagaria a cor de quem só quis trocar o nome.
    expect(marca.nome).toBe("Clínica Bem Viver");
    expect(marca.origens.nome).toBe("organizacao");
    expect(marca.origens.cor).toBe("banco");
  });

  it("organização sem marca própria herda a do revendedor, sem virar padrão", async () => {
    const { marcaDaSaida } = await carregar();
    linhaDaInstalacao = { app_name: "Vendas Turbo" };
    respostaDaOrganizacao = { data: { settings: {} }, error: null };

    const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
    expect(marca.nome).toBe("Vendas Turbo");
  });
});

describe("marcaDaSaida — o tema é CLARO, sempre", () => {
  it("devolve o accent do tema claro, não o do escuro", async () => {
    const { marcaDaSaida } = await carregar();
    const semente = "#2563eb";
    linhaDaInstalacao = { accent_hex: semente };

    const marca = await marcaDaSaida(null);

    // Os dois temas escolhem graus diferentes da MESMA rampa (6 no claro, 4 no
    // escuro), então trocar um pelo outro é observável — e é a única forma de
    // este caso reprovar de verdade.
    const { derivarMarca } = await import("@/lib/branding/contraste");
    const derivada = derivarMarca(semente, REGUA_DO_PRODUTO);
    expect(marca.accent).toBe(derivada.claro.accent);
    expect(marca.accent).not.toBe(derivada.escuro.accent);
  });
});

describe("marcaDaSaida — NUNCA LANÇA", () => {
  // Este bloco é o contrato inteiro. Um e-mail de LGPD tem SLA legal de D+7:
  // falhar o envio porque a LEITURA DA COR deu erro troca um problema estético
  // por um descumprimento de prazo.

  it("banco fora do ar não derruba a saída — degrada para o padrão do produto", async () => {
    const { marcaDaSaida } = await carregar();
    clienteExplode = true;

    const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
    expect(marca.nome).toBe("DeskcommCRM");
    expect(marca.accent).toBe(ACCENT_DO_PRODUTO);
    expect(marca.accentFg).toBe(melhorFrenteSobre(ACCENT_DO_PRODUTO));
  });

  it("erro do PostgREST na leitura da organização não lança, e a marca de cima vale", async () => {
    const { marcaDaSaida } = await carregar();
    linhaDaInstalacao = { app_name: "Vendas Turbo" };
    respostaDaOrganizacao = { data: null, error: { code: "42P01", message: "relation missing" } };

    const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
    // Falha na camada de CIMA não apaga a de baixo: a marca do revendedor
    // continua valendo, que é o desfecho certo para o cliente dele.
    expect(marca.nome).toBe("Vendas Turbo");
  });

  it("jsonb corrompido em settings não lança", async () => {
    const { marcaDaSaida } = await carregar();
    // `settings` é jsonb livre: escrita manual, versão futura e migração pela
    // metade produzem qualquer uma destas formas.
    for (const settings of ["texto", 42, [], { branding: "isto era um objeto" }, null]) {
      respostaDaOrganizacao = { data: { settings }, error: null };
      const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
      expect(marca.nome).toBe("DeskcommCRM");
    }
  });

  it("hex inválido gravado no banco não lança, e a cor cai para a do produto", async () => {
    const { marcaDaSaida } = await carregar();
    respostaDaOrganizacao = {
      data: { settings: { branding: { app_name: "Acme", accent_hex: "azul-piscina" } } },
      error: null,
    };

    const marca = await marcaDaSaida("11111111-1111-4111-8111-111111111111");
    // Falhar fechado na AÇÃO (não pintar com lixo) e aberto na INFORMAÇÃO: o
    // nome, que é válido, continua valendo.
    expect(marca.nome).toBe("Acme");
    expect(marca.accent).toBe(ACCENT_DO_PRODUTO);
    expect(marca.origens.cor).toBe("padrao");
  });
});

describe("emailDeSuporte", () => {
  it("vazio quando ninguém configurou — para a tela não mostrar endereço nenhum", async () => {
    const original = process.env.SUPPORT_EMAIL;
    delete process.env.SUPPORT_EMAIL;
    const { emailDeSuporte } = await carregar();
    expect(emailDeSuporte()).toBe("");
    if (original !== undefined) process.env.SUPPORT_EMAIL = original;
  });

  it("devolve o endereço do operador, sem espaço em volta", async () => {
    const original = process.env.SUPPORT_EMAIL;
    process.env.SUPPORT_EMAIL = "  ajuda@revenda.com.br  ";
    const { emailDeSuporte } = await carregar();
    expect(emailDeSuporte()).toBe("ajuda@revenda.com.br");
    if (original === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = original;
  });
});
