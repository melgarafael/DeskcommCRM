import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TELA DE NOTIFICAÇÕES CONTA A VERDADE SOBRE A INSTALAÇÃO — nos DOIS estados.
 *
 * ## O defeito
 *
 * `app/app/settings/notifications/page.tsx` afirmava «In-app (toast) e Push
 * (Chrome) já funcionam para as cinco categorias» de forma INCONDICIONAL. O
 * backend sempre soube a verdade — `GET /api/v1/notifications/push` devolve
 * `enabled:false` sem o par VAPID, e o `PUT` recusa com 503 —, mas a tela nunca
 * perguntou.
 *
 * Num primeiro deploy, que é o estado em que TODA instalação começa (o
 * `.env.hostgator.example` grava as duas linhas vazias), a sequência era:
 *
 *   1. a tela promete Push;
 *   2. a pessoa liga o interruptor e o navegador pede permissão — incômodo
 *      real, cobrado dela;
 *   3. ela concede, e `syncPushSubscription()` faz `return` em silêncio;
 *   4. o interruptor fica ligado, e nada no produto conta que faltam duas
 *      variáveis no `.env`, nem como consegui-las.
 *
 * ## Por que aqui, e não só no `e2e`
 *
 * O `e2e` roda no estado SEM as chaves — é o do `.env.e2e` e é o do primeiro
 * deploy, então é o certo para ele. Mas há **dois** estados, e o servidor lê
 * `vapidPronto()` uma vez por processo: provar o outro pela tela exigiria um
 * segundo `next start` só para trocar duas variáveis, num job que já leva meia
 * hora.
 *
 * Aqui os dois estados são a mesma função chamada duas vezes, em
 * milissegundos, no `verify`. `tests/e2e/notificacoes-diz-o-que-falta.spec.ts`
 * continua sendo quem prova pela tela de verdade, com o navegador.
 *
 * ## Os dois sentidos, e por que os DOIS precisam de guarda
 *
 *  - **sem as chaves, prometer a aba fechada** é o defeito original: a tela
 *    vende o que a instalação não entrega.
 *  - **com as chaves, esconder que funciona** seria o conserto exagerado —
 *    capacidade paga, entregue e não anunciada. Um teste que só cobrasse o
 *    aviso empurraria alguém a deixá-lo fixo na tela, e aí ele mente na outra
 *    direção.
 *
 * ## `renderToStaticMarkup`, e não Testing Library
 *
 * É Server Component async: `render()` não sabe esperar a promessa. Chamar a
 * função e renderizar a árvore que ela devolve mede o HTML de verdade, e não a
 * presença do símbolo `vapidPronto` no arquivo — que é o que um teste de texto
 * mediria, e passaria mesmo com a chamada desligada.
 */

const vapidPronto = vi.hoisted(() => vi.fn<() => boolean>());
// A seção de sons (migration 0441) lê por react-query, e este teste renderiza a
// árvore do servidor sem o QueryClientProvider que o app tem no layout. O que
// este arquivo mede é o texto sobre Push; a seção de sons tem teste próprio.
vi.mock("@/app/app/settings/notifications/_sons", () => ({ SonsDosAvisos: () => null }));
// A seção da tela bloqueada lê a organização no servidor; tem teste próprio.
vi.mock("@/app/app/settings/notifications/_tela-bloqueada", () => ({ ConteudoNaTelaBloqueada: () => null }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto }));
vi.mock("@/lib/auth/server", () => ({ requireAuth: vi.fn().mockResolvedValue({}) }));
vi.mock("@/app/app/settings/notifications/_client", () => ({
  NotificationPrefsClient: () => <table />,
}));

async function telaCom(chaves: boolean): Promise<string> {
  vapidPronto.mockReturnValue(chaves);
  const { default: NotificationsPage } = await import(
    "@/app/app/settings/notifications/page"
  );
  return renderToStaticMarkup(await NotificationsPage());
}

describe("tela de Notificações — o que ela afirma sobre esta instalação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("o instrumento está vivo — controle positivo antes de qualquer conclusão", async () => {
    const semChaves = await telaCom(false);
    const comChaves = await telaCom(true);

    // Se a página deixar de consultar `vapidPronto()`, os dois HTML ficam
    // IGUAIS e todo o resto deste arquivo passa a medir nada. Sem este caso, um
    // refactor que remova a chamada deixa a suíte verde.
    expect(vapidPronto, "a página nem chamou vapidPronto()").toHaveBeenCalled();
    expect(
      semChaves === comChaves,
      "a tela renderiza o MESMO HTML nos dois estados — ela parou de perguntar",
    ).toBe(false);
  });

  it("⭐ SEM o par VAPID: diz o limite, e diz o que fazer", async () => {
    const html = await telaCom(false);

    expect(html).toContain("push-status-faltando-chaves");
    expect(html).not.toContain("push-status-pronto");

    // O limite, em português de gente — não «VAPID ausente».
    expect(html).toMatch(/só aparecem com o site aberto/i);

    // E a saída. Um aviso que só informa a falta deixa o operador sabendo que
    // está quebrado e sem saber o que fazer — que é quase o silêncio de antes.
    // Pelo kit, o par nasce na atualização, inclusive em quem já está na versão
    // mais recente (o update.sh o cria antes da saída "nada a atualizar"). Sem
    // --force: ele refaz backup, manutenção e banco, e pode voltar de versão.
    expect(html).toMatch(/rodar a atualização da instalação/);
    expect(html).toContain("<code>bash hostgator-setup-kit/update.sh</code>");
    expect(html).not.toContain("--force");
    // Fora do kit, o comando de sempre — e o aviso de não trocar um par existente.
    expect(html).toContain("npx web-push generate-vapid-keys");
    expect(html).toContain("VAPID_PUBLIC_KEY");
    expect(html).toContain("VAPID_PRIVATE_KEY");
    expect(html).toMatch(/Não troque um par que já existe/);
  });

  it("⭐ SEM o par VAPID: NÃO afirma que o Push já funciona", async () => {
    const html = await telaCom(false);

    // Esta é a afirmação literal que existia antes e era falsa neste estado:
    // «In-app (toast) e Push (Chrome) já funcionam para as cinco categorias».
    expect(
      html,
      "a tela afirma que o Push já funciona numa instalação sem as chaves",
    ).not.toMatch(/já funcionam/i);

    // ⚠️ MENCIONAR O LIMITE NÃO É PROMETÊ-LO, e esta distinção me custou um
    // vermelho. Escrevi este caso primeiro como um `&&` de duas condições
    // (`/já funcionam/ && /aba fechada/`), previ a sabotagem antes de rodar e
    // vi o furo: a tela ANTIGA dizia «já funcionam» e NÃO dizia «aba fechada»,
    // então o `&&` seria falso e o caso passaria verde sobre exatamente o
    // defeito que existe para pegar. Separei em duas.
    //
    // Aí a segunda ficou errada por outro motivo: proibir a STRING «aba
    // fechada» reprovou a tela CERTA, porque explicar o que falta exige nomear
    // o que falta — «Para receber também com a aba fechada, ... precisa gerar
    // um par de chaves». O teste estava confundindo a menção com a promessa.
    //
    // O que separa uma da outra é a CONDIÇÃO ao lado. Então é ela que se cobra:
    // se a tela fala em aba fechada neste estado, tem de ser dizendo o que
    // fazer para consegui-la.
    if (/aba fechada/i.test(html)) {
      expect(
        html,
        "a tela fala em aba fechada sem dizer que ela depende de configuração",
      ).toMatch(/precisa gerar|para receber também/i);
    }
  });

  it("⭐ COM o par VAPID: anuncia a aba fechada, sem pedir configuração nenhuma", async () => {
    const html = await telaCom(true);

    expect(html).toContain("push-status-pronto");
    expect(html).not.toContain("push-status-faltando-chaves");
    expect(html).toMatch(/aba fechada/i);

    // Capacidade que já está de pé não pode continuar pedindo que o operador
    // rode um comando: seria mandá-lo mexer no `.env` de produção à toa.
    expect(
      html,
      "a instalação já tem as chaves e a tela ainda manda gerar o par",
    ).not.toContain("npx web-push generate-vapid-keys");
  });
});
