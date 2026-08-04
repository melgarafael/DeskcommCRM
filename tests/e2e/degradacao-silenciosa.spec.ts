/**
 * A CERCA DA DEGRADAÇÃO SILENCIOSA.
 *
 * Em 25/07 o funil "CRM Vivo — Clínica" ficou de 2h13 a 3h09 sem entregar nada
 * por tempo real. Nesse intervalo 15 mudanças foram escritas e nenhuma chegou a
 * ninguém — e NENHUMA tela avisou. Medido em três superfícies, com proxy e
 * controle positivo (`tests/prova-raio-do-silencio.ts`, evidência em
 * `evidence/raio-x-realtime.md`).
 *
 * Este critério existe porque aquele defeito vai ser consertado e a degradação
 * silenciosa NÃO. Ela sobrevive a qualquer causa: basta a entrega morrer por um
 * motivo novo — e o usuário volta a ver dado velho com cara de saudável.
 *
 * O QUE ELE MEDE, e a escolha do observável veio antes da asserção:
 *   escopo      — o que um humano vê na tela depois de uma mudança que deveria
 *                 ter chegado ao vivo;
 *   invariância — exige que a tela DIGA ALGUMA COISA, nunca uma forma
 *                 específica. Um badge, um texto, um aviso: qualquer um passa.
 *                 Exigir o meu formato reprovaria uma tela que avisa de outro
 *                 jeito, que é o falso vermelho que me pegou sete vezes na wave 6.
 *
 * POR QUE `test.fail()` E NÃO UM VERMELHO DE VERDADE: hoje o sinal que a tela
 * precisaria mostrar NÃO EXISTE. O único estado publicado é o da ASSINATURA
 * (`data-realtime-status`), e ele diz `subscribed` com a entrega morta — medido.
 * Uma cerca permanentemente vermelha treina o time a ignorar vermelho, que é o
 * mesmo mecanismo pelo qual a intermitência do inbox é pior que a falha
 * determinística. Com `test.fail()` ela não polui a suíte, documenta a lacuna
 * com precisão, e VIRA CATRACA: no dia em que a tela passar a avisar, este teste
 * fica vermelho por PASSAR, e obriga alguém a virar a chave conscientemente.
 *
 * A peça que falta é do produto, não do teste: um REFETCH DE SEGURANÇA. Ele é ao
 * mesmo tempo a base da tela, a cura da perda e o detector da falha.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { rodaSeed } from "./helpers/seed";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    rodaSeed("scripts/seed-e2e-credentials.ts");
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/**
 * Vocabulário de degradação, deliberadamente largo. O critério é "a tela diz
 * alguma coisa sobre estar desatualizada", não "a tela diz do meu jeito".
 */
const AVISO =
  /(offline|sem conex|desconect|reconect|desatualiz|atualiz(ando|e a p)|tempo real|ao vivo|pausad|erro de conex|sem sinal|parad)/i;

/** Entrega de verdade num quadro do Phoenix: `[join_ref, ref, topic, event, payload]`.
 *  O `phx_reply` que confirma a assinatura carrega as mesmas palavras no corpo —
 *  só a POSIÇÃO separa recibo de entrega. Casar por substring conta recibo como
 *  entrega; exigir uma chave `"event":` não casa nada. Já errei os dois. */
function ehEntrega(bruto: string): boolean {
  try {
    const q: unknown = JSON.parse(bruto);
    return Array.isArray(q) && q[3] === "postgres_changes";
  } catch {
    return false;
  }
}

test.describe("degradação silenciosa do tempo real", () => {
  test("com a entrega morta, a tela avisa que pode estar desatualizada", async ({ page }) => {
    // O padrão de 30s da suíte não cabe: só a janela de observação depois da
    // mudança são 12s, e observar por menos tempo transformaria "a tela não
    // avisa" em "eu não esperei o aviso".
    test.setTimeout(150_000);
    // CERCA_CRUA=1 desliga a catraca e deixa o vermelho aparecer com a razão. Sem
    // isso, "falhou como esperado" esconde QUAL asserção falhou — e uma cerca que
    // falha na PRÉ-CONDIÇÃO (nada foi engolido) parece idêntica a uma que falha
    // no ponto certo, documentando uma lacuna que ela nunca exercitou.
    test.fail(
      process.env.CERCA_CRUA !== "1",
      "LACUNA CONHECIDA, não regressão: nenhuma superfície avisa quando a entrega " +
        "de postgres_changes morre. O único estado publicado descreve a ASSINATURA " +
        "e diz 'subscribed' com a entrega morta. Falta um refetch de segurança que " +
        "sirva de detector. Quando existir, este teste passa e vira vermelho aqui — " +
        "é a catraca: alguém tem de remover este test.fail conscientemente.",
    );

    const creds = loadCreds();
    const env = envLocal();
    const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let engolidos = 0;
    let quadrosTotais = 0;
    // O PROXY MATA A ENTREGA SEM DERRUBAR O CANAL: engole só os quadros de dados
    // e deixa passar join, phx_reply e heartbeat. Fechar o socket seria outro
    // defeito — visível — e mediria uma tela que não é a que interessa.
    await page.routeWebSocket(/realtime/i, (route) => {
      const servidor = route.connectToServer();
      route.onMessage((m) => servidor.send(m));
      servidor.onMessage((m) => {
        quadrosTotais++;
        if (ehEntrega(String(m))) {
          engolidos++;
          return;
        }
        route.send(m);
      });
    });

    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(creds.users.manager!.email);
    await page.getByLabel(/senha/i).fill(creds.password);
    await page.getByRole("button", { name: /entrar|acessar/i }).click();
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    const { data: pipes } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", creds.org_id)
      .order("created_at")
      .limit(1);
    const pipelineId = ((pipes ?? [])[0] as { id: string }).id;
    await page.goto(`/app/pipelines/${pipelineId}`);
    await page.waitForTimeout(4000);

    const { data: leads } = await admin
      .from("crm_leads")
      .select("id,title")
      .eq("pipeline_id", pipelineId)
      .order("id")
      .limit(1);
    const lead = (leads ?? [])[0] as { id: string; title: string };

    const marca = `CERCA${Date.now() % 100000}`;
    await admin.from("crm_leads").update({ title: `${lead.title} ${marca}` }).eq("id", lead.id);
    await page.waitForTimeout(12_000);
    const texto = ((await page.locator("body").innerText()) ?? "").replace(/\s+/g, " ");
    await admin.from("crm_leads").update({ title: lead.title }).eq("id", lead.id);

    // PRÉ-CONDIÇÃO ANTES DA ASSERÇÃO: se nenhum quadro de dados foi engolido, a
    // entrega não foi morta e o teste não mediu degradação nenhuma. Sem esta
    // checagem, "a tela não avisou" seria verdade também num ambiente saudável —
    // e a cerca passaria a documentar uma lacuna que não foi exercida.
    expect(
      engolidos,
      `nenhum quadro de dados foi engolido (${quadrosTotais} quadros no total): a entrega ` +
        `não chegou a ser morta, então esta execução não exercita a degradação`,
    ).toBeGreaterThan(0);

    // E a mudança NÃO pode ter aparecido: se apareceu, existe outro caminho vivo
    // (refetch, polling) e a premissa da cerca mudou — o que também é notícia.
    expect(texto, "a mudança apareceu mesmo com a entrega morta — há outro caminho vivo").not.toContain(marca);

    expect(texto, "a tela não diz nada sobre estar possivelmente desatualizada").toMatch(AVISO);
  });
});
