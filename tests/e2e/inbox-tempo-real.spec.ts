/**
 * A MENSAGEM NOVA APARECE SEM O F5 — provado pela tela, que é o que o usuário faz.
 *
 * ─── O defeito que este spec guarda ─────────────────────────────────────────
 *
 * "Recebemos mensagem e só reflete no inbox se atualizarmos a página."
 *
 * O socket do Realtime assinava com a ANON KEY: o cookie de sessão é httpOnly,
 * o supabase-js do browser não enxerga a sessão, e a callback padrão dele
 * termina em `?? this.supabaseKey`. Canal anônimo responde SUBSCRIBED, a RLS
 * filtra do outro lado, e nada é entregue — em silêncio, com todo sinal
 * disponível dizendo "saudável".
 *
 * ─── Por que ESTE teste, e não um unitário ──────────────────────────────────
 *
 * Os unitários anteriores exercitavam `setAuth` contra um cliente FAKE e
 * ficaram verdes durante todo o defeito, porque o que quebrou foi o EFEITO de
 * uma chamada, não a chamada. Só o caminho inteiro — browser real, cookie
 * httpOnly real, socket real, RLS real — prova que a entrega acontece.
 *
 * ⚠️ NÃO RECARREGA A PÁGINA depois de abrir o inbox, e isso é o teste. Se
 * alguém acrescentar um `reload()` aqui "para estabilizar", ele passa a medir o
 * F5 — exatamente o sintoma que existe para proibir.
 *
 * ─── O QUE ELE NÃO PROVA — medido em 2026-08-26, contra este mesmo HEAD ─────
 *
 * Ele **não discrimina o conserto do token**. Medido, com Supabase local, build
 * de produção, revertendo SÓ `lib/supabase/browser.ts` para a versão da `main`
 * (e conferindo no bundle: `grep -rc realtime-token .next/static` → 0, com
 * controle positivo em `sb-deskcomm-auth` → 1):
 *
 *   com o conserto      → 1 passed
 *   sem o conserto      → 1 passed   ← aqui está o problema
 *
 * Quem discrimina é `tests/unit/realtime-token-do-socket.test.ts`, que cobra a
 * callback INSTALADA e o token que ela devolve — e que reprova 6 de 7 casos
 * quando a callback some.
 *
 * A explicação mais provável do empate é que a tela tem mais de um caminho para
 * a mesma mensagem: `useMessagesRealtime` liga `refetchOnWindowFocus: true`, e
 * o `execFileSync` que injeta a mensagem devolve o foco à janela. Dois caminhos
 * com a mesma saída — a sabotagem de um é invisível na asserção.
 *
 * Então o que este spec É: a cerca de ponta a ponta contra o SINTOMA relatado
 * (a mensagem não aparece sem F5), por qualquer causa. É valioso, e é menos do
 * que o cabeçalho acima sugeria antes desta medição.
 *
 * ⚠️ E POR ISSO ELE SAIU DO GATE DE MERGE (2026-08-26, issue #347). Ele está em
 * `FORA_DO_CI` no `.github/workflows/e2e.yml`, com o motivo medido escrito lá:
 * além de não discriminar, ele reprovou duas vezes o mesmo sha de um PR que não
 * toca inbox, realtime nem socket, depois de passar em dois outros. Gate que
 * reprova por moeda treina o time a reexecutar em vez de olhar.
 *
 * Ele CONTINUA aqui e continua rodando local — `pnpm exec playwright test
 * tests/e2e/inbox-tempo-real.spec.ts`. O que a issue #347 precisa entregar para
 * ele voltar: um caminho só até a mensagem durante a asserção, e a matriz de
 * sabotagem ficando VERMELHA sem o conserto.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  /** Bloco gravado por `seed-e2e-queue.ts` — a conversa que este teste usa. */
  queue?: { conversation_id: string; contact_name: string };
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

/**
 * SEMEIA SEMPRE, nunca "só se o arquivo não existir".
 *
 * `.e2e-creds.json` é estado de disco: ele sobrevive a um banco recriado e passa
 * a apontar para uma organização que não existe mais. Medido — o seed da fila
 * morria com `channel_sessions_organization_id_fkey`, e a causa não era o teste
 * nem o banco, era um arquivo velho. Os seeds são idempotentes; pular por
 * existência de arquivo troca um custo pequeno por uma falha confusa.
 */
function creds(): E2ECreds {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], {
    stdio: "inherit",
  });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

/**
 * A CONVERSA QUE ESTE TESTE PRECISA — semeada, nunca pressuposta.
 *
 * O seed de credenciais NÃO cria conversas. Depender de "já ter alguma no banco"
 * passaria na máquina de quem desenvolve (onde o banco acumulou histórico) e
 * falharia num banco fresco, que é o do CI — e é o único que vale como prova.
 * `seed-e2e-queue.ts` já monta o trio contato + canal + conversa e é idempotente.
 */
function semearConversa(): NonNullable<E2ECreds["queue"]> {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], {
    stdio: "inherit",
  });
  const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
  if (!c.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");
  return c.queue;
}

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * Faz a mensagem CHEGAR — fora do browser, como o webhook do WhatsApp chega.
 *
 * Se a mensagem fosse escrita pela própria página, o teste provaria que a UI
 * mostra o que ela mesma escreveu, que é outra coisa. O script grava as duas
 * pontas que o inbox escuta (`messages` e o carimbo de `conversations`) — dois
 * canais no mesmo socket, e era a coexistência deles que expunha o defeito.
 */
function chegarMensagem(conversationId: string, corpo: string): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/e2e-chega-mensagem.ts", conversationId, corpo],
    { cwd: process.cwd(), stdio: "inherit" },
  );
}

test.describe("inbox em tempo real", () => {
  /**
   * O TETO DE 30s DO `playwright.config.ts` NÃO CABE NESTE TESTE.
   *
   * Medido no CI: `Test timeout of 30000ms exceeded` na última asserção — o
   * teste chegou até o fim e o relógio o matou. As esperas somam ~67s no pior
   * caso (cabeçalho 20s + assentar 2s + canal de pé 20s + a mensagem 25s), e
   * cada uma delas existe por uma razão: são os prazos de uma tela que fala com
   * um socket, não folga preguiçosa.
   *
   * Subir o teto do describe é o padrão do repo para specs assim
   * (`agente-novo-e-uso`, `capacidades-do-agente`, `distribuicao-atendimento`…),
   * e o fim de `docs/testing/user-journey-map.md` avisa exatamente isto para
   * quem escreve spec nova. Eu li e não apliquei — daí a segunda rodada vermelha.
   */
  test.describe.configure({ timeout: 120_000 });

  /**
   * Os seeds saem de DENTRO do relógio do teste.
   *
   * São dois `execFileSync` (credenciais + fila) que sobem processos Node e
   * falam com o banco. Rodando dentro do `test()`, eles gastavam o orçamento do
   * teste antes de o browser abrir a primeira página. `beforeAll` tem relógio
   * próprio — o tempo de preparar deixa de competir com o tempo de medir.
   */
  let c: E2ECreds;
  let fila: NonNullable<E2ECreds["queue"]>;

  test.beforeAll(() => {
    c = creds();
    fila = semearConversa();
  });

  test("mensagem que chega aparece na conversa aberta, sem recarregar", async ({ page }) => {

    // `manager` e não `admin`: o admin do seed tem fator MFA cadastrado e o
    // login dele para em /login/mfa. O manager vê a aba "Todas" (leitura
    // org-wide), que é o que este teste precisa.
    /**
     * DIAGNÓSTICO, e ele existe porque a adivinhação já custou quatro rodadas.
     *
     * Cada uma matou uma causa real e diferente (posição na lista, teto de 30s,
     * publication) e a quinta falha continuou idêntica na tela: "element(s) not
     * found". Sintoma que não distingue as causas obriga a instrumentar em vez
     * de propor a quinta hipótese.
     */
    const console_: string[] = [];
    page.on("console", (m) => console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
    page.on("pageerror", (e) => console_.push(`pageerror: ${e.message}`.slice(0, 300)));

    await login(page, c.users.manager!.email, c.password);

    /**
     * DEEP-LINK, não "clicar na primeira da lista".
     *
     * A primeira versão clicava em `[data-conversation-id]`.first() e esperava o
     * cabeçalho do contato do seed. Passou aqui e reprovou no CI: lá o banco é
     * compartilhado entre as duas partes do job, outras specs criam conversas
     * mais recentes, e a primeira da lista não era a semeada. O teste media a
     * ORDEM da lista — que não é o assunto dele — e, pior, a conversa poderia
     * nem estar na primeira página (`limit=50`).
     *
     * `?filter=all` porque a fila (default) só mostra as não atribuídas.
     */
    const conversationId = fila.conversation_id;
    await page.goto(`/app/inbox?id=${conversationId}&filter=all`);

    // A seleção é estado LOCAL — a URL não muda (`setSelectedId`, não `router.push`).
    // O sinal de que a conversa abriu é o cabeçalho dela; esperar navegação aqui
    // seria esperar por algo que o app nunca faz.
    await expect(
      page.getByRole("heading", { level: 2, name: fila.contact_name }),
    ).toBeVisible({ timeout: 20_000 });

    // Deixa a tela ASSENTAR antes de escrever. Sem isto o refetch inicial
    // poderia trazer a mensagem e o teste passaria sem o canal ter feito nada —
    // verde pelo motivo errado, que é o modo de falha desta classe de teste.
    await page.waitForTimeout(2_000);

    /**
     * ⚠️ ESTA ASSERÇÃO NÃO PROVA QUE A ENTREGA ESTÁ VIVA — e escrever que provava
     * era repetir, um nível acima, o defeito que este arquivo persegue.
     *
     * `degradacao-silenciosa.spec.ts:22-24` já tinha medido e escrito, meses
     * antes deste PR: "o único estado publicado é o da ASSINATURA
     * (`data-realtime-status`), e ele diz `subscribed` com a entrega morta".
     * É exatamente a assinatura do defeito que este spec existe para guardar —
     * canal que responde SUBSCRIBED e não entrega. Usar esse sinal como prova de
     * saúde é usar como termômetro o instrumento que já se sabe cego.
     *
     * O que ela é de fato: um FILTRO BARATO. Pega o canal que nem chegou a
     * assinar (erro, timeout, socket fora) e falha ali, perto da causa, em vez
     * de esperar 25s pela mensagem e dar "element(s) not found" — que não
     * distingue "não assinou" de "assinou e não entregou".
     *
     * QUEM PROVA A ENTREGA é a asserção seguinte (a mensagem aparecendo) somada
     * a `data-refetch-divergencias` continuar 0: se o texto aparecesse porque a
     * rede de segurança curou a perda, o contador teria subido. As duas juntas
     * separam "o canal entregou" de "alguém consertou depois".
     *
     * Vem ANTES da escrita de propósito: um canal que subisse só depois da
     * entrega passaria igual. (A primeira versão tinha esta asserção DEPOIS do
     * `chegarMensagem`, com um comentário dizendo "antes".)
     */
    await expect(page.locator("[data-realtime-status]")).toHaveAttribute(
      "data-realtime-status",
      "subscribed",
      { timeout: 20_000 },
    );

    const corpo = `chegou em tempo real ${Date.now()}`;
    chegarMensagem(conversationId, corpo);

    // O canal DO THREAD — que é quem traz esta mensagem. A asserção anterior
    // cobre o canal da LISTA (`conversations`); são canais diferentes, e até
    // esta versão o teste afirmava sobre um enquanto esperava a entrega do
    // outro.
    await expect(page.getByTestId("chat-thread")).toHaveAttribute(
      "data-realtime-status-mensagens",
      "subscribed",
      { timeout: 20_000 },
    );

    // ⚠️ SEM reload. Se aparecer, o canal entregou.
    //
    // Escopado ao THREAD de propósito, e não por estilo: quando os dois canais
    // funcionam, o mesmo texto aparece DUAS vezes na tela — na bolha da conversa
    // e na prévia do item da lista, que o outro canal acabou de atualizar. Um
    // `page.getByText(corpo)` solto resolve para 2 elementos e o modo estrito do
    // Playwright reprova o teste **por excesso de sucesso**:
    //
    //   strict mode violation: getByText('chegou em tempo real …') resolved to
    //   2 elements: 1) <p class="…truncate text-xs…"> (a prévia na lista)
    //               2) <p class="whitespace-pre-wrap…"> (a bolha no thread)
    //
    // Medido localmente contra o Supabase local, build de produção, com o
    // conserto aplicado. A lista ter reagido é asserido no fim, no seu lugar.
    const thread = page.getByTestId("chat-thread");
    try {
      await expect(thread.getByText(corpo)).toBeVisible({ timeout: 25_000 });
    } catch (err) {
      // Sem isto, a falha diz só "element(s) not found" — que é verdade para
      // todas as causas já vistas e não separa nenhuma. O que segue é o que
      // distingue: estado dos DOIS canais, contadores de perda, e o que o
      // browser falou.
      const diag = {
        canalDaLista: await page
          .locator("[data-realtime-status]")
          .getAttribute("data-realtime-status")
          .catch(() => "<ausente>"),
        canalDoThread: await thread
          .getAttribute("data-realtime-status-mensagens")
          .catch(() => "<ausente>"),
        perdasNaLista: await page
          .locator("[data-refetch-divergencias]")
          .getAttribute("data-refetch-divergencias")
          .catch(() => "<ausente>"),
        perdasNoThread: await thread
          .getAttribute("data-refetch-divergencias-mensagens")
          .catch(() => "<ausente>"),
        conversationId,
        corpoEsperado: corpo,
      };
      console.info("[diag] estado dos canais:", JSON.stringify(diag));
      console.info("[diag] console do browser:", JSON.stringify(console_.slice(-40)));
      throw err;
    }

    // E entregou pelo CANAL, não pela rede de segurança: `divergencias` conta as
    // vezes em que o refetch trouxe novidade que o canal não tinha trazido.
    await expect(page.locator("[data-refetch-divergencias]")).toHaveAttribute(
      "data-refetch-divergencias",
      "0",
    );

    // A evidência vai para `evidence/`, que é VERSIONADO — `.superpowers/` é
    // ignorado pelo git, e prova citada que ninguém consegue abrir não é prova.
    await page.screenshot({
      path: "evidence/inbox-tempo-real/mensagem-sem-reload.png",
      fullPage: true,
    });

    // E a lista também reagiu — é o outro canal do mesmo socket, que era
    // justamente o que ficava anônimo quando dois canais coexistiam.
    // E A LISTA REORDENOU: a conversa que acabou de receber vai para o topo
    // (`_handler.ts` ordena por `last_message_at` desc). Asserir no PRIMEIRO
    // item é seguro AQUI — e só aqui — porque a mensagem que acabou de chegar é
    // a mais recente do banco por construção. Antes de ela chegar, a posição na
    // lista era imprevisível, e foi o que reprovou no CI.
    const primeiro = page.locator("[data-conversation-id]").first();
    await expect(primeiro).toHaveAttribute("data-conversation-id", conversationId, {
      timeout: 25_000,
    });
    await expect(primeiro).toContainText(corpo, { timeout: 25_000 });
  });
});
