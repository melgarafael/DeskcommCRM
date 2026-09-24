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
 * ─── O QUE ELE PROVA AGORA — e a lacuna que continua aberta (issue #347) ────
 *
 * Medido em 2026-08-26, contra o HEAD da época: ele **não discriminava o
 * conserto do token**. Com Supabase local e build de produção, revertendo SÓ
 * `lib/supabase/browser.ts` para a versão da `main` (e conferindo no bundle:
 * `grep -rc realtime-token .next/static` → 0, com controle positivo em
 * `sb-deskcomm-auth` → 1):
 *
 *   com o conserto      → 1 passed
 *   sem o conserto      → 1 passed   ← aqui estava o problema
 *
 * A explicação mais provável era o SEGUNDO caminho: `useMessagesRealtime` liga
 * `refetchOnWindowFocus: true`, e o `execFileSync` que injetava a mensagem
 * devolvia o foco à janela. Duas rotas para a mesma saída — a sabotagem de uma
 * é invisível para uma asserção que só olha a saída.
 *
 * O que esta versão muda: passa a asserir sobre a ENTRADA da rota, não sobre a
 * saída. O que trafega no socket é fato observável, e não tem caminho
 * alternativo:
 *
 *   1. o canal assina com o token do USUÁRIO — JWT com `role: authenticated`
 *      (`data-realtime-status` diz `subscribed` com a entrega morta; o token,
 *      não — anônimo ele é anônimo, dito pelo próprio JWT);
 *   2. o servidor EMPURRA a linha — frame `postgres_changes` com o corpo da
 *      mensagem. Canal anônimo não recebe frame nenhum: a RLS filtra do outro
 *      lado.
 *
 * É a asserção (2) que fica VERMELHA quando o conserto do #327 não está no
 * bundle. O refetch de foco pode até acontecer durante a espera — ele deixa de
 * bastar, porque não é ele que a asserção mede. A injeção também deixou de ser
 * `execFileSync`: o processo sobe sem bloquear o loop do runner durante a
 * janela de asserção, que era um confundidor a mais.
 *
 * ⚠️ HONESTIDADE — O QUE NÃO FOI MEDIDO AQUI: a matriz de sabotagem desta
 * versão. A bancada exige Docker (Supabase local + build de produção) e a VPS
 * onde esta mudança foi escrita não tem Docker. O que se mediu: `tsc --noEmit`,
 * os unitários e a fila de gates. A prova de discriminação — verde com o
 * conserto, VERMELHO revertendo só `lib/supabase/browser.ts` — precisa de uma
 * rodada no runner, e é ela que libera a volta desta spec ao CI.
 *
 * Quem discrimina em unidade é `tests/unit/realtime-token-do-socket.test.ts`,
 * que cobra a callback INSTALADA e o token que ela devolve — e que reprova 6 de
 * 7 casos quando a callback some.
 *
 * ⚠️ E POR ISSO ELE CONTINUA FORA DO GATE DE MERGE (2026-08-26, issue #347). Ele
 * está em `FORA_DO_CI` no `.github/workflows/e2e.yml`, com o motivo medido
 * escrito lá: além de não discriminar, ele reprovou duas vezes o mesmo sha de um
 * PR que não toca inbox, realtime nem socket, depois de passar em dois outros.
 * Gate que reprova por moeda treina o time a reexecutar em vez de olhar.
 *
 * Ele CONTINUA rodando local: `pnpm exec playwright test
 * tests/e2e/inbox-tempo-real.spec.ts`. O que falta para ele voltar ao CI é uma
 * rodada no runner com a sabotagem acima VERMELHA.
 */
import { execFileSync, spawn } from "node:child_process";
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
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/**
 * Faz a mensagem CHEGAR — fora do browser, como o webhook do WhatsApp chega.
 *
 * Se a mensagem fosse escrita pela própria página, o teste provaria que a UI
 * mostra o que ela mesma escreveu, que é outra coisa. O script grava as duas
 * pontas que o inbox escuta (`messages` e o carimbo de `conversations`) — dois
 * canais no mesmo socket, e era a coexistência deles que expunha o defeito.
 *
 * ⚠️ ASSÍNCRONO DE PROPÓSITO (issue #347). Era `execFileSync`, que bloqueia o
 * loop do runner por todo o tempo de vida do processo filho — e o runner é quem
 * responde ao browser. O `expect.poll` desta spec depende de o loop andar: com
 * o loop parado, cada espera estica junto com o banco. Não é a causa medida da
 * não-determinação (a hipótese do foco de janela segue NÃO medida), mas é um
 * confundidor a menos numa janela em que o que se mede é tempo.
 */
async function chegarMensagem(conversationId: string, corpo: string): Promise<void> {
  await new Promise<void>((resolve, rejeitar) => {
    const filho = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/e2e-chega-mensagem.ts", conversationId, corpo],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    filho.on("error", (erro: Error) => rejeitar(erro));
    filho.on("close", (codigo) =>
      codigo === 0
        ? resolve()
        : rejeitar(new Error(`e2e-chega-mensagem.ts saiu com código ${codigo}`)),
    );
  });
}

/**
 * ─── A PROVA QUE FALTAVA: O QUE O SOCKET LEVOU E TROUXE ─────────────────────
 *
 * A asserção antiga media o SINTOMA (o texto na tela) e ficava verde com o canal
 * mudo, porque `useMessagesRealtime` liga `refetchOnWindowFocus: true`: a tela
 * tem dois caminhos para a mesma mensagem. Asserção sobre a saída não separa as
 * rotas; asserção sobre o socket separa, porque não há rota alternativa.
 *
 * Anonimato e entrega são fatos da FIAÇÃO, lidos no frame:
 *
 *   - `phx_join` levando um JWT com `role: authenticated` (issue #327: sem o
 *     conserto o socket vai de ANON KEY);
 *   - `postgres_changes` chegando com o corpo da mensagem (canal anônimo não
 *     recebe frame NENHUM — a RLS filtra do outro lado).
 */
interface FrameDeSocket {
  direcao: "enviado" | "recebido";
  evento: string;
  topico: string;
  payload: string;
  ts: number;
}

/**
 * Decodifica as claims dos JWTs presentes num texto.
 *
 * Procura o token ONDE ELE ESTIVER (payload do join, URL do handshake) em vez de
 * num campo específico: o layout do frame é decisão da lib, e afirmar sobre ele
 * criaria uma spec que quebra quando a lib sobe de versão por motivo alheio. O
 * que interessa é o que o token DIZ — `role: authenticated` é do usuário,
 * `role: anon` é a chave pública.
 *
 * Token ilegível fica FORA da conta e aparece no diagnóstico: contar um token
 * que não foi lido como se fosse anônimo seria inventar a prova.
 */
function tokensDoTexto(texto: string): { role?: string; sub?: string }[] {
  const achados =
    texto.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g) ?? [];
  const claims: { role?: string; sub?: string }[] = [];
  for (const t of achados) {
    try {
      const json = Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8");
      claims.push(JSON.parse(json) as { role?: string; sub?: string });
    } catch {
      // Não é JWT legível — segue para o próximo.
    }
  }
  return claims;
}

/**
 * Escuta TODOS os sockets da página.
 *
 * Tem de ser chamado ANTES do primeiro `goto`: o Playwright só emite `websocket`
 * para sockets criados DEPOIS do `on`, e o canal do inbox nasce na primeira
 * navegação autenticada. Registrar depois seria uma escuta cega que passa
 * sempre — o modo de falha desta classe de teste.
 */
function escutarSockets(page: Page, frames: FrameDeSocket[]): void {
  page.on("websocket", (ws) => {
    const url = ws.url();
    // O apikey viaja na URL do handshake; o token do canal, no payload do join.
    // Registrar os dois é o que torna a asserção independente de onde a lib põe
    // o quê.
    frames.push({ direcao: "enviado", evento: "handshake", topico: url, payload: url, ts: Date.now() });
    const registrar = (direcao: "enviado" | "recebido", bruto: Buffer | string) => {
      const texto = bruto.toString();
      let evento = "<sem-evento>";
      let topico = "<sem-topico>";
      try {
        const arr = JSON.parse(texto) as [unknown, unknown, string, string, unknown];
        topico = String(arr[2]);
        evento = String(arr[3]);
      } catch {
        // Frame que não é JSON de evento (heartbeat, controle) — fica registrado
        // cru, sem inventar rótulo.
      }
      frames.push({ direcao, evento, topico, payload: texto, ts: Date.now() });
    };
    // O argumento do evento mudou de forma entre versões do Playwright: bruto
    // (`string | Buffer`) ou `{ payload }`. Aceitar as duas mantém a escuta de
    // pé numa atualização de dependência, em vez de virar vermelho falso.
    const brutoDoEvento = (e: string | Buffer | { payload: string | Buffer }): string | Buffer =>
      typeof e === "object" && e !== null && "payload" in e ? e.payload : e;
    ws.on("framesent", (evento) => registrar("enviado", brutoDoEvento(evento)));
    ws.on("framereceived", (evento) => registrar("recebido", brutoDoEvento(evento)));
  });
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

    /**
     * A ESCUTA DO SOCKET VEM ANTES DO PRIMEIRO `goto` — ver `escutarSockets`.
     */
    const frames: FrameDeSocket[] = [];
    escutarSockets(page, frames);

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
     * QUEM PROVA A ENTREGA é a asserção do FRAME mais abaixo (o servidor
     * empurrou a linha pelo socket), somada aos contadores de divergência
     * continuarem 0: se o texto aparecesse porque a rede de segurança curou a
     * perda, o contador teria subido. As duas juntas separam "o canal entregou"
     * de "alguém consertou depois".
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

    // O canal DO THREAD — que é quem traz esta mensagem. A asserção anterior
    // cobre o canal da LISTA (`conversations`); são canais diferentes, e até
    // esta versão o teste afirmava sobre um enquanto esperava a entrega do
    // outro.
    const thread = page.getByTestId("chat-thread");
    await expect(thread).toHaveAttribute("data-realtime-status-mensagens", "subscribed", {
      timeout: 20_000,
    });

    /**
     * ⚠️ A PROVA DO #327, E ELA NÃO OLHA A TELA (issue #347).
     *
     * Sem o conserto de `lib/supabase/browser.ts` o socket assina com a ANON
     * KEY. O `data-realtime-status` continua dizendo `subscribed` — é o
     * instrumento cego que já se sabe cego — mas o JWT do join diz `anon`, e
     * este teste lê o JWT. É esta asserção (e a do frame, logo abaixo) que fica
     * VERMELHA com o conserto fora do bundle, sem depender de foco de janela,
     * de refetch, de timing ou de qualquer caminho alternativo da tela.
     *
     * Vem ANTES da escrita, como o filtro: canal que assinasse anônimo só
     * depois da mensagem chegar passaria igual.
     */
    const joins = frames.filter((f) => f.direcao === "enviado" && f.evento === "phx_join");

    // Primeiro, a leitura em si precisa ser possível. Se ninguém conseguiu ler
    // token nenhum, a falha é do INSTRUMENTO (layout de frame novo, lib subiu de
    // versão) e não do produto — duas causas que pedem ações opostas, e que uma
    // asserção só não separaria.
    await expect
      .poll(() => joins.filter((j) => tokensDoTexto(j.payload).length > 0).length, {
        timeout: 20_000,
        message:
          "não foi possível ler o token de nenhum `phx_join` — instrumento quebrado, " +
          "não produto (ver frames no diagnóstico)",
      })
      .toBeGreaterThan(0);

    await expect
      .poll(
        () =>
          frames
            .flatMap((f) => tokensDoTexto(f.payload))
            .filter((claims) => claims.role === "authenticated").length,
        {
          timeout: 20_000,
          message:
            "nenhum canal assinou com o token do USUÁRIO — o socket está anônimo, " +
            "que é o defeito do #327",
        },
      )
      .toBeGreaterThan(0);

    // E nenhum canal pode assinar como anônimo enquanto outro assina certo:
    // era exatamente a coexistência de um canal bom com um anônimo que o
    // defeito original escondia.
    const anonimos = joins.filter((j) =>
      tokensDoTexto(j.payload).some((claims) => claims.role === "anon"),
    );
    expect(
      anonimos.map((j) => j.topico),
      "canal assinando como ANÔNIMO — é o defeito do #327 (a varredura de joins viu estas roles: " +
        JSON.stringify(frames.flatMap((f) => tokensDoTexto(f.payload).map((c) => c.role))) +
        ")",
    ).toHaveLength(0);

    const corpo = `chegou em tempo real ${Date.now()}`;
    await chegarMensagem(conversationId, corpo);

    /**
     * As bolhas do thread: o `<p>` do corpo em `MessageBubble`. Serve para
     * asserir VALOR e ORDEM, não presença — a diferença entre "tem o texto em
     * algum lugar" e "tem o texto, uma vez só, no fim da fila".
     */
    const bolhas = thread.locator("p.whitespace-pre-wrap");

    try {
      /**
       * ⚠️ 1) O CAMINHO, e aqui está o conserto da #347: o SERVIDOR EMPUROU a
       * linha pelo socket. Canal anônimo não recebe frame nenhum (a RLS filtra
       * do outro lado), então esta asserção é a que discrimina o conserto do
       * #327 — e não existe refetch, foco de janela ou F5 que a satisfaça no
       * lugar do canal.
       *
       * A mensagem é casada pelo CORPO (timestamp único), não pela contagem de
       * frames: qualquer outro tráfego de `postgres_changes` na mesma página
       * (a lista, outra conversa) passaria por uma asserção de "chegou algum
       * frame".
       */
      await expect
        .poll(
          () =>
            frames.filter(
              (f) =>
                f.direcao === "recebido" &&
                f.evento === "postgres_changes" &&
                f.payload.includes(corpo),
            ).length,
          {
            timeout: 25_000,
            message: `o servidor não empurrou a mensagem pelo socket (corpo: ${corpo})`,
          },
        )
        .toBeGreaterThan(0);

      // ⚠️ 2) SEM reload. O SINTOMA, no valor: a bolha com este corpo existe —
      // uma vez só.
      await expect(bolhas.filter({ hasText: corpo })).toHaveCount(1, { timeout: 25_000 });

      // ⚠️ 3) E é a ÚLTIMA da fila — ordem, não presença.
      await expect(bolhas.last()).toContainText(corpo);
    } catch (err) {
      // Sem isto, a falha diz só "element(s) not found" — que é verdade para
      // todas as causas já vistas e não separa nenhuma. O que segue é o que
      // distingue: estado dos DOIS canais, contadores de perda, o que o socket
      // levou e trouxe, e o que o browser falou.
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
        rolesVistasNosTokens: frames.flatMap((f) => tokensDoTexto(f.payload).map((t) => t.role)),
        framesDoSocket: frames
          .slice(-25)
          .map((f) => `${f.direcao}:${f.evento}:${f.topico}`.slice(0, 160)),
        framesDeMensagemRecebidos: frames.filter(
          (f) => f.direcao === "recebido" && f.evento === "postgres_changes",
        ).length,
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
    await expect(thread).toHaveAttribute("data-refetch-divergencias-mensagens", "0");

    // Evidência do caminho, no log do CI: com que token os canais assinaram e
    // quantos frames de mensagem o socket recebeu. É o que se lê quando alguém
    // pergunta "passou pelo canal ou pelo refetch?".
    console.info(
      "[inbox-tempo-real] prova do caminho:",
      JSON.stringify({
        rolesDosTokens: frames.flatMap((f) => tokensDoTexto(f.payload).map((t) => t.role)),
        framesDeMensagemRecebidos: frames.filter(
          (f) => f.direcao === "recebido" && f.evento === "postgres_changes",
        ).length,
      }),
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
