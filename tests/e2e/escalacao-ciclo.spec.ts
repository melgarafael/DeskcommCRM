/**
 * O CICLO INTEIRO, PELA TELA: o agente para, uma pessoa continua, e o agente
 * volta SABENDO o que ela fez.
 *
 * O que este spec mede, e por que o observável foi escolhido antes da asserção:
 *
 *   escopo      — o que um atendente vê e clica: a fila de chamados, a resposta
 *                 ao chamado, o aviso de que o automático está pausado, o botão
 *                 de devolver, a linha do tempo do negócio.
 *   invariância — a asserção final é sobre o CONTEÚDO que atravessa a costura: o
 *                 texto que a pessoa escreveu ao decidir tem de chegar ao
 *                 contexto de abertura do próximo turno do agente. Ela não exige
 *                 formato de frase nem palavra específica do produto — exige que
 *                 a decisão da pessoa esteja lá.
 *
 * POR QUE A PROVA DA RETOMADA É O CONTEXTO DE ABERTURA, E NÃO A FRASE DO MODELO:
 * a frase depende do modelo, do prompt e do humor do dia — prender uma redação
 * daria um teste que reprova por motivo falso e treina o time a ignorá-lo. O que
 * o PRODUTO garante é determinístico: o ritual de abertura do turno lê
 * `lead_checkpoints` (latestCheckpoint → ritualBlocks → bloco "Resumo acumulado
 * da conversa"), e é ali que a decisão da pessoa tem de estar. Este spec lê o
 * MESMO bloco que o motor lê, pela MESMA função, e confere que ele cita a
 * decisão — a diferença entre o agente voltar cego e voltar sabendo.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm exec tsx --env-file=.env.local scripts/seed-e2e-escalacao.ts
 *   pnpm build && E2E_PORT=3021 pnpm exec playwright test tests/e2e/escalacao-ciclo.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/ia-360-w3");

/** O texto que a pessoa escreve ao decidir — é ele que precisa atravessar. */
const DECISAO_DA_PESSOA =
  "Aprovei 15% de desconto para as 200 unidades, com entrega em 5 dias uteis.";
const NOTA_DO_ATENDENTE = "Cliente confirmou o CNPJ por telefone.";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  escalacao: {
    conversation_id: string;
    contact_id: string;
    contact_name: string;
    lead_id: string | null;
    case_id: string;
    case_title: string;
    attendant_user_id: string;
  };
}

function carregarEnv(): Record<string, string> {
  // `process.env` vence o `.env.local`, e a ausência do arquivo não é erro —
  // ver scripts/lib/env-de-teste.ts.
  return carregarEnvLocal();
}

const env = carregarEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * O bloco de abertura do turno, lido pela função REAL do motor.
 *
 * Vai por `tsx` num processo à parte porque `ritualBlocks`/`latestCheckpoint`
 * vivem no mundo do `pg` (o motor não roda dentro do Playwright). O ponto é não
 * transcrever a leitura aqui: transcrita, o spec compararia o banco com a minha
 * cópia da regra e passaria mesmo se o motor lesse outra coisa.
 */
function blocoDeAberturaDoTurno(orgId: string, contactId: string): string {
  const script = [
    `import pg from 'pg';`,
    `import { latestCheckpoint, ritualBlocks } from './lib/agent-engine/agent/inbound-turn';`,
    `const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL });`,
    `const cp = await latestCheckpoint(pool, process.argv[2], process.argv[3]);`,
    `const blocos = ritualBlocks(cp, null, { contato: {}, mensagens: [] }, '(sem notas)');`,
    `process.stdout.write(blocos.join('\\n'));`,
    `await pool.end();`,
  ].join("\n");
  const arquivo = path.join(process.cwd(), ".e2e-abertura-turno.mts");
  fs.writeFileSync(arquivo, script);
  try {
    return execFileSync(
      "pnpm",
      [
        "exec",
        "tsx",
        // SEM `--env-file=.env.local`. Esse arquivo não existe no worktree dedicado
        // de e2e — e a ausência dele é a proteção que impede a suíte de escrever em
        // PRODUÇÃO (o defeito medido em 2026-08-06). Aqui o filho herda o ambiente
        // do runner, que `playwright.config.ts` publica a partir do `.env.e2e`.
        //
        // Medido em 2026-08-08: com a flag, este spec morria em
        // `Command failed: pnpm exec tsx --env-file=.env.local ...` num worktree
        // limpo; num checkout que TEM `.env.local`, rodaria contra a nuvem. O gate
        // `tests/unit/seed-nao-le-env-local-do-disco.test.ts` não pegava esta forma
        // — a regex dele procura `readFileSync`, e esta é a única ocorrência
        // EXECUTÁVEL de `--env-file=.env.local` no repo (as outras são comentários
        // de uso).
        arquivo,
        orgId,
        contactId,
      ],
      { encoding: "utf8", cwd: process.cwd() },
    );
  } finally {
    fs.unlinkSync(arquivo);
  }
}

test.describe("IA 360 W3 — o agente para, a pessoa continua, o agente retoma sabendo", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(() => {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

    // A PRECONDIÇÃO É SEMEADA AQUI, não pressuposta.
    //
    // `seed-e2e-credentials.ts` reescreve o `.e2e-creds.json` INTEIRO, e o helper
    // de login o chama sozinho quando outra sessão rotaciona o fator TOTP deste
    // banco (`semearCredenciais`, tests/e2e/helpers/login-admin.ts). A
    // reconstituição de lá cobre `credentials` e `followup-agent` — o bloco
    // `escalacao` sumia junto e esta spec morria com "rode o seed antes", logo
    // depois de um seed que imprimiu sucesso.
    //
    // Medido em 2026-08-08, rodando a suíte inteira: falha em 0ms, e o vermelho
    // aparecia como se a jornada de escalação estivesse quebrada — quando o que
    // quebrou foi o arquivo de fixtures debaixo dela. Depender de um seed que outra
    // spec deixou é depender da ordem dos arquivos, que já mordeu este repo antes.
    //
    // Só semeia quando falta: o seed cria uma conversa nova a cada execução
    // (`e2e-escalacao-${Date.now()}`), então rodá-lo sempre deixaria lixo por corrida.
    if (!creds.escalacao) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-escalacao.ts"], { stdio: "inherit" });
      creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    }
    if (!creds.escalacao) {
      throw new Error(
        "bloco `escalacao` ausente em .e2e-creds.json mesmo depois de semear — " +
          "veja a saída de scripts/seed-e2e-escalacao.ts acima",
      );
    }
  });

  test("ciclo completo: chamado → decisão da pessoa → devolução → o agente volta citando", async ({
    page,
  }) => {
    const e = creds.escalacao;
    await login(page, creds.users.agent!.email, creds.password);

    // ---------------------------------------------------------------------
    // (1) O agente parou e abriu um chamado — a pessoa VÊ isso na tela dela.
    // ---------------------------------------------------------------------
    await page.goto("/app/ai/cases");
    const chamado = page.getByText(e.case_title, { exact: false }).first();
    await expect(chamado, "o chamado aberto pelo agente tem de aparecer na tela").toBeVisible({
      timeout: 30_000,
    });
    await captura(page, "01-chamado-na-fila");

    // ---------------------------------------------------------------------
    // (2) A pessoa decide, escrevendo o que combinou com o cliente.
    // ---------------------------------------------------------------------
    await chamado.click();
    // "Concluí" = a ação `resolved` (lib/ai/case-copy.ts). O rótulo é lido da
    // tela, não inventado aqui: se ele mudar, o teste reprova, que é o certo —
    // é a palavra que o atendente vê.
    await page.getByRole("radio", { name: /Concluí/ }).click();
    const campo = page.locator("textarea").first();
    await expect(campo).toBeVisible({ timeout: 15_000 });
    await campo.fill(DECISAO_DA_PESSOA);
    await page.getByRole("button", { name: /^Enviar$/ }).click();

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("agent_cases")
            .select("status")
            .eq("id", e.case_id)
            .maybeSingle();
          return (data as { status: string } | null)?.status ?? null;
        },
        { timeout: 30_000, message: "a decisão da pessoa tem de fechar o chamado" },
      )
      .toBe("resolved");
    await captura(page, "02-decisao-registrada");

    // Uma nota interna, o outro rastro que a volta precisa levar junto.
    await admin.from("conversation_notes").insert({
      organization_id: creds.org_id,
      conversation_id: e.conversation_id,
      body: NOTA_DO_ATENDENTE,
      created_by_user_id: e.attendant_user_id,
      created_by_name: "E2E Agent",
    });

    // ---------------------------------------------------------------------
    // (3) Na conversa, a tela DIZ que o automático está pausado e oferece a volta.
    // ---------------------------------------------------------------------
    await page.goto(`/app/inbox/${e.conversation_id}`);
    await expect(
      page.getByTestId("badge-atendimento-humano"),
      "conversa com o robô calado não pode ter a mesma cara de uma conversa normal",
    ).toBeVisible({ timeout: 30_000 });
    const botaoDevolver = page.getByTestId("devolver-ao-automatico");
    await expect(
      botaoDevolver,
      "a rota de devolver existia desde a IA-06 e nenhuma tela a chamava",
    ).toBeVisible();
    await captura(page, "03-automatico-pausado-com-porta-de-volta");

    // ---------------------------------------------------------------------
    // (4) A pessoa devolve o atendimento — e as TRÊS travas têm de sair.
    // ---------------------------------------------------------------------
    await botaoDevolver.click();

    await expect
      .poll(
        async () => {
          const { data: conv } = await admin
            .from("conversations")
            .select("bot_silenced_until, assignee_kind, assigned_to_user_id")
            .eq("id", e.conversation_id)
            .maybeSingle();
          const { data: contato } = await admin
            .from("contacts")
            .select("force_human")
            .eq("id", e.contact_id)
            .maybeSingle();
          return {
            silenciada: (conv as { bot_silenced_until: string | null } | null)?.bot_silenced_until,
            dono: (conv as { assigned_to_user_id: string | null } | null)?.assigned_to_user_id,
            kind: (conv as { assignee_kind: string | null } | null)?.assignee_kind,
            forcado: (contato as { force_human: boolean } | null)?.force_human,
          };
        },
        {
          timeout: 30_000,
          message:
            "soltar só o silêncio deixa o agente morto: force_human veta todo envio e o turno é NO-OP",
        },
      )
      .toEqual({ silenciada: null, dono: null, kind: "ai", forcado: false });

    await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0, { timeout: 20_000 });
    await captura(page, "04-devolvido-ao-automatico");

    // ---------------------------------------------------------------------
    // (5) A VOLTA na linha do tempo do negócio — a ida aparecia, a volta não.
    // ---------------------------------------------------------------------
    if (e.lead_id) {
      const { data: atividades } = await admin
        .from("crm_lead_activities")
        .select("type")
        .eq("organization_id", creds.org_id)
        .eq("lead_id", e.lead_id);
      const tipos = ((atividades ?? []) as Array<{ type: string }>).map((a) => a.type).sort();

      // EXATAMENTE estas duas. `toContain` sozinho passaria com uma linha de uma
      // corrida anterior — o seed limpa as atividades do negócio antes de
      // reabrir o episódio, e a igualdade exata é o que prova que a limpeza
      // funcionou E que ESTA corrida emitiu as duas pontas.
      expect(tipos, "a passagem tem duas pontas e as duas são vida do negócio").toEqual([
        "handoff_resolved",
        "handoff_triggered",
      ]);
    }

    // ---------------------------------------------------------------------
    // (6) O CRITÉRIO DA WAVE: o agente retoma SABENDO o que a pessoa fez.
    //     Lido pela função REAL que abre o turno, não por uma cópia daqui.
    // ---------------------------------------------------------------------
    const abertura = blocoDeAberturaDoTurno(creds.org_id, e.contact_id);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCIA, "05-abertura-do-turno.txt"), abertura);

    expect(
      abertura,
      "se a decisão da pessoa não está na abertura do turno, o agente volta cego — isso é roteamento, não continuidade",
    ).toContain(DECISAO_DA_PESSOA);
    expect(abertura, "a nota interna também é rastro do que a pessoa fez").toContain(
      NOTA_DO_ATENDENTE,
    );
    // E o que o agente já sabia ANTES não pode ter sido apagado para caber o novo.
    expect(
      abertura,
      "acrescentar o que a pessoa fez não pode apagar o histórico da conversa",
    ).toContain("Cliente quer 200 unidades");
  });
});
