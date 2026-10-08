import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  ehClienteDeServico,
  nomesDoClienteAdmin,
  passosDaCadeia,
  raizDaCadeia,
} from "./helpers/cliente-admin";
import { RAIZ_DO_REPO, arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * A OUTRA METADE DA RLS: O CLIENTE DE SERVIÇO ALCANÇANDO TABELA TENANT-AWARE.
 *
 * ## O defeito que fez este arquivo existir (issue #834)
 *
 * `tests/invariants/rls-isolation.test.ts` percorre uma lista de tabelas e prova
 * que a POLÍTICA de RLS as protege — ele mede o mundo como um papel restrito o
 * vê (`set_config('request.jwt.claims', …)`, o mesmo caminho de `auth.uid()` e
 * `fn_user_org_ids()` que as policies usam).
 *
 * O vazamento de 14/set não passava por ali. `createAdminClient()` usa a
 * **service role**, que **contorna a RLS por desenho**, e as duas tabelas do
 * episódio (`conversations` e `messages`) estavam na lista do invariante: ele
 * seguia verde enquanto o handler alcançava a conversa de OUTRA organização.
 * Medido contra Postgres real, um chamador com contexto da org A inseriu
 * mensagem na conversa da org B.
 *
 * A doutrina já dizia o certo (CLAUDE.md, anti-pattern 10: "service role usado
 * em request handler sem filtrar `organization_id` manualmente") — e regra sem
 * mecanismo é intenção. É a mesma lição das definer expostas a `anon`: o gate
 * que existia media a outra metade.
 *
 * ## As três regras
 *
 *   - **R1 — escrita que CRIA linha** (`insert`/`upsert`) em tabela com
 *     `organization_id` precisa carregar o tenant: no payload, no `onConflict`
 *     ou no filtro. Sem isso a linha nova não tem dono declarado por quem
 *     escreveu — e foi exatamente esta a forma do episódio (mensagem inserida
 *     na conversa de outra organização).
 *   - **R2 — nenhuma cadeia sem filtro ALGUM**: `select`/`update`/`delete` que
 *     não filtra coluna nenhuma varre (ou reescreve) a tabela inteira, de todos
 *     os tenants. Vale para leitura e para mutação.
 *   - **R3 — toda cadeia que filtra por CHAVE carrega o tenant**: a R2 aceita
 *     qualquer filtro como escopo, então `admin.from("x").update(…).eq("id", id)`
 *     passava verde — a forma do anti-pattern 10 do CLAUDE.md. A R3 cobra
 *     `organization_id` em toda cadeia não-criadora que filtra sem carregar o
 *     tenant, ONDE ele é conhecido (código de request: sessão, token, fonte do
 *     webhook). Quem percorre todas as organizações por desenho (`ESTEIRAS`) ou
 *     lê linha de plataforma sem organização (`CHAVE_SEM_TENANT_LIBERADA`) sai
 *     por declaração com a razão escrita — no mesmo molde de `PLATAFORMA` e
 *     `SEM_FILTRO_LIBERADO`, e as duas listas só encolhem (guarda de órfão).
 *
 * `update`/`delete` por chave primária NÃO entram em R1 de propósito: a linha
 * já existe e foi (ou deveria ter sido) lida com escopo antes; exigir
 * `organization_id` em toda NOVA linha é o que R1 cobra. A mutação por id sem
 * tenant é o alvo da R3 — e o "ruído" que a segurava está nas dispensas
 * declaradas, não em omitir a régua. Quem a R1 cobra é a linha NOVA.
 *
 * ## Por que uma varredura, e não mais uma lista
 *
 * Lista fixa cobre as tabelas que alguém lembrou de escrever. O que define o
 * risco é o PAR: quem pega o cliente de serviço × que tabela alcança — e isso
 * muda a cada handler novo. A varredura lê as duas coisas do próprio código e
 * do próprio schema (`supabase/baseline.sql` + migrations), então tabela nova
 * com `organization_id` entra na régua sozinha.
 *
 * ## O que este arquivo NÃO mede (declarado, não escondido)
 *
 *   - cliente admin RECEBIDO por PARÂMETRO — o caminho de `lib/mcp/server.ts`,
 *     que entrega o cliente de serviço ao mesmo handler. É por onde o defeito
 *     de 14/set nasceu; atravessar arquivos é a varredura seguinte;
 *   - `rpc(...)`: as funções são medidas por
 *     `tests/invariants/hardening-definer-varredura.test.ts` e pelos testes de
 *     ACL de cada domínio;
 *   - a PROCEDÊNCIA do `organization_id` (se veio de cookie/JWT/path token, e
 *     não do body). A régua cobra presença; a fonte continua matéria de revisão
 *     — o mesmo recorte do gate irmão;
 *   - o aceite de R1 olha a FORMA: um payload que ESPALHA uma linha que carrega
 *     `organization_id` passa, mesmo que a linha venha de outro tenant;
 *   - **R2 aceita QUALQUER filtro como escopo — inclusive só a chave.** Uma
 *     cadeia `admin.from("conversations").select().eq("id", x)` passa, sem
 *     `organization_id` nenhum. É exatamente a forma do anti-pattern 10 do
 *     CLAUDE.md, e a forma do defeito de 14/set. Medido na triagem, com a
 *     previsão escrita antes de rodar: tirar o filtro de org das duas buscas
 *     da conversa em `messages/_handler.ts` → 6/6 verde (e ali ainda vale o
 *     ponto cego do parâmetro); tirar o filtro de org de uma rota com cliente
 *     admin LOCAL, deixando só `.eq("id")` → 6/6 verde; tirar TODOS os filtros
 *     → vermelho em R2. Cobrar `organization_id` em toda leitura por chave era
 *     "o passo seguinte" — é hoje a **R3** acima: mesma varredura, régua nova,
 *     com as dispensas declaradas e revisáveis em `ESTEIRAS`/
 *     `CHAVE_SEM_TENANT_LIBERADA`.
 *     O defeito de 14/set segue guardado por um invariante de COMPORTAMENTO,
 *     `tests/invariants/envio-nao-alcanca-conversa-de-outro-tenant.test.ts`,
 *     não por esta varredura.
 */

const RAIZES = ["app", "lib", "workers"] as const;

/** Métodos do PostgREST cujo primeiro argumento restringe a consulta. */
const FILTROS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains",
  "containedBy", "overlaps", "or", "and", "filter", "match", "not", "textSearch",
]);

const CRIAM_LINHA = new Set(["insert", "upsert"]);

const COLUNA_DO_TENANT = "organization_id";

/**
 * A superfície de PLATAFORMA. `/admin/**` opera cross-tenant por desenho (é o
 * painel de quem administra a instalação, não de quem a usa): ali a varredura
 * não cobra filtro de tenant. Declarado — e não silenciado — para que a lista
 * seja revisada quando a superfície mudar.
 */
const PLATAFORMA: readonly { caminho: string; motivo: string }[] = [
  {
    caminho: "app/api/v1/admin/",
    motivo:
      "Painel de plataforma: lê e opera vários tenants de propósito (tenants, " +
      "users, inbox, incidents, audit, lgpd, usage, impersonate), e é guardado " +
      "por papel de plataforma — não por RLS de organização.",
  },
];

/**
 * Exceções de R2 com a razão escrita. Só encolhe: cada entrada está dizendo por
 * que uma cadeia de service role alcança a tabela sem filtro e por que isso é
 * correto.
 */
const SEM_FILTRO_LIBERADO: readonly { arquivo: string; tabela: string; motivo: string }[] = [
  {
    arquivo: "app/admin/(protected)/extensoes/page.tsx",
    tabela: "organization_extensions",
    motivo:
      "A pergunta É cross-tenant: 'em quantas empresas esta extensão está ligada'. O " +
      "`select` traz apenas `installation_id,enabled` — nenhum nome, nenhum dado de " +
      "cliente, nenhuma coluna que identifique a organização —, e a tela mostra a " +
      "CONTAGEM, não a lista. Filtrar por uma organização responderia outra pergunta. " +
      "O gate é de papel, como nas irmãs de `/admin`: `is_platform_admin` no topo da " +
      "página e `notFound()` para o resto. " +
      "⚠️ A dispensa VENCE se a tela passar a mostrar QUAIS empresas: aí o `select` " +
      "carrega `organization_id` e volta a ser leitura de dado de inquilino, que " +
      "precisa de decisão própria sobre o que o dono da instalação pode ver.",
  },
  {
    arquivo: "lib/notifications/web_push.ts",
    tabela: "push_subscriptions",
    motivo:
      "`store(admin)` devolve o BUILDER (`admin.from(\"push_subscriptions\")`); quem " +
      "filtra é cada chamador — `enviarPushDaOrg`/`removerPush` filtram por " +
      "`organization_id` e, na remoção, por `endpoint`. A cadeia sem filtro não " +
      "consulta nada: ela não foi aguardada.",
  },
];

/**
 * ESTEIRAS: fora da R3 (a R2 segue valendo). Percorrem todas as organizações
 * por desenho e pegam a linha por um claim, sem organização conhecida antes da
 * leitura. Só encolhe.
 */
const ESTEIRAS: readonly { caminho: string; motivo: string }[] = [
  {
    caminho: "app/api/v1/cron/",
    motivo:
      "Cron varre a instalação inteira e age sobre a linha que acabou de ler. " +
      "Guardado pelo segredo do cron e pela R2.",
  },
  {
    caminho: "workers/voice-agent/",
    motivo:
      "O Asterisk entrega só o id do canal. A linha de voice_calls é achada por " +
      "ele, e as escritas seguintes usam o id que essa leitura devolveu.",
  },
  {
    caminho: "lib/ai/dispatcher/",
    motivo:
      "Claim de event_log pelo id do evento. O evento carrega a organização, e o " +
      "handler que o consome filtra por ela.",
  },
  {
    caminho: "lib/lgpd/storage-redaction-queue.ts",
    motivo:
      "Fila de remoção de mídia: cada item é processado pelo id que o próprio " +
      "processador acabou de reivindicar.",
  },
];

/**
 * Exceções da R3, cadeia a cadeia, com a razão escrita. Só encolhe.
 */
const CHAVE_SEM_TENANT_LIBERADA: readonly { arquivo: string; tabela: string; motivo: string }[] = [
  {
    arquivo: "app/api/v1/ai/skills/[name]/route.ts",
    tabela: "skill_versions",
    motivo:
      "Versão de plataforma tem organization_id nulo. O id vem de skill_pointers, " +
      "lido com filtro de organização logo acima.",
  },
  {
    arquivo: "app/api/v1/ai/skills/route.ts",
    tabela: "skill_versions",
    motivo:
      "Mesma razão: os ids vêm dos pointers da organização e dos de plataforma " +
      "(organization_id nulo).",
  },
  {
    arquivo: "app/app/ai/skills/page.tsx",
    tabela: "skill_versions",
    motivo:
      "Mesma leitura da API de skills, feita no servidor da página.",
  },
  {
    arquivo: "lib/extensions/service.ts",
    tabela: "extension_operations",
    motivo:
      "Operação de extensão é da instalação, com organization_id nulo nas de " +
      "plataforma. A rota de revert é guardada por papel de plataforma.",
  },
];

interface Cadeia {
  arquivo: string;
  linha: number;
  tabela: string;
  cliente: string;
  /** `insert`/`upsert` — a linha nova entra aqui. */
  criaLinha: boolean;
  /** Método que restringe (com argumento) em algum passo da cadeia. */
  filtra: boolean;
  /** `organization_id` no filtro, no payload, no `onConflict` ou na declaração do payload. */
  carregaOTenant: boolean;
}

function arquivosDeSchema(): string[] {
  const dir = path.join(RAIZ_DO_REPO, "supabase", "migrations");
  let migrations: string[] = [];
  try {
    migrations = readdirSync(dir).filter((n) => n.endsWith(".sql"));
  } catch {
    migrations = []; // sem migrations — o baseline abaixo segue valendo
  }
  return ["supabase/baseline.sql", ...migrations.sort().map((n) => `supabase/migrations/${n}`)];
}

/**
 * As tabelas que carregam `organization_id` — lidas do SQL, não declaradas à
 * mão: tabela nova com a coluna entra na régua sem ninguém editar esta lista.
 */
function tabelasTenantAware(): Set<string> {
  const nomes = new Set<string>();
  for (const rel of arquivosDeSchema()) {
    let sql = "";
    try {
      sql = readFileSync(path.join(RAIZ_DO_REPO, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi,
    )) {
      if (/\borganization_id\b/.test(m[2] ?? "")) nomes.add(m[1] ?? "");
    }
    for (const m of sql.matchAll(
      /alter\s+table\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,400}?add\s+column\s+(?:if\s+not\s+exists\s+)?"?organization_id"?/gi,
    )) {
      nomes.add(m[1] ?? "");
    }
  }
  nomes.delete("");
  return nomes;
}

/** Os identificadores usados numa expressão — inclusive dentro de objeto/array. */
function identificadores(no: ts.Expression, acc: Set<string>): void {
  if (ts.isIdentifier(no)) {
    acc.add(no.text);
    return;
  }
  if (ts.isArrayLiteralExpression(no)) {
    for (const e of no.elements) identificadores(e, acc);
    return;
  }
  if (ts.isObjectLiteralExpression(no)) {
    for (const p of no.properties) {
      if (ts.isSpreadAssignment(p)) identificadores(p.expression, acc);
      else if (ts.isPropertyAssignment(p)) identificadores(p.initializer, acc);
      else if (ts.isShorthandPropertyAssignment(p)) acc.add(p.name.text);
    }
    return;
  }
  if (ts.isCallExpression(no)) {
    for (const a of no.arguments) identificadores(a, acc);
    return;
  }
  if (ts.isPropertyAccessExpression(no)) identificadores(no.expression, acc);
}

/**
 * O texto da declaração de um nome NO MESMO arquivo.
 *
 * É o que faz a régua enxergar a forma real da casa: o payload quase nunca é um
 * objeto inline, ele é uma variável construída três linhas acima (`rows`,
 * `insertRow`, `linha`) — e ler só a cadeia daria vermelho em código correto.
 */
function textoDaDeclaracao(fonte: ts.SourceFile, nome: string): string {
  let texto = "";
  const visitar = (no: ts.Node): void => {
    if (
      ts.isVariableDeclaration(no) &&
      ts.isIdentifier(no.name) &&
      no.name.text === nome &&
      no.initializer !== undefined
    ) {
      texto += `${no.initializer.getText(fonte)}\n`;
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return texto;
}

function analisar(caminho: string, doTenant: ReadonlySet<string>): Cadeia[] {
  const texto = readFileSync(caminho, "utf8");
  if (!texto.includes("createAdminClient")) return [];

  const fonte = ts.createSourceFile(caminho, texto, ts.ScriptTarget.Latest, true);
  const admins = nomesDoClienteAdmin(fonte);
  const cadeias: Cadeia[] = [];

  const visitar = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      no.expression.name.text === "from"
    ) {
      const argumento = no.arguments[0];
      const receptor = no.expression.expression;
      if (
        argumento !== undefined &&
        ts.isStringLiteral(argumento) &&
        doTenant.has(argumento.text) &&
        ehClienteDeServico(receptor, admins)
      ) {
        const passos = passosDaCadeia(no);
        const comArgumento = passos.filter((p) => p.chamada.arguments.length > 0);
        const filtra = comArgumento.some((p) => FILTROS.has(p.metodo));
        const criaLinha = passos.some((p) => CRIAM_LINHA.has(p.metodo));

        // O que o autor ESCREVEU na cadeia: payload inline, `onConflict` e o
        // argumento de cada filtro. Uma variável de payload não aparece aqui —
        // é o caso que `textoDaDeclaracao` cobre.
        const ultima = passos.length > 0 ? (passos[passos.length - 1] as { chamada: ts.CallExpression }) : null;
        const fim = ultima === null ? no.getEnd() : ultima.chamada.getEnd();
        const textoDaCadeia = fonte.text.slice(no.getStart(), fim);

        let carregaOTenant = textoDaCadeia.includes(COLUNA_DO_TENANT);
        if (!carregaOTenant) {
          const nomes = new Set<string>();
          for (const p of comArgumento) {
            const primeiro = p.chamada.arguments[0];
            if (primeiro !== undefined) identificadores(primeiro, nomes);
          }
          for (const nome of nomes) {
            if (textoDaDeclaracao(fonte, nome).includes(COLUNA_DO_TENANT)) {
              carregaOTenant = true;
              break;
            }
          }
        }

        cadeias.push({
          arquivo: caminhoRelativo(caminho),
          linha: fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1,
          tabela: argumento.text,
          cliente: raizDaCadeia(receptor) ?? "(inline)",
          criaLinha,
          filtra,
          carregaOTenant,
        });
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return cadeias;
}

const DO_TENANT = tabelasTenantAware();
const ARQUIVOS = arquivosDeCodigo(RAIZES);
const CADEIAS = ARQUIVOS.flatMap((a) => analisar(a, DO_TENANT));

const emPlataforma = (c: Cadeia): boolean => PLATAFORMA.some((p) => c.arquivo.startsWith(p.caminho));

/** Uma linha por achado, para a falha dizer ONDE — e não só QUANTOS. */
const descreverCadeia = (c: Cadeia): string => `${c.arquivo}:${c.linha} ${c.tabela}`;

const escritasSemTenant = CADEIAS.filter((c) => c.criaLinha && !c.carregaOTenant);
const semFiltroNenhum = CADEIAS.filter((c) => !c.criaLinha && !c.filtra && !c.carregaOTenant)
  .filter((c) => !emPlataforma(c))
  .filter((c) => !SEM_FILTRO_LIBERADO.some((e) => e.arquivo === c.arquivo && e.tabela === c.tabela));

const emEsteira = (c: Cadeia): boolean => ESTEIRAS.some((e) => c.arquivo.startsWith(e.caminho));

/** Toda cadeia que filtra por ALGO que não é o tenant — a forma da R3. */
const porChaveSemTenant = CADEIAS.filter((c) => !c.criaLinha && c.filtra && !c.carregaOTenant);

/** R3: a mesma forma, menos o que está declarado (plataforma, esteira, exceção). */
const chaveSemTenant = porChaveSemTenant
  .filter((c) => !emPlataforma(c))
  .filter((c) => !emEsteira(c))
  .filter((c) => !CHAVE_SEM_TENANT_LIBERADA.some((e) => e.arquivo === c.arquivo && e.tabela === c.tabela));

describe("o cliente de serviço também responde ao tenant", () => {
  it("a varredura enxerga o schema e os arquivos (guarda de vacuidade)", () => {
    // Sem isto, um regex que deixasse de casar (ou um caminho de schema
    // renomeado) faria as asserções abaixo passarem por AUSÊNCIA de dado —
    // verde de instrumento cego. As duas tabelas do episódio são o piso.
    expect(ARQUIVOS.length).toBeGreaterThan(500);
    expect(DO_TENANT.size).toBeGreaterThan(50);
    expect(DO_TENANT.has("conversations")).toBe(true);
    expect(DO_TENANT.has("messages")).toBe(true);
  });

  it("a varredura enxerga quem pega o cliente de serviço (controle positivo)", () => {
    const comAdmin = ARQUIVOS.filter(
      (a) => nomesDoClienteAdmin(ts.createSourceFile(a, readFileSync(a, "utf8"), ts.ScriptTarget.Latest, true)).size > 0,
    );
    expect(comAdmin.length).toBeGreaterThan(100);
    expect(CADEIAS.length, "nenhuma cadeia de service role medida — a régua cegou").toBeGreaterThan(80);
  });

  it("a varredura reconhece o payload que carrega o tenant (controle positivo)", () => {
    // Gêmeo conhecido: o worker monta a linha da mensagem numa variável
    // (`insertRow`) com `organization_id` e só depois insere. Se ele aparecer
    // como achado, a régua está lendo a cadeia e não a declaração.
    const gemeo = CADEIAS.find(
      (c) => c.arquivo === "workers/ai-response-worker.ts" && c.tabela === "messages" && c.criaLinha,
    );
    expect(gemeo, "a inserção da mensagem no worker sumiu — a régua perdeu a referência").toBeDefined();
    expect(gemeo?.carregaOTenant).toBe(true);
  });

  it("R1: nenhuma linha nova entra em tabela tenant-aware sem o tenant", () => {
    expect(
      escritasSemTenant.map(descreverCadeia),
      "Cadeia de service role que CRIA linha em tabela com `organization_id` sem " +
        "carregar o tenant. A RLS não vai barrar — o service role a contorna por " +
        `desenho. Ponha \`${COLUNA_DO_TENANT}\` no payload (ou no \`onConflict\`) do que ` +
        "está sendo inserido, resolvido de fonte confiável.",
    ).toEqual([]);
  });

  it("R2: nenhuma cadeia de service role varre tabela tenant-aware sem filtro", () => {
    expect(
      semFiltroNenhum.map(descreverCadeia),
      "Cadeia de service role sem filtro NENHUM: ela alcança a tabela inteira, de " +
        "todos os tenants. Filtre pela coluna que amarra a linha ao escopo já " +
        'validado (`.eq("organization_id", …)` ou a chave do agregado) — ou ' +
        "declare a superfície em PLATAFORMA/SEM_FILTRO_LIBERADO com a razão escrita.",
    ).toEqual([]);
  });

  it("R3: cadeia de service role por chave carrega o tenant onde ele é conhecido", () => {
    expect(
      chaveSemTenant.map(descreverCadeia),
      "Cadeia de service role que filtra por OUTRA coluna sem `organization_id`: um id adivinhado " +
        "ou vindo do body alcança a linha de outra organização. Acrescente " +
        '`.eq("organization_id", …)` com a organização já resolvida (sessão, token, fonte do ' +
        "webhook), ou declare em ESTEIRAS / CHAVE_SEM_TENANT_LIBERADA com a razão escrita.",
    ).toEqual([]);
  });

  it("as declarações continuam válidas e sem nome órfão", () => {
    for (const p of PLATAFORMA) {
      const alcancadas = CADEIAS.filter((c) => c.arquivo.startsWith(p.caminho));
      expect(
        alcancadas.length,
        `\`${p.caminho}\` está declarada como superfície de plataforma e não tem mais cadeia nenhuma — remova a declaração`,
      ).toBeGreaterThan(0);
      expect(p.motivo.trim().length, `declaração sem razão escrita: ${p.caminho}`).toBeGreaterThan(20);
    }
    for (const e of SEM_FILTRO_LIBERADO) {
      const achado = CADEIAS.find((c) => c.arquivo === e.arquivo && c.tabela === e.tabela && !c.filtra);
      expect(
        achado,
        `exceção órfã: \`${e.arquivo}\` já não alcança \`${e.tabela}\` sem filtro — remova de SEM_FILTRO_LIBERADO`,
      ).toBeDefined();
      expect(e.motivo.trim().length, `exceção sem razão escrita: ${e.arquivo}`).toBeGreaterThan(20);
    }
    for (const e of ESTEIRAS) {
      const alcancadas = porChaveSemTenant.filter(
        (c) => !emPlataforma(c) && c.arquivo.startsWith(e.caminho),
      );
      expect(
        alcancadas.length,
        `esteira órfã: \`${e.caminho}\` não alcança mais nenhuma cadeia por chave sem tenant — remova de ESTEIRAS`,
      ).toBeGreaterThan(0);
      expect(e.motivo.trim().length, `esteira sem razão escrita: ${e.caminho}`).toBeGreaterThan(20);
    }
    for (const e of CHAVE_SEM_TENANT_LIBERADA) {
      const achado = porChaveSemTenant.find((c) => c.arquivo === e.arquivo && c.tabela === e.tabela);
      expect(
        achado,
        `exceção órfã: \`${e.arquivo}\` já não alcança \`${e.tabela}\` sem o tenant — remova de CHAVE_SEM_TENANT_LIBERADA`,
      ).toBeDefined();
      expect(e.motivo.trim().length, `exceção sem razão escrita: ${e.arquivo}`).toBeGreaterThan(20);
    }
  });
});
