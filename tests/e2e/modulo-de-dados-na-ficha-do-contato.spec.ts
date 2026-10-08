import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * A ONDA 1 DA ADR-0005, PELA TELA: o que um módulo de dados guarda sobre uma pessoa aparece na
 * ficha dela, com os nomes que o AUTOR do módulo escolheu.
 *
 * Por que esta spec existe, e o que ela cobre que nenhum invariante cobre: o compilador, a rota e o
 * componente têm prova própria (banco real, contrato HTTP e render). Nenhuma delas responde a
 * pergunta do critério de aceite — "um leigo abre a ficha do paciente e VÊ o odontograma?". É o que
 * se mede aqui, dirigindo o browser.
 *
 * ─── O que esta spec NÃO cobre, de propósito ──────────────────────────────────────────────────
 *
 * A ADMISSÃO do pacote pelo catálogo (download com guarda de SSRF, parser estrito, recibo, 2FA do
 * administrador da instalação) é o caminho de `extensoes-declarativas.spec.ts`, que já o exercita de
 * ponta a ponta com um catálogo HTTP de ensaio. Repetir aquilo aqui mediria duas vezes a mesma coisa
 * e deixaria esta spec três vezes mais lenta. Aqui o módulo é SEMEADO no banco pelo mesmo caminho
 * que as fixtures das outras specs usam — artefato + instalação —, e o que se prova é a TELA.
 *
 * ─── Os dois casos, e por que o segundo é o que importa ───────────────────────────────────────
 *
 * 1. A ficha mostra o painel com o rótulo do autor e os valores, com dinheiro formatado.
 * 2. Com o módulo REMOVIDO, o painel desaparece e a ficha segue inteira. É o não-negociável 1 da
 *    doutrina de extensões medido no lugar onde ele seria furado primeiro: uma tela do núcleo que
 *    depende de um módulo de terceiro para funcionar.
 */

const ESPERA = 20_000;
const OBJETO = "marcacao";
const ROTULO = "Odontograma";

/**
 * Um publicador POR TESTE. O segundo caso reinstalava o mesmo pacote e versão do primeiro, e
 * `fn_extensions_prepare_install` recusou com `extension_version_changed` — corretamente: trocar o
 * conteúdo de uma versão já publicada é adulteração, e a instalação existe para impedir isso.
 *
 * Sufixo fixo por teste (não aleatório) para a tabela ser previsível no diagnóstico, e porque o
 * banco do e2e nasce limpo em cada rodada.
 */
function identidade(sufixo: string) {
  const publicador = `clinicae2e${sufixo}`;
  const modulo = "odontograma";
  return { publicador, modulo, tabela: `m_${publicador}_${modulo}_${OBJETO}` };
}

function lerCreds(): {
  org_id: string;
  password: string;
  users: Record<string, { id?: string; email: string }>;
} {
  const caminho = path.join(process.cwd(), ".e2e-creds.json");
  return JSON.parse(fs.readFileSync(caminho, "utf8"));
}

function banco(): SupabaseClient {
  const { url, serviceRole } = credenciaisSupabaseDeTeste();
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

function manifesto(id: ReturnType<typeof identidade>) {
  return {
    format_version: 1,
    profile: "data",
    publisher: id.publicador,
    name: id.modulo,
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    permissions: ["dados.proprios"],
    dependencies: [],
    data: {
      mode: "declarado",
      objetos: [
        {
          slug: OBJETO,
          rotulo: { "pt-BR": ROTULO },
          campos: [
            { slug: "dente", tipo: "inteiro", obrigatorio: true },
            { slug: "condicao", tipo: "texto", obrigatorio: true },
            { slug: "valor", tipo: "dinheiro" },
          ],
          refs: [{ slug: "paciente", entidade: "contato", obrigatorio: true, ao_apagar: "cascata" }],
        },
      ],
    },
    display: {
      title: { "pt-BR": ROTULO },
      summary: { "pt-BR": "Dente a dente" },
      category: "productivity",
      icon: "ListChecks",
    },
    configuration: {},
    contributions: {},
  };
}

/**
 * Instala o módulo pelo caminho REAL do banco: as três RPCs de `fn_extensions_*`, as mesmas que a
 * rota HTTP de instalação chama.
 *
 * A primeira versão desta fixture fazia `insert` direto em `extension_artifacts` — e o banco
 * recusou, com `permission denied for table extension_artifacts`. Foi a doutrina funcionando contra
 * o meu atalho: aquelas tabelas são fechadas até para a chave de serviço, e **toda escrita do
 * framework passa por RPC que revalida ator, organização e papel** (não-negociável 3). O erro foi o
 * certo; a fixture estava errada.
 *
 * O que fica fora, de propósito: a admissão por DOWNLOAD (catálogo HTTP, guarda de SSRF, parser
 * estrito) é o caminho de `extensoes-declarativas.spec.ts`. Aqui o pacote entra pelo `finish_install`,
 * que é onde vive a mudança desta onda — ele compila as tabelas na mesma transação do recibo.
 */
async function instalarModuloDeDados(db: SupabaseClient, orgId: string, id: ReturnType<typeof identidade>) {
  const creds = lerCreds();
  // A chave do seed é `dono` (scripts/seed-e2e-credentials.ts:84), não `owner`.
  const dono = creds.users.dono ?? creds.users.admin;
  if (!dono?.id) throw new Error(".e2e-creds.json sem o id do dono/admin");

  // Administrador da INSTALAÇÃO: é dele a autoridade de instalar (não-negociável 4).
  await db.from("platform_admins").upsert(
    {
      user_id: dono.id,
      granted_by: dono.id,
      scope: "full",
      mfa_required: false,
      reason: "Fixture E2E do módulo de dados",
    },
    { onConflict: "user_id" },
  );

  const m = manifesto(id);
  const doc = JSON.stringify(m);
  const { createHash, randomUUID } = await import("node:crypto");
  const sha = createHash("sha256").update(doc).digest("hex");

  const entrada = {
    publisher: id.publicador,
    name: id.modulo,
    version: "1.0.0",
    license: "MIT",
    host_api: m.host_api,
    display: m.display,
    permissions: m.permissions,
    sha256: sha,
    byte_length: Buffer.byteLength(doc),
  };
  const snapshot = {
    format_version: 1,
    // A origem é esquema + HOST, sem caminho: `fn_extensions_admit_catalog` a valida com
    // `^https?://[^/@?#[:space:]]+$`, e uma barra depois do host devolve `extension_invalid_input`.
    // Foi o que reprovou a primeira rodada desta spec no CI.
    origin: `https://modulo-de-dados-${id.publicador}.e2e.invalid`,
    revision: 1,
    entries: [entrada],
  };

  const admissao = await db.rpc("fn_extensions_admit_catalog", {
    p_actor: dono.id,
    p_operation: randomUUID(),
    p_snapshot: snapshot,
    p_digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  });
  if (admissao.error) throw new Error(`admitir: ${admissao.error.message}`);
  const catalogId = (admissao.data as { catalog_id: string }).catalog_id;

  const preparo = await db.rpc("fn_extensions_prepare_install", {
    p_actor: dono.id,
    p_operation: randomUUID(),
    p_catalog: catalogId,
    p_publisher: id.publicador,
    p_name: id.modulo,
    p_version: "1.0.0",
    // O nome É `p_expected_installation_revision` (confira em `supabase/baseline.sql`): o PostgREST
    // resolve a função pelos NOMES dos parâmetros, então um nome errado não dá "argumento inválido"
    // — dá "Could not find the function ... in the schema cache", que soa como função ausente.
    p_expected_installation_revision: null,
  });
  if (preparo.error) throw new Error(`preparar: ${preparo.error.message}`);

  // É ESTA chamada que compila as tabelas do módulo, na mesma transação do recibo.
  const conclusao = await db.rpc("fn_extensions_finish_install", {
    p_actor: dono.id,
    p_operation: (preparo.data as { id: string }).id,
    p_manifest: m,
    p_sha256: sha,
    p_byte_length: Buffer.byteLength(doc),
    p_document: doc,
  });
  if (conclusao.error) throw new Error(`concluir: ${conclusao.error.message}`);

  const { data: contato, error: erroContato } = await db
    .from("contacts")
    .insert({ organization_id: orgId, name: "Paciente do Odontograma E2E" })
    .select("id")
    .single();
  if (erroContato) throw new Error(`contato: ${erroContato.message}`);

  // ⚠️ O RECARREGAMENTO DO POSTGREST É ASSÍNCRONO, e isso é propriedade do produto, não da fixture.
  // `fn_modulo_dados_compilar` termina com `pg_notify('pgrst', 'reload schema')`, mas o PostgREST
  // recarrega quando recebe o aviso — não dentro da transação. Então existe uma janela de alguns
  // segundos, depois de instalar, em que a tabela JÁ EXISTE no banco e a API ainda responde
  // `Could not find the table … in the schema cache`.
  //
  // A fixture espera essa janela em vez de a esconder: insistir aqui é o que um cliente de verdade
  // faria, e o teto declarado diz quanto a janela pode durar antes de isto virar defeito.
  const limite = Date.now() + 20_000;
  let erroFicha: { message: string } | null = null;
  for (;;) {
    const r = await db.from(id.tabela).insert({
      organization_id: orgId,
      paciente_id: contato!.id,
      dente: 11,
      condicao: "restaurado",
      valor_cents: 12500,
      valor_moeda: "BRL",
    });
    erroFicha = r.error;
    if (!erroFicha) break;
    const aindaNaoVisivel = /schema cache/i.test(erroFicha.message);
    if (!aindaNaoVisivel || Date.now() > limite) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (erroFicha) throw new Error(`ficha: ${erroFicha.message}`);

  return { contatoId: contato!.id as string };
}

async function entrar(page: Page) {
  const creds = lerCreds();
  const usuario = creds.users.manager ?? creds.users.admin;
  if (!usuario) throw new Error(".e2e-creds.json sem usuário");
  await page.goto("/login");
  await page.locator("#email").fill(usuario.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: ESPERA });
  return creds;
}

test("a ficha do contato mostra o que o módulo de dados guarda, com o rótulo do autor", async ({
  page,
}) => {
  const creds = lerCreds();
  if (!creds.org_id) throw new Error(".e2e-creds.json sem org_id");
  const db = banco();
  const id = identidade("a");
  const { contatoId } = await instalarModuloDeDados(db, creds.org_id, id);

  await entrar(page);
  await page.goto(`/app/contacts/${contatoId}`);

  // O rótulo é o que o AUTOR declarou — não o slug do objeto, não o nome da tabela.
  await expect(page.getByText(ROTULO, { exact: true })).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("restaurado")).toBeVisible({ timeout: ESPERA });

  // Dinheiro formatado. O banco guarda 12500 centavos; a tela que mostrasse "12500" estaria
  // mostrando o banco por dentro.
  await expect(page.getByText(/125,00/)).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("12500", { exact: true })).toHaveCount(0);
});

test("módulo removido: o painel sai e a ficha do contato segue inteira", async ({ page }) => {
  const creds = lerCreds();
  const dono = creds.users.dono ?? creds.users.admin;
  if (!dono?.id) throw new Error(".e2e-creds.json sem dono/admin com id");
  const db = banco();
  const id = identidade("b");
  const { contatoId } = await instalarModuloDeDados(db, creds.org_id, id);

  // Remover é LÓGICO e preserva dados (não-negociável 7): as tabelas ficam, as telas saem.
  //
  // ⚠️ PELA RPC REAL, e não por `update` direto. A primeira versão daqui escrevia
  // `removed_at` na mão com a chave de serviço e o banco recusou:
  // `permission denied for table extension_installations`. Foi a doutrina funcionando contra o meu
  // atalho pela SEGUNDA vez nesta mesma spec — a fixture de instalação já tinha levado o mesmo
  // "não" ao tentar um `insert` em `extension_artifacts`. As tabelas do framework são fechadas até
  // para a chave de serviço, e TODA escrita passa por RPC que revalida ator, organização e papel
  // (não-negociável 3).
  //
  // E não é só permissão: `update` à mão provaria a tela e MENTIRIA sobre a origem. A remoção real
  // abre operação, confere a revisão vista, desliga as organizações e audita — nada disso acontece
  // num `update`, e um painel que sumisse por causa de uma coluna crua não prova que a remoção de
  // verdade o faz sumir. É o mesmo caminho de `removeExtension` em `lib/extensions/service.ts`.
  const { data: instalacao, error: erroLeitura } = await db
    .from("extension_installations")
    .select("id, revision")
    .eq("publisher", id.publicador)
    .eq("name", id.modulo)
    .is("removed_at", null)
    .single();
  if (erroLeitura) throw new Error(`ler instalação: ${erroLeitura.message}`);

  const { randomUUID } = await import("node:crypto");
  const remocao = await db.rpc("fn_extensions_remove_installation", {
    p_actor: dono.id,
    p_operation: randomUUID(),
    p_installation: instalacao!.id,
    p_expected_installation_revision: instalacao!.revision,
  });
  if (remocao.error) throw new Error(`remover: ${remocao.error.message}`);

  await entrar(page);
  await page.goto(`/app/contacts/${contatoId}`);

  // A ficha carregou — é esta asserção que dá sentido à de baixo. Sem ela, "não vejo o painel"
  // também passaria numa página que não carregou nada.
  await expect(page.getByText("Paciente do Odontograma E2E").first()).toBeVisible({
    timeout: ESPERA,
  });
  await expect(page.getByText(ROTULO, { exact: true })).toHaveCount(0);
  // ⚠️ A AUSÊNCIA DO RÓTULO NÃO BASTA: ela também seria verdade se o painel tivesse caído no
  // estado de ERRO, que desenha outro texto. Aí o teste estaria verde sobre um painel quebrado em
  // vez de um painel removido. Esta linha separa as duas coisas.
  await expect(page.getByText(/Não foi possível carregar/i)).toHaveCount(0);

  // E o dado NÃO foi apagado: remover é lógico.
  const { count } = await db
    .from(id.tabela)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", creds.org_id);
  expect(count ?? 0).toBeGreaterThan(0);
});
