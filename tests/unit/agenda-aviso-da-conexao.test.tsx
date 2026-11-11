/**
 * O TRADUTOR DO RETORNO DO GOOGLE — e o silêncio que ele existe para acabar.
 *
 * Todo desfecho do OAuth do Google (o sucesso e as dez falhas) termina com um
 * redirect para `/app/agenda?erro=<código>` ou `?ok=agenda_conectada`. Os
 * sítios de escrita se medem assim:
 *
 *     grep -rn 'voltar("erro=\|voltarComErro("' app/api/v1/agenda/google/
 *
 * `AvisoDaConexaoGoogle` é o único leitor desse contrato no repositório, e até
 * este arquivo tinha **zero** testes:
 *
 *     grep -rln "AvisoDaConexaoGoogle\|aviso-conexao-google" tests/   # zero
 *
 * O defeito que a cerca fecha é o da metade escrita: se o mapa `DESFECHOS`
 * perder uma chave, ganhar uma frase em jargão, ou parar de desenhar a faixa,
 * a pessoa clica em "conectar", alguma coisa falha, o navegador volta para a
 * Agenda — e a tela desenha a grade de sempre, sem uma palavra. Ela conclui
 * que o clique não fez nada e tenta outra vez, no mesmo caminho quebrado.
 * Nada no produto reprova esse silêncio, porque ele é a AUSÊNCIA de um
 * elemento: não quebra build, não quebra tipo, não quebra rota.
 *
 * Por isso as três propriedades cobradas aqui são de PRODUTO, não de forma:
 * todo desfecho fala; toda faixa que fica diz o próximo passo; nenhuma frase
 * culpa quem está usando nem despeja identificador de máquina na tela de quem
 * não programa.
 *
 * Roda com: npx vitest run tests/unit/agenda-aviso-da-conexao.test.tsx
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace, urlDaTela, toastFalso } = vi.hoisted(() => ({
  replace: vi.fn(),
  urlDaTela: { query: "" },
  toastFalso: Object.assign(vi.fn(), { success: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(urlDaTela.query),
}));
// O componente importa `sonner` por `import()` dentro do efeito; o dublê
// precisa ser função E ter `.success`, porque os dois formatos são usados.
vi.mock("sonner", () => ({ toast: toastFalso }));

import {
  AvisoDaConexaoGoogle,
  CODIGOS_CONHECIDOS,
} from "@/app/app/agenda/_components/AvisoDaConexaoGoogle";

/** Mock de módulo acumula chamada entre casos; limpar ANTES de configurar. */
beforeEach(() => {
  vi.clearAllMocks();
  urlDaTela.query = "";
});
afterEach(cleanup);

function abrirAgendaCom(query: string) {
  urlDaTela.query = query;
  return render(<AvisoDaConexaoGoogle />);
}

type Faixa = { texto: string; acao: string; ofereceReconectar: boolean };

/** Renderiza um desfecho, lê a faixa (se houver) e desmonta. */
function faixaDe(query: string): Faixa | null {
  const { unmount } = abrirAgendaCom(query);
  const elemento = screen.queryByTestId("aviso-conexao-google");
  const lido: Faixa | null = elemento
    ? {
        texto: elemento.textContent ?? "",
        acao: elemento.getAttribute("data-acao") ?? "",
        ofereceReconectar: screen.queryByTestId("reconectar") !== null,
      }
    : null;
  unmount();
  return lido;
}

function avisouPorToast(): boolean {
  return toastFalso.mock.calls.length + toastFalso.success.mock.calls.length > 0;
}

describe("aviso da conexão do Google — a sonda enxerga", () => {
  it("um código conhecido desenha faixa com texto de verdade", () => {
    // CONTROLE DE VACUIDADE. Sem este caso, toda asserção de ausência abaixo
    // ficaria verde também com o componente devolvendo `null` sempre — zero
    // achados seria indistinguível de instrumento morto.
    abrirAgendaCom("erro=permissao_incompleta");
    const faixa = screen.getByTestId("aviso-conexao-google");
    expect(
      faixa.textContent ?? "",
      "a faixa existe mas sai vazia: a pessoa vê um retângulo colorido sem " +
        "frase e continua sem saber por que a agenda não conectou",
    ).toMatch(/permiss/i);
    expect((faixa.textContent ?? "").length).toBeGreaterThan(60);
    expect(
      screen.getByRole("alert"),
      "sem role=alert quem usa leitor de tela não é avisado do que falhou",
    ).toBeTruthy();
  });

  it("sem parâmetro nenhum: nada na tela, e a URL não é reescrita", () => {
    // O PAR do caso acima. Uma faixa cravada como sempre-visível passaria lá e
    // reprovaria aqui — e a Agenda de todo dia abriria com um alarme falso.
    abrirAgendaCom("");
    expect(screen.queryByTestId("aviso-conexao-google")).toBeNull();
    expect(
      replace,
      "reescrever a URL de quem só abriu a Agenda joga uma navegação " +
        "no histórico a cada visita, sem nada para limpar",
    ).not.toHaveBeenCalled();
  });
});

describe("aviso da conexão do Google — todo desfecho fala", () => {
  it("nenhum código conhecido passa em silêncio", async () => {
    // Não é `it.each` de propósito: o interesse é o CONJUNTO. Se um dia
    // `DESFECHOS` ganhar chave sem frase, é aqui que aparece.
    expect(
      CODIGOS_CONHECIDOS.length,
      "a lista de códigos veio vazia — a varredura perdeu o export e todo " +
        "caso abaixo passaria sem exercitar nada",
    ).toBeGreaterThan(5);

    for (const codigo of CODIGOS_CONHECIDOS) {
      vi.clearAllMocks();
      const { unmount } = abrirAgendaCom(`erro=${codigo}`);
      const temFaixa = screen.queryByTestId("aviso-conexao-google") !== null;
      if (!temFaixa) {
        await waitFor(
          () =>
            expect(
              avisouPorToast(),
              `o desfecho «${codigo}» volta para a Agenda sem faixa e sem aviso ` +
                `passageiro: a pessoa vê a tela de sempre e conclui que o clique ` +
                `em conectar não fez nada`,
            ).toBe(true),
          // O aviso passageiro chega por `import()` dinâmico. O padrão de 1s do
          // `waitFor` cronometra a lentidão da máquina como se fosse asserção:
          // medido aqui, este arquivo já levou 49s num caso sob máquina
          // carregada. Silêncio de verdade continua reprovando, 5s depois.
          { timeout: 5_000 },
        );
      }
      unmount();
    }
  });

  it("toda faixa que FICA na tela diz o próximo passo", () => {
    const faixas = CODIGOS_CONHECIDOS.map((codigo) => [codigo, faixaDe(`erro=${codigo}`)] as const)
      .filter((par): par is readonly [string, Faixa] => par[1] !== null);

    expect(
      faixas.length,
      "nenhum código desenhou faixa: ou o componente parou de desenhar, ou a " +
        "varredura deixou de encontrá-la — nos dois casos as asserções abaixo " +
        "não mediram nada",
    ).toBeGreaterThan(0);

    for (const [codigo, faixa] of faixas) {
      expect(
        faixa.acao,
        `«${codigo}» ocupa o topo da Agenda sem dizer o que fazer: quem lê ` +
          `fecha o aviso, não conecta a agenda, e o compromisso marcado aqui ` +
          `nunca chega ao Google`,
      ).not.toBe("nenhuma");
    }
  });
});

describe("aviso da conexão do Google — a frase é para quem não programa", () => {
  // A lista abaixo é dos termos que JÁ apareceram em telas desta casa (o
  // precedente da Nuvemshop diz "code ausente", "access token", "Verifique
  // NUVEMSHOP_OAUTH_ENCRYPTION_KEY"). Ela prova a ausência DESSES termos, não a
  // ausência de toda acusação possível — julgar tom não se automatiza.
  const VOCABULARIO_QUE_CULPA = [
    /\bvocê (errou|falhou|esqueceu|não deveria)/i,
    /\bculpa\b/i,
    /\binválid[oa]/i,
    /\bincorret[oa]/i,
    /\bnão autorizad/i,
  ];

  it("nenhuma faixa despeja identificador de máquina na tela", () => {
    const faixas = CODIGOS_CONHECIDOS.map((codigo) => [codigo, faixaDe(`erro=${codigo}`)] as const)
      .filter((par): par is readonly [string, Faixa] => par[1] !== null);
    expect(faixas.length, "varredura vazia: nada foi inspecionado").toBeGreaterThan(0);

    for (const [codigo, faixa] of faixas) {
      // Um único padrão pega os dois vazamentos possíveis, porque os dois têm a
      // mesma forma: `GOOGLE_CALENDAR_CLIENT_ID` (nome de variável de ambiente)
      // e `retorno_nao_verificavel` (o código cru da query).
      expect(
        faixa.texto,
        `«${codigo}» mostra nome de variável ou o código cru para o dono da ` +
          `clínica: ele não tem como agir sobre isso e a frase vira prova de ` +
          `que o sistema quebrou, não de que alguém cuida dele`,
      ).not.toMatch(/[A-Za-z0-9]_[A-Za-z0-9]/);
    }
  });

  it("nenhuma faixa culpa quem está usando", () => {
    const faixas = CODIGOS_CONHECIDOS.map((codigo) => [codigo, faixaDe(`erro=${codigo}`)] as const)
      .filter((par): par is readonly [string, Faixa] => par[1] !== null);
    expect(faixas.length, "varredura vazia: nada foi inspecionado").toBeGreaterThan(0);

    for (const [codigo, faixa] of faixas) {
      for (const acusacao of VOCABULARIO_QUE_CULPA) {
        expect(
          faixa.texto,
          `«${codigo}» acusa quem apenas clicou num botão; quem instalou o ` +
            `sistema é que precisa agir, e a pessoa passa a evitar o recurso`,
        ).not.toMatch(acusacao);
      }
    }
  });
});

describe("aviso da conexão do Google — cada desfecho no seu formato", () => {
  it("sucesso sai em aviso passageiro, não em faixa que precisa ser fechada", async () => {
    abrirAgendaCom("ok=agenda_conectada");
    expect(
      screen.queryByTestId("aviso-conexao-google"),
      "quem conectou com sucesso não tem nada a fazer; uma faixa fixa faria a " +
        "pessoa procurar um problema que não existe",
    ).toBeNull();
    await waitFor(() => expect(toastFalso.success).toHaveBeenCalled(), { timeout: 5_000 });
    expect(String(toastFalso.success.mock.calls[0]?.[0])).toMatch(/conectada/i);
  });

  it("um `ok` que a tela não conhece continua sendo sucesso, nunca erro", async () => {
    // O ramo `ok ? agenda_conectada : DESCONHECIDO`. Cair no genérico de falha
    // diria "não consegui conectar" para quem acabou de conectar.
    //
    // A asserção é sobre o TEXTO, não sobre o canal: medido aqui, este caminho
    // usa `toast(...)` neutro em vez de `toast.success(...)`, porque o efeito
    // decide pelo valor cru da query (`chave === "agenda_conectada"`) e não pelo
    // desfecho que `lerDesfecho` já resolveu. Está reportado; prender o canal
    // aqui congelaria a discrepância como se fosse o contrato.
    abrirAgendaCom("ok=1");
    expect(
      screen.queryByTestId("aviso-conexao-google"),
      "um `ok` desconhecido caindo na faixa de falha diria 'não consegui " +
        "conectar' para quem acabou de conectar",
    ).toBeNull();
    await waitFor(() => expect(avisouPorToast()).toBe(true), { timeout: 5_000 });
    const primeiroTitulo = String(
      toastFalso.success.mock.calls[0]?.[0] ?? toastFalso.mock.calls[0]?.[0],
    );
    expect(primeiroTitulo).toMatch(/conectada/i);
  });

  it("cancelar na tela do Google não é tratado como falha", async () => {
    abrirAgendaCom("erro=conexao_cancelada");
    expect(screen.queryByTestId("aviso-conexao-google")).toBeNull();
    await waitFor(() => expect(toastFalso).toHaveBeenCalled(), { timeout: 5_000 });
    expect(
      toastFalso.success,
      "dizer 'algo deu errado' a quem só mudou de ideia ensina a pessoa a " +
        "desconfiar dos avisos que, nas outras vezes, são verdadeiros",
    ).not.toHaveBeenCalled();
    expect(String(toastFalso.mock.calls[0]?.[0])).toMatch(/cancelou/i);
  });

  it("problema da INSTALAÇÃO não oferece um botão que não resolveria nada", () => {
    abrirAgendaCom("erro=google_nao_configurado");
    const faixa = screen.getByTestId("aviso-conexao-google");
    expect(faixa.getAttribute("data-acao")).toBe("falar_com_quem_instalou");
    expect(
      screen.queryByTestId("reconectar"),
      "oferecer 'conectar de novo' onde falta credencial da instalação põe a " +
        "pessoa num laço: cada clique volta ao mesmo aviso",
    ).toBeNull();
    expect(
      faixa.textContent ?? "",
      "sem dizer que não foi ela, a pessoa tenta consertar o que não está ao " +
        "alcance dela",
    ).toMatch(/não é nada que você tenha feito/i);
  });

  it("problema transitório oferece reconectar — o outro lado do par", () => {
    abrirAgendaCom("erro=retorno_nao_verificavel");
    const faixa = screen.getByTestId("aviso-conexao-google");
    expect(faixa.getAttribute("data-acao")).toBe("reconectar");
    expect(screen.getByTestId("reconectar").textContent).toMatch(/conectar de novo/i);
  });

  it("faltar permissão diz o que fazer na tela do Google, não só que faltou", () => {
    abrirAgendaCom("erro=permissao_incompleta");
    expect(
      screen.getByTestId("aviso-conexao-google").textContent ?? "",
      "sem dizer para manter as caixas marcadas, a segunda tentativa repete a " +
        "primeira e a agenda nunca sincroniza",
    ).toMatch(/marcad/i);
  });
});

describe("aviso da conexão do Google — código que a tela não conhece", () => {
  // `segredo_indisponivel` é escrito HOJE por
  // app/api/v1/agenda/google/connect/route.ts e não está em `DESFECHOS`; serve
  // aqui como fixture real do caminho de fallback.
  const DESCONHECIDO = "segredo_indisponivel";

  it("não desenha caixa vazia nem mostra o código cru", () => {
    abrirAgendaCom(`erro=${DESCONHECIDO}`);
    const faixa = screen.getByTestId("aviso-conexao-google");
    const texto = faixa.textContent ?? "";
    expect(
      texto.length,
      "faixa sem frase é pior que faixa nenhuma: a pessoa vê que algo falhou e " +
        "não recebe uma palavra sobre o quê",
    ).toBeGreaterThan(60);
    expect(
      texto,
      "mostrar o código da query é exatamente o defeito que este componente " +
        "existe para consertar",
    ).not.toContain(DESCONHECIDO);
    expect(faixa.getAttribute("data-acao")).not.toBe("nenhuma");
  });

  it("diz que o resto da agenda continua funcionando", () => {
    abrirAgendaCom(`erro=${DESCONHECIDO}`);
    expect(
      screen.getByTestId("aviso-conexao-google").textContent ?? "",
      "sem essa frase, um aviso vermelho no topo faz a pessoa parar de usar a " +
        "agenda inteira por causa de uma integração que ela nem tinha ainda",
    ).toMatch(/continua funcionando/i);
  });
});

describe("aviso da conexão do Google — a URL não repete o aviso", () => {
  it("o parâmetro é limpo depois de tratado", async () => {
    abrirAgendaCom("erro=retorno_incompleto");
    await waitFor(() =>
      expect(
        replace,
        "com o parâmetro na URL, um F5 (ou o voltar do navegador) ressuscita o " +
          "aviso de uma falha que já passou, e a pessoa acha que falhou de novo",
      ).toHaveBeenCalledWith("/app/agenda"),
    );
  });

  it("...e a faixa NÃO some quando a URL é limpa", () => {
    // O que o `useState` inicializador protege — e que só se mede encenando o
    // que o `router.replace` faz DE VERDADE: a query some e o Next re-renderiza.
    // O dublê de `replace` é só um espião; quem apaga o parâmetro aqui são as
    // duas linhas abaixo. Sem elas, uma faixa derivada da query a cada render
    // passa neste caso e some na tela da pessoa — medido: com a faixa derivada
    // dos params, os 19 casos ficavam verdes.
    const { rerender } = abrirAgendaCom("erro=retorno_incompleto");
    expect(screen.getByTestId("aviso-conexao-google")).toBeTruthy();

    urlDaTela.query = "";
    rerender(<AvisoDaConexaoGoogle />);

    expect(
      screen.queryByTestId("aviso-conexao-google"),
      "a faixa nasce e morre no mesmo ciclo: o próprio efeito apaga a query " +
        "que a alimenta, o aviso pisca, e a pessoa volta para a Agenda sem " +
        "saber que a conexão falhou",
    ).not.toBeNull();
  });

  it("fechar o aviso tira a faixa da tela", () => {
    abrirAgendaCom("erro=nao_consegui_guardar");
    fireEvent.click(screen.getByTestId("fechar-aviso-google"));
    expect(
      screen.queryByTestId("aviso-conexao-google"),
      "aviso que não fecha ocupa o topo da Agenda em toda visita até a pessoa " +
        "descobrir que precisa recarregar",
    ).toBeNull();
  });
});

describe("aviso da conexão do Google — o contrato com quem ESCREVE o código", () => {
  /**
   * As rotas de OAuth e esta tela são as duas pontas de um contrato de texto.
   * Nada no compilador liga uma à outra: acrescentar `erro=x` numa rota e
   * esquecer a frase aqui compila, passa no lint e chega ao cliente como o
   * genérico — que manda "tentar de novo" mesmo quando tentar de novo não pode
   * dar certo.
   *
   * A dívida abaixo está CONGELADA de propósito: os dois códigos já existem nas
   * rotas hoje e não foram consertados nesta cerca (estão reportados). O gate
   * não nasce vermelho, e qualquer código NOVO reprova.
   */
  const ROTAS = [
    "app/api/v1/agenda/google/callback/route.ts",
    "app/api/v1/agenda/google/connect/route.ts",
  ];
  const DIVIDA_CONGELADA = new Set(["sem_token_de_renovacao", "segredo_indisponivel"]);

  function codigosEscritosPelasRotas(): string[] {
    const achados = new Set<string>();
    for (const rota of ROTAS) {
      const fonte = readFileSync(resolve(process.cwd(), rota), "utf-8");
      // #4107: a rota passou a carimbar o X-Request-Id e as saídas ganharam o
      // segundo argumento — `voltar("erro=x", req)`. A varredura segue a FORMA
      // atual (aceita o argumento opcional) para continuar enxergando os códigos;
      // o controle de vacuidade abaixo é quem garante que ela não ficou cega.
      for (const [, codigo] of fonte.matchAll(/voltar\("erro=([a-z_]+)"(?:,\s*[A-Za-z_$]+)?\)/g)) achados.add(codigo!);
      for (const [, codigo] of fonte.matchAll(/voltarComErro\("([a-z_]+)"(?:,\s*[A-Za-z_$]+)?\)/g)) achados.add(codigo!);
    }
    return [...achados];
  }

  it("a varredura das rotas enxerga os códigos escritos lá", () => {
    // CONTROLE DE VACUIDADE do gate abaixo: se as rotas mudarem a FORMA de
    // escrever o redirect, a varredura devolve vazio e o gate ficaria verde sem
    // ter lido uma linha.
    const escritos = codigosEscritosPelasRotas();
    expect(escritos).toContain("permissao_incompleta");
    expect(escritos).toContain("google_nao_configurado");
    expect(
      escritos.length,
      "a varredura perdeu o rastro dos redirects; o gate seguinte deixaria " +
        "passar qualquer código novo sem frase",
    ).toBeGreaterThan(8);
  });

  it("todo código escrito pelas rotas tem frase nesta tela", () => {
    const semFrase = codigosEscritosPelasRotas().filter(
      (codigo) => !CODIGOS_CONHECIDOS.includes(codigo) && !DIVIDA_CONGELADA.has(codigo),
    );
    expect(
      semFrase,
      `estas rotas mandam a pessoa de volta com um código que a tela não sabe ` +
        `traduzir (${semFrase.join(", ")}): ela recebe o texto genérico "tentar ` +
        `de novo costuma resolver", que em falha de instalação é um laço — cada ` +
        `tentativa termina no mesmo aviso`,
    ).toEqual([]);
  });
});
