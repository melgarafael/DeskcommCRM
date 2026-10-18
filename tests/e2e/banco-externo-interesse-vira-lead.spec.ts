/**
 * Spec 25, fatia R5 — o apartamento: quem se interessa vira lead no funil.
 *
 * PROVA EM PAR (docs/doctrine/prova-em-par.md). O par e a unidade:
 *   - pela TELA: o admin configura o "Funil de destino" da receita de imoveis,
 *     salva, recarrega, e o cartao diz "Leads vao para: <funil> > <etapa>";
 *   - pela FERRAMENTA (direto, o mesmo `crm_registrar_interesse_no_item` que o
 *     agente chama): com o MESMO pedido ("apartamento 2 quartos no Centro", item
 *     4821) nasce UM lead no funil escolhido, com a referencia `acf-imoveis:4821`
 *     na descricao; o segundo interesse no mesmo item NAO duplica; e a tela do
 *     funil mostra o card.
 *
 * O QUE ESTA SPEC NAO FAZ, e por que (declarado, nao escondido):
 *   - nao sobe MySQL/WordPress: o e2e fresco nao tem banco de origem (a R1 ja
 *     declara isso). O resultado da consulta que o agente teria visto entra no
 *     registro do turno (`ItensDaReceitaNoTurno.registrar`) com a MESMA forma que
 *     `crm_consultar_receita` devolve; a consulta em si e provada em
 *     `tests/mysql/receita-acf-imoveis.test.ts`.
 *   - nao ha duble de MODELO para agente nos e2e do repositorio (`git grep dubl
 *     tests/e2e`: so Stripe/Asaas/Resend/Jev). Portanto o lado "pelo agente,
 *     conversando" NAO esta coberto aqui: o par fica com a tela + a ferramenta.
 *
 * Pre-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/banco-externo-interesse-vira-lead.spec.ts
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { test, expect } from "./helpers/test";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

test.describe.configure({ timeout: 120_000, mode: "serial" });
test.use({ viewport: { width: 1600, height: 900 } });

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const CHAVE_MODULO = "MODULO_BANCO_EXTERNO";
const ESPERA = 30_000;
const sufixo = Date.now().toString(36).slice(-4);
const NOME_DO_FUNIL = `Imoveis E2E ${sufixo}`;
const NOME_DA_ETAPA = `Interessado ${sufixo}`;
const TITULO = "Apartamento 2 quartos no Centro";
const REFERENCIA = "acf-imoveis:4821";

let creds: CredsE2E;
let orgId: string;
let conexaoId: string;
let funilId: string;
let etapaId: string;
let contatoId: string;
let instanciaId: string;
let moduloAntes: string | null = null;

test.beforeAll(async () => {
  creds = lerCreds();

  const modulo = await db.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).maybeSingle();
  if (modulo.error) throw modulo.error;
  moduloAntes = (modulo.data?.valor as string | null) ?? null;
  const ligar = await db
    .from("platform_config")
    .upsert({ chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
  if (ligar.error) throw ligar.error;

  const org = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  if (org.error ?? !org.data) throw org.error ?? new Error('organizacao "e2e-test-org" nao encontrada');
  orgId = (org.data as { id: string }).id;

  const funil = await db
    .from("crm_pipelines")
    .insert({ organization_id: orgId, name: NOME_DO_FUNIL, slug: `imoveis-e2e-${sufixo}` })
    .select("id")
    .single();
  if (funil.error ?? !funil.data) throw funil.error ?? new Error("nao semeou o funil");
  funilId = (funil.data as { id: string }).id;

  const etapa = await db
    .from("crm_stages")
    .insert({ organization_id: orgId, pipeline_id: funilId, name: NOME_DA_ETAPA, slug: `interessado-${sufixo}`, position: 1000 })
    .select("id")
    .single();
  if (etapa.error ?? !etapa.data) throw etapa.error ?? new Error("nao semeou a etapa");
  etapaId = (etapa.data as { id: string }).id;

  const contato = await db
    .from("contacts")
    .insert({ organization_id: orgId, name: `Cliente E2E ${sufixo}`, phone_number: `+5511${Date.now().toString().slice(-9)}` })
    .select("id")
    .single();
  if (contato.error ?? !contato.data) throw contato.error ?? new Error("nao semeou o contato");
  contatoId = (contato.data as { id: string }).id;

  instanciaId = randomUUID();
  const conexao = await db
    .from("external_db_connections")
    .insert({
      organization_id: orgId,
      label: `Conexao E2E interesse ${sufixo}`,
      host: "banco.exemplo.invalid",
      port: 3306,
      database_name: "e2e",
      username: "leitor",
      password_encrypted: "\\x00",
      password_iv: "\\x00",
      password_tag: "\\x00",
      ssl_mode: "require",
      enabled: true,
      db_type: "mysql",
      receitas: [
        {
          id: instanciaId,
          receita: "acf-imoveis",
          rotulo: "Imoveis do site",
          descricao: "Imoveis publicados com ACF",
          fixos: { prefixo: "wp_", post_type: "imovel", campos: { preco: "preco", quartos: "quartos", bairro: "bairro" } },
          ativa: true,
        },
      ],
    })
    .select("id")
    .single();
  if (conexao.error ?? !conexao.data) throw conexao.error ?? new Error("nao semeou a conexao");
  conexaoId = (conexao.data as { id: string }).id;
});

test.afterAll(async () => {
  await db.from("crm_lead_activities").delete().eq("contact_id", contatoId);
  await db.from("crm_leads").delete().eq("contact_id", contatoId);
  await db.from("agent_inbox_items").delete().eq("ref_id", contatoId);
  await db.from("contacts").delete().eq("id", contatoId);
  await db.from("external_db_connections").delete().eq("id", conexaoId);
  await db.from("crm_stages").delete().eq("id", etapaId);
  await db.from("crm_pipelines").delete().eq("id", funilId);
  if (moduloAntes === null) {
    await db.from("platform_config").delete().eq("chave", CHAVE_MODULO);
  } else {
    await db
      .from("platform_config")
      .upsert({ chave: CHAVE_MODULO, valor: moduloAntes, eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
  }
});

test("TELA: o admin escolhe o funil de destino da receita e ele persiste", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`/app/integracao-dados/${conexaoId}`);

  // Antes: sem destino, o cartao avisa que o interesse vira aviso na Central.
  await expect(page.getByText(/Sem funil de destino: interesse vira aviso na Central/i)).toBeVisible({ timeout: ESPERA });

  await page.getByRole("button", { name: /^editar$/i }).click();
  await page.getByLabel("Funil", { exact: true }).selectOption({ label: NOME_DO_FUNIL });
  await page.getByLabel(/etapa de destino/i).selectOption({ label: NOME_DA_ETAPA });
  await page.getByRole("button", { name: /^salvar$/i }).click();
  await expect(page.getByText("Salvo.")).toBeVisible({ timeout: ESPERA });

  await page.reload();
  await expect(page.getByText(`${NOME_DO_FUNIL} › ${NOME_DA_ETAPA}`)).toBeVisible({ timeout: ESPERA });

  // Controle no banco: o destino gravado e exatamente o escolhido na tela.
  const linha = await db.from("external_db_connections").select("receitas").eq("id", conexaoId).single();
  const gravada = (linha.data!.receitas as Array<{ destino?: { pipeline_id: string; stage_id: string } }>)[0]!;
  expect(gravada.destino).toEqual({ pipeline_id: funilId, stage_id: etapaId });
});

test("FERRAMENTA: o mesmo pedido cria UM lead com a referencia, e o segundo interesse nao duplica", async ({ page }) => {
  // Importacao tardia: o modulo le o ambiente do servidor ao carregar.
  const { crmRegistrarInteresseNoItem } = await import("@/lib/mcp/tools/interesse-em-item");
  const { ItensDaReceitaNoTurno } = await import("@/lib/external-db/receitas/itens-do-turno");

  // O que `crm_consultar_receita` devolveria para "apartamento 2 quartos no Centro".
  const itens = new ItensDaReceitaNoTurno();
  itens.registrar({
    instancia: { id: instanciaId },
    linhas: [{ id: 4821, titulo: TITULO, preco: 480000, imagem_url: null }],
  });
  const ctx = {
    organizationId: orgId,
    role: "ai_operator",
    actor: { type: "ai_agent", id: randomUUID(), agent_id: null },
    apiTokenId: randomUUID(),
    requestId: randomUUID(),
    supabase: db,
    contatoDoTurno: contatoId,
    itensDaReceitaNoTurno: itens,
  } as never;

  const primeira = (await crmRegistrarInteresseNoItem.handler({ instancia_id: instanciaId, item_id: "4821" }, ctx)) as {
    resultado: string;
  };
  expect(primeira.resultado).toBe("lead_criado");

  // Outro turno (registro novo), mesmo contato e mesmo item: atualiza, nao duplica.
  const itens2 = new ItensDaReceitaNoTurno();
  itens2.registrar({ instancia: { id: instanciaId }, linhas: [{ id: 4821, titulo: TITULO, preco: 480000 }] });
  const segunda = (await crmRegistrarInteresseNoItem.handler(
    { instancia_id: instanciaId, item_id: "4821" },
    { ...(ctx as object), itensDaReceitaNoTurno: itens2 } as never,
  )) as { resultado: string };
  expect(segunda.resultado).toBe("interesse_repetido");

  const leads = await db
    .from("crm_leads")
    .select("id, source, pipeline_id, stage_id, contact_id, description")
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId);
  expect(leads.data).toHaveLength(1);
  expect(leads.data![0]).toMatchObject({ source: "external", pipeline_id: funilId, stage_id: etapaId });
  expect(leads.data![0]!.description).toContain(`[ref:${REFERENCIA}]`);

  const notas = await db.from("crm_lead_activities").select("reason").eq("lead_id", leads.data![0]!.id).eq("type", "note");
  expect(notas.data!.map((n) => n.reason).join(" | ")).toContain(TITULO);
  expect(notas.data!.map((n) => n.reason).join(" | ")).toMatch(/Interesse repetido/);

  // E a tela do funil mostra o card.
  await loginComoAdmin(page, creds);
  await page.goto(`/app/pipelines/${funilId}`);
  await expect(page.getByText(new RegExp(`Interesse: ${TITULO}`))).toBeVisible({ timeout: ESPERA });
});
