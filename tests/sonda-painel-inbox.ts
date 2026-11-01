/**
 * Sonda do bloco 2.8 — o painel do inbox parou de mentir?
 *
 * Prova nos DOIS sentidos, que é o padrão que passei a exigir do time depois do
 * teste de mutação do @DevVivo: não basta ver a tela certa quando tudo funciona.
 * Um painel que mostra dados no caminho feliz e diz "Sem oportunidades." quando a
 * leitura falha continua mentindo — só que mais raramente.
 *
 *   A) CAMINHO FELIZ  — o contato tem lead e atividade, e a tela mostra os dois,
 *                       com o motivo humano e sem UUID.
 *   B) FALHA INJETADA — a rota devolve 500 e a tela precisa dizer que NÃO
 *                       CONSEGUIU LER. Se disser "Sem oportunidades.", reprova: isso é
 *                       afirmação sobre o negócio em cima de um erro.
 *
 * Run: E2E_PORT=3020 npx tsx tests/sonda-painel-inbox.ts
 */
import { chromium, type Page } from "@playwright/test";

import { BASE, EVIDENCE, login, shotPage } from "./qa-helpers";

const CONTATO = "Ana Souza LGPD E2E";
const ROTA = "**/crm-summary**";

const resultados: { nome: string; ok: boolean; detalhe: string }[] = [];
function record(nome: string, ok: boolean, detalhe: string): void {
  resultados.push({ nome, ok, detalhe });
  console.info(`${ok ? "PASS " : "FALHA"} ${nome} — ${detalhe}`);
}

/** Abre o inbox e CLICA na conversa — passar id na URL não seleciona nada. */
async function abrirConversa(page: Page): Promise<void> {
  await page.goto(`${BASE}/app/inbox`, { waitUntil: "networkidle" });

  // Espera pela RESOLUÇÃO, não por um título. Esperar "Oportunidades recentes" me deu
  // um falso verde: o cabeçalho existe ANTES dos dados, então as asserções
  // negativas ("não diz Sem oportunidades") passaram por ausência — verde vácuo, a
  // mesma armadilha que virou lei no §7.4 e que eu quebrei no meu próprio teste.
  // A resolução verdadeira é a resposta da rota, que também dispara quando ela
  // está interceptada com 500.
  const resposta = page.waitForResponse((r) => r.url().includes("/crm-summary"), {
    timeout: 20_000,
  });
  await page.getByText(CONTATO).first().click();
  await resposta;

  // E depois, o DOM assentado: alguma das TRÊS saídas possíveis da seção.
  const painel = page.getByRole("complementary").last();
  await painel
    .getByText(/Sem leads\.|Não consegui ler|R\$|Movido de/)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "admin");

  // ---------- A) caminho feliz ----------
  await abrirConversa(page);
  // `.last()` porque HÁ DOIS <aside>: a navegação lateral e o painel. Contar
  // com "o único" foi o erro que eu mesmo cataloguei três vezes hoje.
  const painel = page.getByRole("complementary").last();
  const textoOk = await painel.innerText();

  // POSITIVA, não negativa. "Não diz 'Sem leads'" é trivialmente verdadeiro numa
  // seção vazia — foi assim que este mesmo teste me deu falso verde na 1ª rodada.
  // Agora exige ver a coisa: o título do lead e um rótulo de atividade.
  const temLead = /Titular LGPD E2E/.test(textoOk);
  const temAtividade = /Mudou de estágio|Anotação|Atendimento da IA/.test(textoOk);
  record(
    "2.8.a-dados",
    temLead && temAtividade,
    `lead ${temLead ? "visível" : "AUSENTE"} · atividade ${temAtividade ? "visível" : "AUSENTE"}`,
  );
  record(
    "2.8.b-motivo",
    /Movido de .+ para .+/.test(textoOk),
    /Movido de .+ para .+/.test(textoOk)
      ? "o motivo humano aparece na 2ª superfície"
      : "o motivo humano NÃO aparece",
  );
  const uuid = textoOk.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  record("2.8.c-uuid", !uuid, uuid ? `UUID visível: ${uuid[0]}` : "nenhum UUID visível");
  await shotPage(page, "wave-3-2.8-painel-ok.png");

  // ---------- B) falha injetada ----------
  // Injetada de propósito, não dependendo do bug: o gate continua valendo
  // depois que a causa raiz for embora, e reprova se alguém reintroduzir
  // "erro vira lista vazia" daqui a seis meses.
  await page.route(ROTA, (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"boom"}}' }),
  );
  await abrirConversa(page);
  const textoFalha = await painel.innerText();

  // "Nenhuma demanda aberta." entra na lista pelo MESMO motivo das outras
  // três: com a leitura falhando, é uma afirmação sobre o negócio feita em
  // cima de um erro. A seção nasceu depois da sonda; se não entrasse aqui, o
  // painel poderia voltar a mentir por um caminho que ninguém vigia.
  const mente = /Sem leads\.|Sem atividade\.|Sem pedidos\.|Nenhuma demanda aberta\./.test(
    textoFalha,
  );
  const confessa = /Não consegui ler/i.test(textoFalha);
  record(
    "2.8.d-falha-confessa",
    confessa && !mente,
    mente
      ? "MENTE: com a leitura falhando, afirma 'Sem leads/atividade' — erro disfarçado de fato"
      : confessa
        ? "diz que não conseguiu ler, e oferece tentar de novo"
        : "não mente, mas também não diz nada",
  );
  await shotPage(page, "wave-3-2.8-painel-falha.png");

  await browser.close();
  const reprovados = resultados.filter((r) => !r.ok);
  console.info(`\n=== ${resultados.length - reprovados.length}/${resultados.length} ===`);
  console.info(`prints em ${EVIDENCE}`);
  if (reprovados.length) process.exitCode = 1;
}

void main();
