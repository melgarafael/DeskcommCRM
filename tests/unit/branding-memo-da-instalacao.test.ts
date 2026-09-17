/**
 * O MEMO DA MARCA DA INSTALAÇÃO É DO PROCESSO — NÃO DA INSTÂNCIA DO MÓDULO.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO VIGIA ═══
 *
 * `invalidarMarcaDaInstalacao()` é o contrato entre quem GRAVA a marca e quem a
 * RENDERIZA: sem ela, a troca só apareceria quando o TTL de 30s expirasse. O
 * contrato estava quebrado para um dos dois escritores, e de um jeito invisível.
 *
 * MEDIDO no build de produção deste repo (Next 16.3, Turbopack):
 *
 *   .next/server/app/api/v1/marca/logo/route.js
 *     → require("chunks/[turbopack]_runtime.js")      → chunks/lib_0oox3fh._.js     (id 545718)
 *   .next/server/app/admin/(protected)/marca/page.js
 *     → require("chunks/ssr/[turbopack]_runtime.js")  → chunks/ssr/lib_14h72ih._.js (id 301182)
 *
 * Dois arquivos de runtime, cada um com o seu `const moduleCache =
 * Object.create(null)` e nenhum registro global: `lib/branding/instalacao.ts`
 * vive DUAS vezes no mesmo processo. Com o memo num `let` de módulo, a rota de
 * upload zerava uma cópia que nenhuma tela lê — e o sintoma era
 * `tests/e2e/marca-logo.spec.ts` (1) reprovando com "element(s) not found" na
 * prévia do logo, com 5s e depois com 15s de espera, DEPOIS de o toast "Logo
 * atualizado." já ter aparecido.
 *
 * ═══ POR QUE ESTE ARQUIVO USA MOCK, SE O VIZINHO DIZ QUE MOCK NÃO PROVA NADA ═══
 *
 * `branding-instalacao.test.ts` recusa mock de propósito: lá o que se testa é
 * REGRA (semear, recusar, resolver), e mock do transporte prova só que a query
 * foi montada. Aqui o objeto de teste é outro — é o CICLO DE VIDA do memo, que
 * só é observável pela contagem de idas ao banco e pelo que a leitura devolve
 * depois de alguém escrever. Sem uma fronteira de I/O observável, a propriedade
 * não existe para ser medida.
 *
 * ═══ POR QUE `vi.resetModules()` REPRODUZ O DEFEITO DE VERDADE ═══
 *
 * Ele dá exatamente o que o Turbopack dá: uma SEGUNDA instância do mesmo arquivo
 * no MESMO processo, com o estado de módulo zerado e a mesma `globalThis`. Um
 * teste que importasse o módulo uma vez só passaria verde com o defeito de pé —
 * é o caso confundido que acerta por sorte.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O estado do banco falso vive no escopo IÇADO, não no fábrica do mock: o
 * `vi.resetModules()` reexecuta a fábrica a cada importação, e um contador
 * declarado lá dentro zeraria justamente na hora em que estamos medindo.
 */
const banco = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  leituras: 0,
  /**
   * Portão para segurar UMA leitura em voo. `null` = leitura resolve na hora
   * (comportamento de todos os casos que já existiam aqui). Com o portão
   * armado, `maybeSingle` espera — e é isso que torna a corrida do
   * lost-update observável sem `sleep` e sem depender de timing.
   */
  portao: null as { liberar: () => void; esperar: Promise<void> } | null,
  /**
   * O banco que NÃO FALOU. `null` = leitura normal (todos os casos que já
   * existiam aqui). Com um código armado, `maybeSingle` devolve `error` e
   * `lerLinha` passa a responder "erro" — é a terceira saída da leitura, e é
   * ela que o caso da falha pós-escrita mede.
   */
  erro: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            banco.leituras += 1;
            // A linha é capturada AGORA, antes de esperar o portão — é o que um
            // banco real faz: a consulta sai antes da escrita, e a resposta que
            // volta é a de antes dela. Ler `banco.linha` depois do `await` faria
            // a leitura "em voo" enxergar o valor NOVO e o caso não reproduziria
            // corrida nenhuma (foi o primeiro jeito que escrevi, e a asserção de
            // controle o pegou).
            const capturada = banco.linha;
            if (banco.portao) await banco.portao.esperar;
            if (banco.erro) return { data: null, error: banco.erro };
            return { data: capturada, error: null };
          },
        }),
      }),
    }),
  }),
}));

/**
 * `seeded_from_env: false` não é detalhe: é o que faz `precisaSemear` devolver
 * "nao" e mantém este arquivo medindo o MEMO, e não a semeadura do `.env` (que
 * tem cobertura própria em `branding-instalacao.test.ts`).
 */
const SEM_LOGO = {
  app_name: "Revenda XPTO",
  logo_url: null,
  logo_path: null,
  accent_hex: null,
  show_powered_by: true,
  seeded_from_env: false,
  fallback_at: null,
  fallback_reason: null,
};

const CAMINHO_SUBIDO = "platform/6f1c2a90-7d3e-4a11-9b8c-0d2e4f6a8b10.png";
const COM_LOGO = { ...SEM_LOGO, logo_path: CAMINHO_SUBIDO };

/** Uma instância NOVA do módulo — o que o bundler cria para cada runtime. */
async function instancia() {
  vi.resetModules();
  return import("@/lib/branding/instalacao");
}

describe("o memo da marca da instalação atravessa instâncias do módulo", () => {
  beforeEach(async () => {
    banco.linha = SEM_LOGO;
    banco.leituras = 0;
    // Zera pela PORTA DO PRODUTO, não apagando a chave do `globalThis` na mão:
    // um teste que conhece o nome interno do memo continuaria "limpando" nada no
    // dia em que ele fosse renomeado, e a suíte ficaria verde sem isolamento.
    (await instancia()).invalidarMarcaDaInstalacao();
  });

  it("a invalidação feita pela instância da ROTA alcança a instância da TELA", async () => {
    const tela = await instancia();
    const rota = await instancia();
    expect(
      tela,
      "controle: sem duas instâncias distintas este teste não reproduz nada",
    ).not.toBe(rota);

    // 1. A tela renderizou uma vez — o memo guardou a linha SEM logo.
    expect((await tela.marcaDaInstalacao())?.logo_path).toBeNull();

    // 2. A rota gravou o arquivo e invalidou, que é o que ela faz hoje
    //    (`app/api/v1/marca/logo/route.ts`, dentro de `gravarCaminho`).
    banco.linha = COM_LOGO;
    rota.invalidarMarcaDaInstalacao();

    // 3. O render seguinte (o `router.refresh()` do campo de logo) TEM de ver o
    //    arquivo. É esta linha que fica vermelha com o memo preso ao módulo.
    expect((await tela.marcaDaInstalacao())?.logo_path).toBe(CAMINHO_SUBIDO);
  });

  it("e no sentido inverso — quem grava pela tela é visto por quem monta o e-mail", async () => {
    // Não é simetria decorativa: `lib/branding/saida.ts` (remetente e ícone do
    // e-mail) chama `marcaDaInstalacao()` e é compilada no runtime das ROTAS,
    // enquanto `updateBranding.ts` grava no runtime das TELAS. Este é o par
    // oposto do caso acima, e a mesma propriedade o cobre.
    const tela = await instancia();
    const rota = await instancia();

    expect((await rota.marcaDaInstalacao())?.logo_path).toBeNull();
    banco.linha = COM_LOGO;
    tela.invalidarMarcaDaInstalacao();
    expect((await rota.marcaDaInstalacao())?.logo_path).toBe(CAMINHO_SUBIDO);
  });

  it("duas instâncias, UMA ida ao banco — o memo é do processo também na leitura", async () => {
    const tela = await instancia();
    const rota = await instancia();
    await tela.marcaDaInstalacao();
    await rota.marcaDaInstalacao();
    expect(banco.leituras, "cada instância manteve o próprio cache").toBe(1);
  });

  it("CONTROLE: sem invalidação o memo continua servindo a linha velha", async () => {
    // Sem este caso, os três acima passariam verdes com o cache simplesmente
    // REMOVIDO — e aí a tela pagaria uma consulta por render sem ninguém notar.
    const tela = await instancia();
    expect((await tela.marcaDaInstalacao())?.logo_path).toBeNull();
    banco.linha = COM_LOGO;
    expect((await tela.marcaDaInstalacao())?.logo_path).toBeNull();
    expect(banco.leituras, "o memo deixou de ser memo").toBe(1);
  });
});

/**
 * ═══ LOST-UPDATE: a leitura EM VOO reinstalava o valor pré-escrita ═══
 *
 * Zerar o memo não bastava. `marcaDaInstalacao()` lia a geração do banco DEPOIS
 * de um `await`, e gravava o resultado INCONDICIONALMENTE — então uma leitura
 * que tinha começado ANTES da escrita voltava com a linha velha e a reinstalava
 * por um TTL inteiro (30s), desfazendo o `invalidarMarcaDaInstalacao()` da rota.
 *
 * O efeito para gente real: o dono da VPS sobe o logo, recebe 200 e um toast
 * verde, e a tela continua dizendo "Sem logo próprio" por até 30 segundos.
 *
 * MEDIDO no trace do CI em 2026-08-20 (run 32404132717, tentativa 2): a rajada
 * de prefetch RSC começou 53ms ANTES do POST, e 19,6s depois do POST — num
 * contexto NOVO, com login NOVO — a tela de marca ainda renderizava "Sem logo
 * próprio…" e o botão Remover da camada de instalação não existia.
 *
 * A corrida é reproduzida pelo PORTÃO do dublê, não por `sleep`: o teste
 * controla exatamente o instante em que a leitura volta.
 */
describe("uma escrita DURANTE a leitura não pode ser desfeita pela leitura", () => {
  beforeEach(async () => {
    banco.linha = SEM_LOGO;
    banco.leituras = 0;
    banco.portao = null;
    (await instancia()).invalidarMarcaDaInstalacao();
  });

  it("a leitura que começou antes da escrita NÃO reinstala o valor velho", async () => {
    const tela = await instancia();
    const rota = await instancia();

    // 1. A tela começa a ler e fica presa no portão, ainda vendo SEM_LOGO.
    let liberar!: () => void;
    banco.portao = { liberar: () => {}, esperar: new Promise<void>((r) => (liberar = r)) };
    const emVoo = tela.marcaDaInstalacao();

    // 2. A rota grava o logo e invalida — exatamente o que o upload faz.
    banco.linha = COM_LOGO;
    rota.invalidarMarcaDaInstalacao();

    // 3. A leitura presa volta AGORA, com o valor de antes da escrita.
    liberar();
    const velha = await emVoo;
    expect(velha?.logo_path, "controle: a leitura em voo tem mesmo de voltar velha").toBeNull();

    // 4. A próxima leitura precisa IR AO BANCO. Se a leitura em voo tiver
    //    reinstalado o memo, ela devolve o valor velho sem ler nada — que é o
    //    defeito: tela negando o logo atrás de um toast de sucesso.
    banco.portao = null;
    const leiturasAntes = banco.leituras;
    const depois = await tela.marcaDaInstalacao();
    expect(
      banco.leituras,
      "a leitura seguinte tem de ir ao banco — o memo não pode ter sido reinstalado",
    ).toBeGreaterThan(leiturasAntes);
    expect(depois?.logo_path, "a tela precisa enxergar o logo recém-subido").toBe(CAMINHO_SUBIDO);
  });

  it("sem escrita no meio, a leitura memoiza normalmente — o conserto não desligou o memo", () => {
    // Controle NEGATIVO do caso acima: se o conserto tivesse desarmado o memo em
    // geral, este caso viraria "vai ao banco toda vez" e ninguém notaria a perda.
    return (async () => {
      const tela = await instancia();
      const primeira = banco.leituras;
      await tela.marcaDaInstalacao();
      const depoisDaPrimeira = banco.leituras;
      await tela.marcaDaInstalacao();
      expect(banco.leituras, "a segunda leitura tem de vir do memo").toBe(depoisDaPrimeira);
      expect(depoisDaPrimeira, "a primeira tem de ter ido ao banco").toBeGreaterThan(primeira);
    })();
  });
});

/**
 * ═══ A JANELA QUE A GERAÇÃO NÃO COBRE: a leitura que FALHOU depois da escrita ═══
 *
 * A guarda de geração compara o número antes e depois do `await`. Ela fecha a
 * leitura que volta velha porque começou ANTES da invalidação. Ela NÃO fecha — e
 * por construção não pode fechar — a leitura que FALHA DEPOIS dela: ali a
 * geração não mudou na segunda conferência, a guarda passa, e `null` entra no
 * memo com TTL novo.
 *
 * O sintoma é o mesmo do bloco anterior, por outra porta. `null` significa "o
 * banco não falou" — contrato declarado de `marcaDaInstalacao` —, o resolvedor
 * cai na camada do `.env` e a barra lateral passa a desenhar a marca do PRODUTO:
 * `aside img` não existe, e por até 30s, atrás do MESMO toast verde de "Logo
 * atualizado.".
 *
 * É a única ordem que `invalidarMarcaDaInstalacao()` não alcança, e é a que a
 * issue #895 mede: POST 200 às 10:44:02.163Z, e 15s depois a barra lateral ainda
 * sem logo.
 */
describe("a leitura que FALHOU depois da escrita não vira fato memoizado", () => {
  beforeEach(async () => {
    banco.linha = COM_LOGO;
    banco.leituras = 0;
    banco.portao = null;
    banco.erro = null;
    (await instancia()).invalidarMarcaDaInstalacao();
  });

  it("o render seguinte PERGUNTA ao banco de novo, e enxerga o logo subido", async () => {
    const tela = await instancia();
    const rota = await instancia();

    // 1. O upload terminou: 200 e invalidação, na ordem real da rota
    //    (`gravarCaminho` grava e SÓ DEPOIS invalida).
    rota.invalidarMarcaDaInstalacao();

    // 2. E é DEPOIS dela que a leitura do render falha — um pooler sem
    //    resposta, no exato instante em que a tela vai desenhar a barra.
    banco.erro = { code: "503", message: "pooler sem resposta" };
    expect(await tela.marcaDaInstalacao(), "na falha vale o `.env` deste render").toBeNull();
    expect(banco.leituras, "controle: a leitura falhando foi ao banco uma vez").toBe(1);

    // 3. O banco volta. A leitura seguinte TEM de ir ao banco: se a falha tiver
    //    sido memoizada, ela devolve `null` do memo e a barra lateral continua
    //    desenhando a marca do produto por um TTL inteiro. É esta asserção que
    //    fica vermelha sem o conserto.
    banco.erro = null;
    const linha = await tela.marcaDaInstalacao();
    expect(
      banco.leituras,
      "a falha não pode ser servida do memo como se fosse leitura",
    ).toBe(2);
    expect(linha?.logo_path, "o logo recém-subido tem de aparecer no render seguinte").toBe(
      CAMINHO_SUBIDO,
    );
  });

  it("CONTROLE: leitura bem-sucedida continua sendo memoizada", async () => {
    // Sem este caso, o conserto passaria verde com o memo simplesmente DESLIGADO
    // — e aí toda tela pagaria uma consulta por render sem ninguém notar.
    const tela = await instancia();
    expect((await tela.marcaDaInstalacao())?.logo_path).toBe(CAMINHO_SUBIDO);
    await tela.marcaDaInstalacao();
    expect(banco.leituras, "uma ida ao banco por TTL continua sendo o contrato").toBe(1);
  });
});
