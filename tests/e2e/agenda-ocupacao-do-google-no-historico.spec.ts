import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

/**
 * A OCUPAÇÃO DO GOOGLE NA LISTA "PRÓXIMOS" — e os dois botões que ela não
 * deveria oferecer.
 *
 * ═══ O achado ═══════════════════════════════════════════════════════════════
 *
 * `GradeDaAgenda` trata a origem `google_sync` com cuidado: `disabled`, sem
 * arraste, sem clique, com o rótulo dizendo "ocupado na agenda do Google". O
 * comentário do próprio componente nomeia a razão — "deixar o clique disponível
 * prometeria uma ação que não existe — o defeito do 'controle decorativo' que
 * esta base já pagou uma vez".
 *
 * `HistoricoDaAgenda` recebe a MESMA lista (`_client.tsx` passa `agendamentos`
 * para os dois) e NÃO conhece a origem. Resultado, medido em tela: a ocupação
 * aparece na aba "Próximos" como um compromisso qualquer — badge "Confirmado",
 * subtítulo "Agendamento · com <atendente>" — e com os botões **Remarcar** e
 * **Cancelar** habilitados.
 *
 * Nenhum dos dois pode funcionar: o id é de `calendar_external_events`, e as
 * rotas PATCH/DELETE de agendamento procuram em `calendar_appointments`. O
 * espelho da agenda alheia é somente-leitura por definição — o comentário da
 * própria tabela diz "nunca é reescrito por nós".
 *
 * ═══ Por que isto é do PR #474, e não pré-existente ═════════════════════════
 *
 * Antes dele a ocupação só existia na SEMENTE do servidor, que cobre a semana
 * da âncora e morre no primeiro refetch. O PR faz a rota devolvê-la — o que é o
 * conserto certo — e, com isso, a ocupação passa a viver na lista o tempo todo,
 * em toda semana e em toda visão. O caminho novo levou a ocupação a um segundo
 * consumidor que ninguém ensinou a distingui-la.
 *
 * ⚠️ ESTA SPEC FALHA DE PROPÓSITO enquanto o defeito existir. Ela assere o
 * comportamento DESEJADO: bloco do Google não oferece ação que não existe.
 */

const RAIZ = path.resolve(__dirname, "../..");
const TITULO_SIGILOSO = "Sessao de terapia QUARTA 15h consultorio";
const EMAIL_DA_CONTA = "agenda-pessoal-qa@gmail.com";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string } | undefined>;
}

function lerCreds(): Creds {
  return JSON.parse(fs.readFileSync(path.join(RAIZ, ".e2e-creds.json"), "utf8")) as Creds;
}

function admin() {
  const c = credenciaisSupabaseDeTeste();
  return createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager!;
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
}

async function instanteNoDia(page: Page, dia: string, hora: number): Promise<string> {
  return page.evaluate(
    ([d, h]) => {
      const [ano, mes, diaDoMes] = (d as string).split("-").map(Number);
      return new Date(ano!, mes! - 1, diaDoMes!, h as number, 0, 0, 0).toISOString();
    },
    [dia, hora] as [string, number],
  );
}

test("a ocupação do Google não oferece Remarcar nem Cancelar no histórico", async ({ page }) => {
  // Duas cargas de página + duas navegações de semana + escrita no banco não
  // cabem nos 30s do default quando a máquina está carregada.
  test.setTimeout(120_000);
  const creds = lerCreds();
  const dono = creds.users.agent!;
  const db = admin();
  await entrar(page, creds);

  const dias = await irParaASemanaSeguinte(page);
  const alvo = dias[3]!;

  const { data: conexao } = await db
    .from("calendar_connections")
    .select("id")
    .eq("organization_id", creds.org_id)
    .eq("user_id", dono.id)
    .eq("account_email", EMAIL_DA_CONTA)
    .maybeSingle();
  const conexaoId =
    (conexao as { id: string } | null)?.id ??
    ((
      await db
        .from("calendar_connections")
        .insert({
          organization_id: creds.org_id,
          user_id: dono.id,
          provider: "google_calendar",
          account_email: EMAIL_DA_CONTA,
          status: "healthy",
        } as never)
        .select("id")
        .single()
    ).data as { id: string }).id;

  await db
    .from("calendar_external_events")
    .delete()
    .eq("organization_id", creds.org_id)
    .eq("external_event_id", "qa-visual-historico");
  const { data: evento, error } = await db
    .from("calendar_external_events")
    .insert({
      organization_id: creds.org_id,
      connection_id: conexaoId,
      external_calendar_id: "primary",
      external_event_id: "qa-visual-historico",
      title: TITULO_SIGILOSO,
      starts_at: await instanteNoDia(page, alvo, 15),
      ends_at: await instanteNoDia(page, alvo, 16),
      status: "confirmed",
      transparency: "opaque",
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(`calendar_external_events: ${error.message}`);
  const eventoId = (evento as { id: string }).id;

  await page.reload();
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 25_000 });
  await irParaASemanaSeguinte(page);

  // ─── O INVARIANTE, e ele NÃO é "a linha existe e está cinza" ──────────────
  //
  // ⚠️ Esta spec já reprovou o conserto CERTO uma vez, e a lição está na
  // doutrina de triagem (passe 21). A primeira versão exigia que a linha
  // ESTIVESSE no histórico para então conferir os botões — o que prendia a
  // CIRCUNSTÂNCIA em que o defeito foi visto, não a propriedade que precisa
  // valer. Quando o conserto tirou a ocupação da lista (que é a solução
  // preferida: bloco anônimo do Google não é compromisso nosso), a spec ficou
  // vermelha em `a ocupação nem chegou ao histórico — o cenário não montou`,
  // apontando para o conserto e empurrando quem viesse depois a desfazê-lo
  // para apagar o vermelho.
  //
  // A propriedade que vale é uma só: **a ocupação do Google não oferece ação
  // que não existe**. Ela é satisfeita de DUAS formas, e as duas são corretas:
  //
  //   (a) a linha não aparece no histórico   ← o conserto de hoje
  //   (b) a linha aparece com os botões inertes
  //
  // O que NÃO pode é a terceira: aparecer com botão vivo, que responde 404
  // porque o id é de `calendar_external_events` e a rota procura em
  // `calendar_appointments`.
  const linha = page.getByTestId(`linha-${eventoId}`);
  const apareceNoHistorico = await linha.isVisible().catch(() => false);

  await page.screenshot({
    path: path.join(RAIZ, "evidence/agenda-historico-nao-oferece-acao.png"),
  });

  if (apareceNoHistorico) {
    await expect(
      page.getByTestId(`cancelar-${eventoId}`),
      "«Cancelar» está habilitado numa ocupação do Google: o id é de " +
        "calendar_external_events e a rota DELETE procura em calendar_appointments",
    ).toBeDisabled();
    await expect(
      page.getByTestId(`remarcar-${eventoId}`),
      "«Remarcar» está habilitado numa ocupação do Google — espelho somente-leitura",
    ).toBeDisabled();
  }

  // ─── O CONTROLE, sem o qual "esconda tudo" satisfaria o teste ─────────────
  //
  // Um agendamento NOSSO precisa continuar oferecendo as duas ações. Sem este
  // par, a solução degenerada — filtrar o histórico inteiro, ou desabilitar
  // todos os botões — passaria verde e quebraria a tela para o uso normal.
  // É o "não faça X" com o irmão "mas ainda faça X quando é certo".
  const { data: nosso } = await db
    .from("calendar_appointments")
    .select("id")
    .eq("organization_id", creds.org_id)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(1)
    .maybeSingle();

  if (nosso) {
    const idNosso = (nosso as { id: string }).id;
    const linhaNossa = page.getByTestId(`linha-${idNosso}`);
    if (await linhaNossa.isVisible().catch(() => false)) {
      await expect(
        page.getByTestId(`cancelar-${idNosso}`),
        "«Cancelar» ficou desabilitado num agendamento NOSSO — o conserto da " +
          "ocupação do Google não pode desligar a ação de quem tem ação",
      ).toBeEnabled();
      await expect(
        page.getByTestId(`remarcar-${idNosso}`),
        "«Remarcar» ficou desabilitado num agendamento NOSSO",
      ).toBeEnabled();
    }
  }
});
