import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O IDIOMA DA INTERFACE — a escolha que não mudava nada.
 *
 * ─── O que existia ─────────────────────────────────────────────────────────
 *
 * Um seletor no perfil, salvo em `user_metadata.locale`, que NINGUÉM lia.
 * Medido: nenhuma biblioteca de i18n, nenhuma pasta de tradução, nenhum
 * consumidor do campo. Escolher "English (US)" não mudava uma letra.
 *
 * É a mesma classe do rodapé que mostra uma versão que não é a que roda: o
 * operador configura, nada acontece, e ele conclui que o sistema está quebrado.
 *
 * ─── O que estes casos prendem ─────────────────────────────────────────────
 *
 * Que faltar tradução DEGRADE para português em vez de mostrar a chave; que a
 * lista de idiomas oferecida seja a mesma que o dicionário serve; e que só
 * apareça no seletor idioma que realmente muda a tela.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, IDIOMA_PADRAO, normalizarIdioma } from "@/lib/i18n/idiomas";
import { NAV_DESTINATIONS, NAV_GROUPS } from "@/lib/navigation/registry";
import { DICIONARIO } from "@/lib/i18n/dicionario";

describe("traduzir", () => {
  it("devolve o espanhol quando existe", () => {
    expect(traduzir("Assumir", "es")).toBe("Asumir");
    expect(traduzir("Contatos", "es")).toBe("Contactos");
  });

  it("em português devolve a própria chave — ela É o texto", () => {
    expect(traduzir("Assumir", "pt-BR")).toBe("Assumir");
  });

  it("sem tradução DEGRADA para português, não para a chave", () => {
    // A tradução é parcial de propósito. Um texto ainda não traduzido tem de
    // aparecer legível — nunca `inbox.claim`, nunca vazio.
    expect(traduzir("Um texto que ninguém traduziu ainda", "es")).toBe(
      "Um texto que ninguém traduziu ainda",
    );
  });

  it("nunca devolve vazio", () => {
    // Uma tradução parcial não pode deixar a tela PIOR do que estava.
    for (const texto of ["Assumir", "qualquer coisa", "…"]) {
      for (const idioma of IDIOMAS) {
        expect(traduzir(texto, idioma).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("normalizar o idioma que veio do perfil", () => {
  it("aceita os que sabemos servir", () => {
    expect(normalizarIdioma("es")).toBe("es");
    expect(normalizarIdioma("pt-BR")).toBe("pt-BR");
  });

  it("fecha no padrão para o que não conhece", () => {
    // `en-US` esteve no seletor por muito tempo e nunca teve tradução. Um
    // perfil antigo ainda o traz, e deixá-lo passar mostraria a CHAVE na tela.
    expect(normalizarIdioma("en-US")).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma("klingon")).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma(null)).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma(undefined)).toBe(IDIOMA_PADRAO);
  });
});

describe("os elos que somem sem barulho", () => {
  it("o idioma CHEGA ao cliente, e por contexto PRÓPRIO", () => {
    // Buscá-lo numa consulta própria faria a tela aparecer em português e
    // trocar meio segundo depois, em toda navegação — pior que não traduzir.
    expect(readFileSync("lib/auth/types.ts", "utf8")).toMatch(/locale\?: string \| null/);
    expect(readFileSync("lib/auth/server.ts", "utf8")).toMatch(
      /user\.user_metadata\?\.locale as string \| undefined/,
    );
    // E a CADEIA: preferência da pessoa → idioma da ORGANIZAÇÃO → padrão.
    //
    // O elo do meio é o que costuma sumir: `organizations.locale` tinha
    // seletor na tela, era gravado no banco e não era lido por NINGUÉM —
    // medido por varredura, as únicas referências eram a escrita e a releitura
    // para preencher o próprio formulário. Sem este caso, ele volta a ser
    // decorativo no dia em que alguém "simplificar" o resolvedor.
    const servidor = readFileSync("lib/auth/server.ts", "utf8");
    expect(servidor, "a membership deixou de trazer o idioma da organização").toMatch(
      /organizations\(display_name, locale\)/,
    );
    expect(servidor, "o idioma da sessão parou de cair na organização").toMatch(
      /locale \?\? \(await localeDaOrgAtiva\(memberships\)\)/,
    );
    expect(readFileSync("lib/auth/types.ts", "utf8")).toMatch(/idioma: Idioma/);
    // E o provider de idioma é SEPARADO do de autenticação. A primeira versão
    // lia o idioma do `AuthProvider` e derrubou 32 casos: dezenas de testes
    // fazem `vi.mock` daquele módulo, e um RÓTULO passou a depender de quem
    // sabe permissão. Traduzir é apresentação.
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(layout).toMatch(/<IdiomaProvider locale=\{user\.idioma\}>/);
    // O IMPORT, não a palavra: o cabeçalho do arquivo EXPLICA por que não
    // depende da autenticação, e a primeira versão deste caso ficava vermelha
    // por causa do próprio comentário que documenta a decisão.
    expect(
      readFileSync("lib/i18n/IdiomaProvider.tsx", "utf8"),
      "o provider de idioma voltou a depender da autenticação",
    ).not.toMatch(/^import .*auth/m);
  });

  it("a validação do perfil usa a MESMA lista do dicionário", () => {
    // Duas listas divergem: um idioma aceito no salvamento e desconhecido no
    // dicionário cairia no padrão em silêncio, e o operador veria português
    // depois de escolher espanhol.
    expect(readFileSync("lib/schemas/settings.ts", "utf8")).toMatch(/const LOCALES = IDIOMAS;/);
  });

  it("o seletor oferece só o que MUDA a tela", () => {
    // `en-US` saiu: nunca teve tradução. Oferecer um idioma que não muda nada é
    // prometer o que a tela não cumpre.
    const perfil = readFileSync("app/app/settings/profile/_form.tsx", "utf8");
    expect(perfil).toMatch(/value="es">Español/);
    expect(perfil, "ainda oferece um idioma sem tradução").not.toMatch(/value="en-US"/);
  });

  it("a barra lateral traduz — ela aparece em TODA tela", () => {
    // Sem ela, escolher espanhol não mudaria nada visível no primeiro clique, e
    // o operador concluiria que a opção segue sendo decorativa.
    const fonte = readFileSync("components/shell/Sidebar.tsx", "utf8");
    expect(fonte).toMatch(/const t = useT\(\);/);
    expect(fonte).toMatch(/\{t\(item\.label\)\}/);
  });

  it("o inbox traduz o que se usa o dia inteiro", () => {
    for (const arquivo of [
      "components/inbox/ConversationHeader.tsx",
      "components/inbox/Composer.tsx",
      "components/inbox/InboxFilters.tsx",
    ]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/const t = useT\(\);/);
    }
  });
});

describe("o dicionário acompanha o registro de navegação", () => {
  it("todo item da barra lateral tem tradução", () => {
    // ⚠️ ESTE CRUZAMENTO NÃO EXISTIA, e a falta dele é do tipo que não
    // vermelheia: a CHAVE do dicionário é o próprio texto em português, então
    // renomear um rótulo no registro não quebra nada — `traduzir()` devolve a
    // chave ausente como português e o espanhol daquele item some da barra
    // lateral sem aviso. Foi o risco real ao renomear "Kanban"→"Funis" e
    // "Funis"→"Etapas do funil" nesta rodada.
    // Nome próprio não se traduz: cair para o português É o comportamento
    // certo para eles. A lista é curta de propósito — cada entrada aqui é uma
    // renúncia consciente, não um lugar para esconder rótulo esquecido.
    const NOMES_PROPRIOS = ["Nuvemshop"];
    const semTraducao = NAV_DESTINATIONS.filter((d) => d.sidebar)
      .filter((d) => !NOMES_PROPRIOS.includes(d.label))
      .filter((d) => !(d.label in DICIONARIO));
    expect(
      semTraducao.map((d) => d.label),
      "item de menu sem entrada em lib/i18n/dicionario.ts — o espanhol dele cai para o português",
    ).toEqual([]);
  });

  it("todo grupo da barra lateral tem tradução", () => {
    const semTraducao = NAV_GROUPS.filter((g) => !(g.label in DICIONARIO));
    expect(semTraducao.map((g) => g.label)).toEqual([]);
  });
});
