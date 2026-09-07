/**
 * O RELÓGIO HTTP, BATIDO POR UM CRON EXTERNO DE VERDADE.
 *
 * Item 2 da issue #366, declarado como NÃO MEDIDO quando o #365 foi mergeado:
 * *"o runbook está escrito e o workflow nasce desligado, mas ninguém observou
 * uma batida vinda de fora chegando na rota e fazendo o follow-up andar."*
 *
 * ## Por que isto não podia continuar sem prova
 *
 * Para quem **não tem** o `scheduler` da VPS — o plano gratuito da Vercel é o
 * caso comum, e é o cenário inteiro do runbook `vercel-hobby-relogio.md` — o
 * relógio externo não é conveniência: é o **único** motor do follow-up. E a
 * falha dele é silenciosa: os follow-ups simplesmente não andam, ninguém recebe
 * erro, e a instalação parece saudável.
 *
 * O que existia era `tests/unit/relogio-hobby-workflow.test.ts`, e ele mede
 * TEXTO — que o `.yml` cita o caminho do tick, a variável e o `exit 1`. Isso
 * ancora o contrato do arquivo e não prova que uma batida faz alguma coisa.
 * Nenhum teste, em lugar nenhum, chegava a bater na rota.
 *
 * ## O emissor é externo de propósito — `curl`, não `page.request`
 *
 * A doutrina de QA Visual pede receiver/emissor **real**, não mock. Aqui o
 * emissor é `execFileSync("curl", …)`: outro processo, sem o contexto do
 * browser, sem cookie, sem nada do Playwright — que é literalmente o comando
 * que `comandoCurlDoRelogio()` gera e que o runbook manda colar no
 * cron-job.org. `page.request` compartilharia o contexto do teste e provaria
 * menos: a rota está em `PUBLIC_PATHS` justamente porque quem a chama não tem
 * sessão nenhuma.
 *
 * ## Os dois sentidos, e por que o caso da recusa mede EFEITO
 *
 * Um teste que só afirmasse `403` no segredo errado passaria igual se a rota
 * respondesse 403 **e executasse o tick assim mesmo** — o código de status é
 * um sintoma, não a propriedade. Por isso o caso 1 confere que o enrollment
 * continua exatamente onde estava; e é ele que dá sentido ao caso 2, porque
 * prova que o avanço observado lá veio da batida autorizada, e não de qualquer
 * outra coisa mexendo no banco.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3041 pnpm exec playwright test tests/e2e/relogio-http-cron-externo.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CAMINHO_DO_TICK } from "../../lib/relogio/tarefas";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
}

const env = carregarEnvLocal();
const admin: SupabaseClient = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function segredoInterno(): string {
  const s = env.INTERNAL_SECRET?.trim();
  if (!s) throw new Error("INTERNAL_SECRET não encontrado no ambiente de teste");
  return s;
}

/**
 * A batida, como o cron externo a faz: processo separado, HTTP de verdade.
 *
 * `-o /dev/null -w %{http_code}` em vez de `-f`: o `-f` do runbook faz o curl
 * sair com erro em 4xx, o que é o certo LÁ (o Actions tem de ficar vermelho se
 * o tick não passou) e aqui atrapalharia — o caso da recusa precisa LER o 403,
 * não morrer nele.
 */
function baterNoRelogio(segredo: string): number {
  const saida = execFileSync(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${segredo}`,
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `${APP_URL}${CAMINHO_DO_TICK}`,
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
  return Number.parseInt(saida.trim(), 10);
}

/** Fluxo mínimo: espera → fim. Um enrollment vencido em `w1` deve chegar em `e1`. */
const GRAFO_MINIMO = {
  nodes: [
    {
      id: "w1",
      type: "wait",
      label: "Espera",
      position: { x: 0, y: 0 },
      // 300_000 é o MÍNIMO que `graph-schema.ts` aceita (`too_small` abaixo
      // disso) — regra de produto anti-ban, não número escolhido aqui. Foi
      // medido: com `duration_ms: 1` o tick devolve `failed: 1` e o enrollment
      // nem sai do lugar.
      config: { mode: "fixed", duration_ms: 300_000 },
    },
    {
      id: "e1",
      type: "end",
      label: "Fim",
      position: { x: 0, y: 0 },
      config: { outcome: "converted" },
    },
  ],
  edges: [{ id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const marca = Date.now();
let orgId = "";
let enrollmentId = "";

interface LinhaDoEnrollment {
  current_node_id: string;
  status: string;
  steps_taken: number;
  next_eval_at: string | null;
}

async function lerEnrollment(): Promise<LinhaDoEnrollment> {
  const { data, error } = await admin
    .from("followup_enrollments")
    .select("current_node_id, status, steps_taken, next_eval_at")
    .eq("id", enrollmentId)
    .single();
  if (error) throw new Error(`leitura do enrollment falhou: ${error.message}`);
  return data as LinhaDoEnrollment;
}

async function semear<T>(tabela: string, linha: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin
    .from(tabela)
    .insert(linha as never)
    .select("id")
    .single();
  if (error) throw new Error(`insert em ${tabela} falhou: ${error.message}`);
  return data as T;
}

test.describe("Relógio HTTP — a batida de um cron externo faz o follow-up andar", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    orgId = creds.org_id;

    const contato = await semear<{ id: string }>("contacts", {
      organization_id: orgId,
      display_name: `Relógio E2E ${marca}`,
    });
    const versao = await semear<{ id: string }>("followup_flow_versions", {
      organization_id: orgId,
      graph: GRAFO_MINIMO,
    });
    const ponteiro = await semear<{ id: string }>("followup_flow_pointers", {
      organization_id: orgId,
      name: `Relógio E2E ${marca}`,
      status: "active",
      active_version_id: versao.id,
      handoff_policy: "pause",
      trigger_config: { kind: "manual" },
    });

    // VENCIDO: `next_eval_at` no passado é a condição que
    // `fn_claim_due_followup_enrollments` usa. Sem relógio nenhum batendo, esta
    // linha fica parada para sempre — que é exatamente o defeito silencioso que
    // este arquivo existe para vigiar.
    // A FRONTEIRA DO ATENDIMENTO, aberta pelo MESMO caminho da produção.
    //
    // Esta fixture nasceu antes da fronteira e semeava a linha sem
    // `service_boundary`. O motor passou a exigi-la — e com razão: rodar um
    // acompanhamento sem saber a QUAL atendimento ele pertence é como o
    // follow-up volta a falar por cima de uma conversa que já virou outra. Todo
    // caminho de produção carimba (`lib/followup/enroll.ts` e os dois INSERT em
    // SQL de `fn_appointment_recover`), então a linha sem carimbo era um estado
    // que o produto não cria — e o teste media um mundo que não existe.
    //
    // `fn_service_begin` é o que `beginServiceAtOrigin` chama; usar o RPC em vez
    // de montar o objeto à mão faz a fixture herdar a forma real, inclusive se
    // ela mudar.
    const { data: fronteiraBruta, error: erroFronteira } = await admin.rpc("fn_service_begin", {
      p_org: orgId,
      p_contact: contato.id,
    });
    if (erroFronteira) throw new Error(`fn_service_begin: ${erroFronteira.message}`);
    const bruta = fronteiraBruta as Record<string, unknown>;
    const fronteira = {
      organization_id: bruta.organization_id,
      contact_id: bruta.contact_id,
      conversation_id: bruta.conversation_id,
      service_revision: bruta.service_revision,
      demanda_id: bruta.demanda_id,
      demanda_revision: bruta.demanda_revision,
    };

    const enrollment = await semear<{ id: string }>("followup_enrollments", {
      organization_id: orgId,
      pointer_id: ponteiro.id,
      version_id: versao.id,
      contact_id: contato.id,
      conversation_id: fronteira.conversation_id,
      service_boundary: fronteira,
      current_node_id: "w1",
      status: "active",
      next_eval_at: new Date(Date.now() - 60_000).toISOString(),
    });
    enrollmentId = enrollment.id;
  });

  test.afterAll(async () => {
    // Só o que este arquivo criou. O tick é global por natureza — ele roda as
    // tarefas de minuto da instalação inteira —, então apagar por org apagaria
    // fixture das outras specs, que compartilham esta mesma organização.
    if (enrollmentId) await admin.from("followup_enrollments").delete().eq("id", enrollmentId);
    await admin.from("followup_flow_pointers").delete().eq("name", `Relógio E2E ${marca}`);
    await admin.from("contacts").delete().eq("display_name", `Relógio E2E ${marca}`);
  });

  test("segredo errado é recusado — e o relógio NÃO anda", async () => {
    const antes = await lerEnrollment();
    expect(antes.current_node_id, "pré-condição: o enrollment começa parado no nó de espera").toBe(
      "w1",
    );

    const codigo = baterNoRelogio("segredo-errado-de-proposito");
    expect(codigo, "batida sem o segredo certo tem de ser recusada").toBe(403);

    // ⚠️ O 403 é SINTOMA, não a propriedade. Uma rota que respondesse 403 e
    // rodasse o tick assim mesmo passaria numa asserção só de status.
    const depois = await lerEnrollment();
    expect(
      depois,
      "a batida foi recusada mas o follow-up andou — a recusa não está protegendo nada",
    ).toEqual(antes);
  });

  test("⭐ com o segredo certo, as batidas movem o enrollment até o fim", async () => {
    /**
     * DUAS batidas, e não uma — e isso não é contorno, é o ciclo real.
     *
     * A primeira versão deste caso esperava avanço numa batida só, e o run
     * devolveu `{claimed:1, advanced:0, scheduled:1}`: um enrollment vencido
     * PARADO num nó `wait` significa "chegou a hora de EXECUTAR o wait", e
     * executar um wait é agendar a espera. O avanço para o nó seguinte só
     * acontece na batida DEPOIS do prazo.
     *
     * Isso é o comportamento certo, e é literalmente o que um cron externo faz:
     * bate a cada poucos minutos, e o fluxo anda um passo por vez. Provar com
     * uma batida só teria provado menos.
     *
     * O relógio do FIXTURE é adiantado entre as duas, porque o mínimo do `wait`
     * é 5 minutos por regra de produto e o CI não vai esperar 5 minutos. As
     * duas transições continuam sendo do motor — o teste não escreve
     * `current_node_id` nenhum, só antecipa o vencimento, que é o que o tempo
     * faria sozinho.
     */
    const inicial = await lerEnrollment();
    expect(inicial.current_node_id, "ainda parado depois da batida recusada").toBe("w1");

    // ── batida 1: executa o `wait` e AGENDA a espera ──────────────────────
    expect(baterNoRelogio(segredoInterno()), "a batida autorizada tem de ser aceita").toBe(200);

    const agendado = await lerEnrollment();
    expect(agendado.steps_taken, "a primeira batida não executou o nó de espera").toBeGreaterThan(
      inicial.steps_taken,
    );
    expect(agendado.current_node_id, "o wait ainda não venceu — não pode ter avançado").toBe("w1");
    expect(
      new Date(agendado.next_eval_at ?? 0).getTime(),
      "a espera não foi agendada para o futuro",
    ).toBeGreaterThan(Date.now());

    // ── o tempo passa (o cron externo bate de novo, minutos depois) ───────
    const { error } = await admin
      .from("followup_enrollments")
      .update({ next_eval_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", enrollmentId);
    if (error) throw new Error(`adiantar o relógio do fixture falhou: ${error.message}`);

    // ── batida 2: agora sim, AVANÇA ──────────────────────────────────────
    expect(baterNoRelogio(segredoInterno()), "a segunda batida tem de ser aceita").toBe(200);

    // O que se mede é o EFEITO no banco, não o corpo da resposta: um tick que
    // responda 200 sem fazer nada é justamente a falha silenciosa que deixa o
    // follow-up parado numa instalação sem `scheduler`.
    const final = await lerEnrollment();
    expect(final.current_node_id, "o fluxo não chegou ao nó final").toBe("e1");
    expect(final.steps_taken, "o segundo passo não foi contado").toBeGreaterThan(
      agendado.steps_taken,
    );
  });
});
