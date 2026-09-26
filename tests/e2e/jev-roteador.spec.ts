/**
 * O JEV NO ROTEADOR, PELA TELA — "Testar classificação" com as duas escolhas.
 *
 * O e2e do CI não sobe o agent-worker, então nenhum turno do agente passa por
 * aqui (o caminho do turno é `tests/invariants/jev-roteador-no-turno.test.ts`).
 * O que a pessoa VÊ do Jev no roteador é o cartão, com as três tarefas, e a tela
 * "Testar classificação" do roteador, que roda a mesma pergunta dentro do Next
 * — e é por ela que esta spec prova a tarefa, contra o dublê HTTP do Jev
 * (`scripts/duble-jev-e2e.mjs`), com a escolha dele FORÇADA por
 * `DUBLE_JEV_RESPOSTAS`: sem isso o dublê escolheria a primeira opção, e a tela
 * mostraria o mesmo agente dos dois lados sem provar que lê a resposta dele.
 *
 * A chave e o "ligar" vão pela API da própria aplicação (sessão do admin): a
 * jornada deles pela tela é a `jev-decisoes-rapidas`. O roteador, os agentes e
 * o número são semeados pelo service role e apagados no fim.
 *
 * Precondições: `pnpm e2e:env` (JEV_API_BASE_URL apontando para a porta do
 * dublê, que esta spec sobe e derruba sozinha) e o app buildado.
 *
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/jev-roteador.spec.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, test } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import { abrirOCartao, credsDoJev, limparOJev } from "./helpers/jev";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const BASE_DO_JEV = process.env.JEV_API_BASE_URL ?? "";
/** A chave que o dublê aceita. Não é segredo: só vale para ele. */
const CHAVE_DO_DUBLE = "apikey_e2e_duble_do_jev_0123456789abcdef";
const ARQUIVO_DE_CHAMADAS = path.join(os.tmpdir(), `duble-jev-roteador-${process.pid}.json`);
const sufixo = String(Date.now()).slice(-6);
const FRASE = `Meu pedido ${sufixo} não chegou, me liga no 11 98765-4321`;
/** A escolha do Jev, forçada no dublê: a intenção "suporte", com 92%. */
const RESPOSTA_DO_JEV = {
  roteador: { type: "choice", choice: "suporte", confidence: 0.9, probabilities: { suporte: 0.92, vendas: 0.05, none: 0.03 } },
};

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

interface Chamada {
  metodo: string;
  caminho: string;
  corpo: { state?: unknown; questions?: Record<string, { type?: string; criteria?: Record<string, string> }> } | null;
}

let duble: ChildProcess | null = null;
let creds: CredsE2E;
let orgId = "";
const semeado = {
  sessao: randomUUID(),
  roteador: randomUUID(),
  vendas: randomUUID(),
  suporte: randomUUID(),
  /** A credencial da "IA de sempre" que esta spec cadastra (vazia até o passo que a cria). */
  iaDeSempre: "",
};

function chamadasAoJev(): Chamada[] {
  if (!fs.existsSync(ARQUIVO_DE_CHAMADAS)) return [];
  return (JSON.parse(fs.readFileSync(ARQUIVO_DE_CHAMADAS, "utf8")) as Chamada[]).filter(
    (c) => c.metodo === "POST" && c.caminho === "/v1/systemone",
  );
}

async function ok<T>(p: PromiseLike<{ error: { message: string } | null; data?: T }>, oQue: string): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${oQue}: ${error.message}`);
}

/** Um número só deste teste, com um roteador ATIVO e duas intenções, cada uma com o seu agente publicado. */
async function semearORoteador(): Promise<void> {
  await ok(
    admin.from("channel_sessions").insert({
      id: semeado.sessao,
      organization_id: orgId,
      waha_session_name: `e2e-jev-roteador-${sufixo}`,
      display_name: "Número do roteador do Jev",
      webhook_secret_encrypted: "\\x00",
    } as never),
    "semear o número",
  );
  for (const [id, nome] of [
    [semeado.vendas, `Vendas Jev ${sufixo}`],
    [semeado.suporte, `Suporte Jev ${sufixo}`],
  ] as const) {
    const versao = randomUUID();
    await ok(
      admin.from("ai_agents").insert({ id, organization_id: orgId, name: nome, system_prompt: "você atende", kind: "mcp_agent" } as never),
      `semear o agente ${nome}`,
    );
    await ok(
      admin.from("ai_agent_versions").insert({
        id: versao,
        organization_id: orgId,
        agent_id: id,
        version_number: 1,
        system_prompt: "você atende",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        channel_session_id: semeado.sessao,
        status: "published",
        published_at: new Date().toISOString(),
      } as never),
      `publicar o agente ${nome}`,
    );
    await ok(admin.from("ai_agents").update({ published_version_id: versao } as never).eq("id", id), `apontar ${nome}`);
  }
  await ok(
    admin.from("ai_routers").insert({
      id: semeado.roteador,
      organization_id: orgId,
      name: `Roteador do Jev ${sufixo}`,
      channel_session_id: semeado.sessao,
      is_active: true,
      config: { sticky: true, min_confidence: 0.6 },
    } as never),
    "semear o roteador",
  );
  await ok(
    admin.from("ai_router_members").insert([
      {
        organization_id: orgId,
        router_id: semeado.roteador,
        agent_id: semeado.vendas,
        intent_name: "vendas",
        intent_description: "Quer comprar um produto",
        examples: ["quanto custa"],
        position: 0,
      },
      {
        organization_id: orgId,
        router_id: semeado.roteador,
        agent_id: semeado.suporte,
        intent_name: "suporte",
        intent_description: "Tem um problema com um pedido",
        examples: [],
        position: 1,
      },
    ] as never),
    "semear as intenções",
  );
}

async function apagarORoteador(): Promise<void> {
  // Nesta ordem: o roteador leva as intenções; os agentes levam as versões; e só
  // então o número, que as versões apontam.
  if (semeado.iaDeSempre) {
    await ok(
      admin.from("ai_provider_credentials").delete().eq("id", semeado.iaDeSempre),
      "apagar a IA de sempre",
    );
  }
  await ok(admin.from("ai_routers").delete().eq("id", semeado.roteador), "apagar o roteador");
  await ok(admin.from("ai_agents").delete().in("id", [semeado.vendas, semeado.suporte]), "apagar os agentes");
  await ok(admin.from("channel_sessions").delete().eq("id", semeado.sessao), "apagar o número");
}

test.describe("Jev no roteador — Testar classificação, pela tela", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    let alvo: URL;
    try {
      alvo = new URL(BASE_DO_JEV);
    } catch {
      throw new Error("JEV_API_BASE_URL ausente no ambiente do teste. Rode `pnpm e2e:env`.");
    }
    expect(alvo.hostname, "o Jev da suíte tem de apontar para o dublê local").toBe("127.0.0.1");

    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    duble = spawn(process.execPath, ["scripts/duble-jev-e2e.mjs"], {
      env: {
        ...process.env,
        DUBLE_JEV_PORTA: alvo.port,
        DUBLE_JEV_HOST: alvo.hostname,
        DUBLE_JEV_CHAVE: CHAVE_DO_DUBLE,
        DUBLE_JEV_ARQUIVO: ARQUIVO_DE_CHAMADAS,
        DUBLE_JEV_RESPOSTAS: JSON.stringify(RESPOSTA_DO_JEV),
      },
      stdio: "inherit",
    });
    await expect
      .poll(
        async () => {
          try {
            const r = await fetch(`${BASE_DO_JEV}/__duble/saude`);
            return ((await r.json()) as { arquivo?: string }).arquivo ?? null;
          } catch {
            return null;
          }
        },
        { timeout: 15_000, message: "o dublê do Jev não subiu (porta ocupada?)" },
      )
      .toBe(ARQUIVO_DE_CHAMADAS);
    creds = lerCreds();
  });

  test.afterAll(async () => {
    duble?.kill("SIGTERM");
    fs.rmSync(ARQUIVO_DE_CHAMADAS, { force: true });
    if (orgId) {
      await apagarORoteador();
      await limparOJev(orgId);
    }
  });

  test("[P1] o cartão lista as três tarefas, e Testar classificação mostra a escolha do Jev ao lado da sua IA", async ({
    page,
  }) => {
    creds = await loginComoAdmin(page, creds);
    orgId = credsDoJev().orgId;
    await limparOJev(orgId);
    await semearORoteador();

    // A PRÉ-CONDIÇÃO "a empresa tem IA de sempre" é desta spec, não de quem roda
    // antes dela. Sem uma chave de conversa VALIDADA e decifrável, o cartão fica
    // "sozinho" (o Jev decide o clima sem com quem comparar), e o "observando" que
    // esta spec afirma nunca aparece — medido rodando a spec sozinha e também
    // depois do seed de follow-up, cuja credencial nasce sem validação e com bytes
    // de enfeite no lugar da chave. A chave é falsa (o CI não tem IA): cadastrada
    // pela rota real, ela fica cifrada de verdade; o teste de fundo a recusa, e
    // só DEPOIS de ele terminar a validação é marcada à mão — senão o resultado
    // dele sobrescreveria a marca. A mesma chave falsa é a "sua IA" que "não
    // respondeu" no Testar classificação. O provedor é o da organização do seed
    // (anthropic): a IA de sempre é a do provedor que a empresa escolheu.
    await test.step("a IA de sempre da empresa: uma chave de conversa cadastrada e validada", async () => {
      const criou = await page.request.post("/api/v1/ai/credentials", {
        data: {
          provider: "anthropic",
          label: `IA de sempre ${sufixo}`,
          api_key: "sk-ant-e2e-ia-de-sempre-0000000000000000000000",
        },
      });
      expect(criou.status(), "a IA de sempre não foi cadastrada").toBe(201);
      semeado.iaDeSempre = ((await criou.json()) as { data: { id: string } }).data.id;
      await expect(async () => {
        const { data } = await admin
          .from("ai_provider_credentials")
          .select("validated_at, validation_error")
          .eq("id", semeado.iaDeSempre)
          .single();
        const linha = data as { validated_at: string | null; validation_error: string | null } | null;
        expect(linha?.validation_error ?? linha?.validated_at, "o teste de fundo da chave ainda não terminou").toBeTruthy();
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
      await ok(
        admin
          .from("ai_provider_credentials")
          .update({ validated_at: new Date().toISOString(), validation_error: null } as never)
          .eq("id", semeado.iaDeSempre),
        "marcar a IA de sempre como validada",
      );
    });

    await test.step("a chave do dublê, testada, e o Jev ligado com o aceite", async () => {
      const criou = await page.request.post("/api/v1/ai/credentials", {
        data: { provider: "typesafe", label: "Jev do roteador", api_key: CHAVE_DO_DUBLE },
      });
      expect(criou.status(), "a chave não foi cadastrada").toBe(201);
      // O teste da chave roda depois da resposta: espera ele passar.
      await expect(async () => {
        const r = await page.request.get("/api/v1/ai/jev");
        expect(((await r.json()) as { data: { chave: { validada: boolean } } }).data.chave.validada).toBe(true);
      }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
      const ligou = await page.request.patch("/api/v1/ai/jev", { data: { ligado: true, aceite_lgpd: true } });
      expect(ligou.status(), "o Jev não ligou").toBe(200);
    });

    await test.step("o cartão: três tarefas, e a do roteador nova, só observando (R7)", async () => {
      const cartao = await abrirOCartao(page);
      // Recém-ligado com a IA de sempre cadastrada (a do seed, de chave falsa): observando.
      await expect(cartao).toHaveAttribute("data-estado", "observando");
      await expect(cartao.getByTestId("jev-tarefa-clima")).toBeVisible();
      await expect(cartao.getByTestId("jev-tarefa-manipulacao")).toBeVisible();
      const roteador = cartao.getByTestId("jev-tarefa-roteador");
      await expect(roteador).toHaveAttribute("data-estado", "observando");
      await expect(roteador).toContainText("Escolher qual agente atende");
      await expect(roteador).toContainText("Só observa");
      // "Nova", e com o que ela quer dizer: o selo sozinho não explicava nada.
      await expect(roteador).toContainText("Nova");
      await expect(cartao.getByTestId("jev-nova-roteador")).toContainText("nada muda para o cliente");
      // Há roteador ativo: a tarefa roda, e não aparece "Não roda".
      await expect(cartao.getByTestId("jev-sem-roteador-roteador")).toHaveCount(0);
      await page.screenshot({ path: ".superpowers/evidence/jev/cartao-tres-tarefas.png", fullPage: true });
    });

    await test.step("Testar classificação: a sua IA e o Jev, lado a lado", async () => {
      await page.goto(`/app/ai/routers/${semeado.roteador}`);
      await page.getByPlaceholder("Ex.: oi, quero saber o preço do plano premium").fill(FRASE);
      const [resposta] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`/api/v1/ai/routers/${semeado.roteador}/test`)),
        page.getByRole("button", { name: "Testar classificação" }).click(),
      ]);
      expect(resposta.status(), "o teste do roteador foi recusado").toBe(200);

      const lado = page.getByTestId("teste-com-o-jev");
      await expect(lado).toBeVisible();
      // A escolha FORÇADA no dublê — o nome do agente vem do banco, a porcentagem da resposta dele.
      const doJev = page.getByTestId("teste-escolha-do-jev");
      await expect(doJev).toContainText(`Suporte Jev ${sufixo}`);
      await expect(doJev).toContainText("suporte · 92%");
      // O lado da sua IA está na tela (no CI a chave dela é falsa: ela "não respondeu").
      await expect(page.getByTestId("teste-escolha-da-ia")).toBeVisible();
      // Observando: em produção vale a escolha da sua IA, não a do Jev.
      await expect(page.getByTestId("teste-quem-decide")).toContainText("só observa");
      await expect(page.getByTestId("teste-agente-que-atenderia")).not.toContainText(`Suporte Jev ${sufixo}`);
      await page.screenshot({ path: ".superpowers/evidence/jev/roteador-testar-classificacao.png", fullPage: true });
    });

    await test.step("o dublê recebeu SÓ a frase, sem o telefone, e só a pergunta do roteador", async () => {
      const chamada = chamadasAoJev().find((c) => String(c.corpo?.state ?? "").includes(`Meu pedido ${sufixo}`));
      expect(chamada, "o Jev não foi perguntado").toBeDefined();
      expect(Object.keys(chamada!.corpo?.questions ?? {})).toEqual(["roteador"]);
      expect(chamada!.corpo?.questions?.roteador?.type).toBe("choice");
      expect(Object.keys(chamada!.corpo?.questions?.roteador?.criteria ?? {})).toEqual(["vendas", "suporte", "none"]);
      expect(String(chamada!.corpo?.state)).not.toContain("98765-4321");
    });

    await test.step("sem observação gravada (R5), mas com o custo em Execuções (R8)", async () => {
      const { count: observacoes, error: erroObs } = await admin
        .from("jev_observacoes")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("tarefa", "roteador");
      expect(erroObs).toBeNull();
      expect(observacoes).toBe(0);
      const { count: custos, error: erroCusto } = await admin
        .from("llm_calls")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("provider", "typesafe")
        .eq("purpose", "intent_router")
        .eq("status", "ok");
      expect(erroCusto).toBeNull();
      expect(custos).toBeGreaterThanOrEqual(1);
    });
  });
});
