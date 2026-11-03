// @vitest-environment node
/**
 * TOKEN DE INTEGRAÇÃO POR ÁREA — ANÚNCIOS (`ads`), AUDITORIA (`audit`) E
 * IMPORTAÇÕES (`imports`) (Spec 33, fatia R3, tarefa 2).
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service
 * role, que contorna a RLS. O que protege a organização ali é o filtro
 * `.eq("organization_id", authz.organizationId)` que cada rota escreve à mão, e
 * um dublê que devolve a mesma linha para qualquer consulta não vê a falta dele.
 * Este arquivo usa `criarClienteAdminFalso`, que guarda linhas de DUAS
 * organizações, aplica os filtros e registra cada cadeia: consulta sem o filtro
 * não alcança linha nenhuma, e `cadeiasForaDaOrganizacao` diz qual foi.
 *
 * Seis testes por rota (tabela `CASOS`), mais o bloco de borda do proxy:
 *   1. token de A alcança o recurso de A (e nenhuma linha de B aparece);
 *   2. token de B não alcança o recurso de A (as linhas de B saem do cenário,
 *      então o que sobra para B é "nada": 404, lista vazia ou "sem conexão");
 *   3. token sem o escopo da operação é recusado (403);
 *   4. token com papel um degrau abaixo é recusado (403);
 *   5. acima do teto do token → 429 com Retry-After, sem tocar o dado;
 *   6. a sessão continua pelo mesmo portão de antes.
 *
 * Mocks (os da receita): `createClient` e `loadAuthUser` LANÇAM no ramo do
 * token, `createAdminClient` devolve o falso, `validateBearerToken` é mockado,
 * o teto devolve `allowed: true` (menos no caso do teto) e
 * `requireSupportWrite` devolve `null`. Mais `audit` e `requireRole` (a sessão),
 * e o cliente HTTP da plataforma de anúncios: ele fala com a rede, então só ele
 * é dublado; a credencial vem do banco falso e é decifrada pelo `rpc` falso.
 *
 * Adaptações declaradas:
 *  - `imports` chama `seModuloB2bDesligado` ANTES do portão (módulo opcional da
 *    instalação, 404 quando desligado). Ele lê `platform_config` e
 *    `modulos_instalados`, que são da INSTALAÇÃO e não têm `organization_id`
 *    (`SEM_ORGANIZACAO`). Por isso "sem tocar o dado" mede só as tabelas da
 *    organização (`cadeiasDeDado`).
 *  - `ads` e `audit` não têm "abaixo do papel" para o viewer; `imports` GET tem
 *    papel `viewer`, então não existe papel abaixo dele (ver o comentário no
 *    laço dos casos).
 *  - `audit` GET passa por DOIS portões (Receita B com papel `manager`): o
 *    `requireRole` da sessão leva `allowPlatformAdmin: "leitura"`, que
 *    `resolveAuthDual` não repassa. O caso 6 confere a opção.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { MODELOS_DE_PORTA, caminhoDoModelo } from "@/lib/auth/portas-de-token";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import {
  lerCampanhas,
  lerInsights,
  listarContas,
} from "@/lib/plataformas-de-anuncio/meta/insights";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
vi.mock("@/lib/plataformas-de-anuncio/meta/insights", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/plataformas-de-anuncio/meta/insights")
  >("@/lib/plataformas-de-anuncio/meta/insights");
  return { ...actual, listarContas: vi.fn(), lerCampanhas: vi.fn(), lerInsights: vi.fn() };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";

/**
 * Tabelas SEM a coluna `organization_id` (conferidas no `supabase/baseline.sql`):
 *  - `platform_config`: chave/valor da INSTALAÇÃO (não é filha de organização
 *    nenhuma); a rota só lê o interruptor `MODULO_CRM_B2B` do módulo B2B.
 *  - `modulos_instalados`: módulos de tabela instalados NA INSTÂNCIA (ADR-0002);
 *    lida junto com a anterior pelo mesmo interruptor.
 */
const SEM_ORGANIZACAO = ["platform_config", "modulos_instalados"] as const;

type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write";
type Tabelas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;

type Caso = {
  /** a pasta da rota, para o rótulo */
  rota: string;
  metodo: "GET" | "POST";
  /** com a query, quando houver */
  caminho: string;
  /** importa o handler (literal, para o Vite resolver) e chama o método */
  executar: (req: NextRequest) => Promise<Response>;
  /** multipart: o corpo só pode ser lido uma vez, então é montado a cada chamada */
  corpo?: () => FormData;
  /** o recurso da organização A, mais uma linha da B em cada tabela */
  linhas: Tabelas;
  papel: Papel;
  escopo: Escopo;
  papelDoToken?: "admin";
  /** o nome do `requireRole`/audit da rota, e o balde do teto */
  recurso: string;
  /** opções do `requireRole` da sessão além de `resource` */
  opcoesDaSessao?: Record<string, unknown>;
  /** marcas que só a organização A pode ver na resposta */
  soDeA: string[];
  /** marcas que só a organização B pode ver na resposta */
  soDeB: string[];
  /** marcas que nenhum token de organização pode ver (linha de plataforma) */
  deNinguem?: string[];
  /** o que o token de B recebe, sem nenhuma linha da B no banco */
  comoB: { status: number; codigo?: string; listaVazia?: true; cria?: true };
  /** a ação do audit, nos métodos que auditam */
  audita?: string;
  /** a coluna de autor da linha criada: nula pelo token, o usuário pela sessão */
  autorDaLinha?: {
    tabela: string;
    coluna: string;
    eDaCriacao: (linha: Record<string, unknown>) => boolean;
  };
  /** a rota lê pelo cliente de sessão (e não só pelo admin) no ramo da sessão */
  clienteDaSessao: boolean;
  /** conferência extra do caso B */
  aoFimDeB?: () => void;
};

// ───────────────────────────── cenário ─────────────────────────────

const CONEXAO_A = "c0000000-0000-4000-8000-00000000000a";
const CONEXAO_B = "c0000000-0000-4000-8000-00000000000b";
const LOTE_A = "1a000000-0000-4000-8000-000000000001";
const LOTE_B = "1b000000-0000-4000-8000-000000000002";
const LINHA_A = "2a000000-0000-4000-8000-000000000001";
const LINHA_B = "2b000000-0000-4000-8000-000000000002";
const LINHA_B_NO_LOTE_DE_A = "2b000000-0000-4000-8000-000000000003";
const AUDITORIA_A = "3a000000-0000-4000-8000-000000000001";
const AUDITORIA_B = "3b000000-0000-4000-8000-000000000002";
const AUDITORIA_DA_PLATAFORMA = "3c000000-0000-4000-8000-000000000003";

const MODULO_B2B_LIGADO = { chave: "MODULO_CRM_B2B", valor: "ligado" };

/** O `rpc` que decifra: devolve o token da plataforma de anúncios de quem guardou. */
const RPC = {
  fn_decrypt_oauth: (args: Record<string, unknown>) => {
    const cifra = String(args.ciphertext);
    return { data: cifra.includes("aa11") ? "meta-token-A" : cifra.includes("bb22") ? "meta-token-B" : null };
  },
};

const LINHAS_DOS_ANUNCIOS: Tabelas = {
  ad_insights_connections: [
    {
      id: CONEXAO_A,
      organization_id: ORG_A,
      platform: "meta_ads",
      access_token_encrypted: "aa11",
      default_account_id: "act_111",
    },
    {
      id: CONEXAO_B,
      organization_id: ORG_B,
      platform: "meta_ads",
      access_token_encrypted: "bb22",
      default_account_id: "act_222",
    },
  ],
};

const LINHAS_DA_AUDITORIA: Tabelas = {
  api_audit_log: [
    {
      id: AUDITORIA_A,
      organization_id: ORG_A,
      created_at: "2026-11-02T10:00:00.000Z",
      action: "contacts.update",
      resource_type: "contacts",
    },
    {
      id: AUDITORIA_B,
      organization_id: ORG_B,
      created_at: "2026-11-02T11:00:00.000Z",
      action: "contacts.update",
      resource_type: "contacts",
    },
    {
      id: AUDITORIA_DA_PLATAFORMA,
      organization_id: null,
      created_at: "2026-11-02T12:00:00.000Z",
      action: "platform.maintenance",
      resource_type: "platform",
    },
  ],
};

const LINHAS_DAS_IMPORTACOES: Tabelas = {
  platform_config: [MODULO_B2B_LIGADO],
  import_batches: [
    {
      id: LOTE_A,
      organization_id: ORG_A,
      kind: "companies_people",
      filename: "lote-de-a.csv",
      status: "completed",
      total_rows: 1,
      created_at: "2026-11-02T10:00:00.000Z",
    },
    {
      id: LOTE_B,
      organization_id: ORG_B,
      kind: "companies_people",
      filename: "lote-de-b.csv",
      status: "completed",
      total_rows: 1,
      created_at: "2026-11-02T11:00:00.000Z",
    },
  ],
  import_rows: [
    { id: LINHA_A, organization_id: ORG_A, batch_id: LOTE_A, row_number: 2, status: "success" },
    { id: LINHA_B, organization_id: ORG_B, batch_id: LOTE_B, row_number: 2, status: "success" },
    // Uma linha da B que aponta para o lote da A: o filtro de organização das
    // linhas precisa barrá-la, mesmo com o `batch_id` batendo.
    { id: LINHA_B_NO_LOTE_DE_A, organization_id: ORG_B, batch_id: LOTE_A, row_number: 3, status: "success" },
  ],
};

function planilha(): FormData {
  const form = new FormData();
  form.set(
    "file",
    new File(["empresa,pessoa,telefone\nAcme Token,Maria Teste,11987654321"], "contatos.csv", {
      type: "text/csv",
    }),
  );
  // Sem enriquecimento: ele chamaria a BrasilAPI pela rede.
  form.set("enrich", "false");
  return form;
}

const CASOS: Caso[] = [
  {
    rota: "app/api/v1/ads/meta/accounts/route.ts",
    metodo: "GET",
    caminho: "/api/v1/ads/meta/accounts",
    executar: async (req) => (await import("@/app/api/v1/ads/meta/accounts/route")).GET(req),
    linhas: LINHAS_DOS_ANUNCIOS,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "ads_insights",
    soDeA: ["meta-token-A", "act_111"],
    soDeB: ["meta-token-B", "act_222"],
    // Sem conexão na organização do token: a credencial da A não é alcançável.
    comoB: { status: 422, codigo: "ads_sem_conexao" },
    clienteDaSessao: false,
    aoFimDeB: () => expect(listarContas).not.toHaveBeenCalled(),
  },
  {
    rota: "app/api/v1/ads/meta/campaigns/route.ts",
    metodo: "GET",
    caminho: "/api/v1/ads/meta/campaigns?account_id=act_111",
    executar: async (req) => (await import("@/app/api/v1/ads/meta/campaigns/route")).GET(req),
    linhas: LINHAS_DOS_ANUNCIOS,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "ads_insights",
    soDeA: ["meta-token-A"],
    soDeB: ["meta-token-B"],
    comoB: { status: 422, codigo: "ads_sem_conexao" },
    clienteDaSessao: false,
    aoFimDeB: () => {
      expect(lerCampanhas).not.toHaveBeenCalled();
      expect(lerInsights).not.toHaveBeenCalled();
    },
  },
  {
    rota: "app/api/v1/audit/route.ts",
    metodo: "GET",
    caminho: "/api/v1/audit",
    executar: async (req) => (await import("@/app/api/v1/audit/route")).GET(req),
    linhas: LINHAS_DA_AUDITORIA,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "audit",
    opcoesDaSessao: { allowPlatformAdmin: "leitura" },
    soDeA: [AUDITORIA_A],
    soDeB: [AUDITORIA_B],
    deNinguem: [AUDITORIA_DA_PLATAFORMA],
    comoB: { status: 200, listaVazia: true },
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/imports/route.ts",
    metodo: "GET",
    caminho: "/api/v1/imports",
    executar: async (req) => (await import("@/app/api/v1/imports/route")).GET(req),
    linhas: LINHAS_DAS_IMPORTACOES,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "imports",
    soDeA: [LOTE_A],
    soDeB: [LOTE_B],
    comoB: { status: 200, listaVazia: true },
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/imports/[id]/route.ts",
    metodo: "GET",
    caminho: `/api/v1/imports/${LOTE_A}`,
    executar: async (req) =>
      (await import("@/app/api/v1/imports/[id]/route")).GET(req, {
        params: Promise.resolve({ id: LOTE_A }),
      }),
    linhas: LINHAS_DAS_IMPORTACOES,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "imports",
    soDeA: [LOTE_A, LINHA_A],
    soDeB: [LOTE_B, LINHA_B, LINHA_B_NO_LOTE_DE_A],
    comoB: { status: 404, codigo: "not_found" },
    clienteDaSessao: true,
  },
  {
    rota: "app/api/v1/imports/route.ts",
    metodo: "POST",
    caminho: "/api/v1/imports",
    executar: async (req) => (await import("@/app/api/v1/imports/route")).POST(req),
    corpo: planilha,
    linhas: LINHAS_DAS_IMPORTACOES,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "imports",
    soDeA: [],
    soDeB: [LOTE_B],
    // POST que cria: B cria o lote DELE; nada da A é lido nem alterado.
    comoB: { status: 201, cria: true },
    audita: "imports.companies_people",
    autorDaLinha: {
      tabela: "import_batches",
      coluna: "created_by",
      eDaCriacao: (linha) => linha.filename === "contatos.csv",
    },
    clienteDaSessao: true,
  },
];

// ───────────────────────────── ajudantes ─────────────────────────────

const ORDEM: readonly Papel[] = ["viewer", "agent", "manager", "admin"];

function umDegrauAbaixo(papel: Papel): Papel | null {
  const i = ORDEM.indexOf(papel);
  return i > 0 ? (ORDEM[i - 1] ?? null) : null;
}

function falsoDe(org: string, linhas: Tabelas): Falso {
  return criarClienteAdminFalso({
    orgDona: org,
    linhas,
    rpc: RPC,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
}

/** O cenário sem nenhuma linha da organização `org` (as da instalação ficam). */
function semLinhasDe(org: string, linhas: Tabelas): Tabelas {
  return Object.fromEntries(
    Object.entries(linhas).map(([tabela, lista]) => [
      tabela,
      lista.filter((l) => l.organization_id !== org),
    ]),
  );
}

/** As cadeias de tabela da organização (as da instalação, lidas antes do portão, não contam). */
function cadeiasDeDado(f: Falso) {
  const instalacao: readonly string[] = SEM_ORGANIZACAO;
  return f.cadeias.filter((c) => !instalacao.includes(c.tabela));
}

function linhasMudadas(antes: Tabelas, depois: Tabelas) {
  const mudadas: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
  for (const [tabela, lista] of Object.entries(depois)) {
    const antigas = new Set((antes[tabela] ?? []).map((l) => JSON.stringify(l)));
    for (const linha of lista) {
      if (!antigas.has(JSON.stringify(linha))) mudadas.push({ tabela, linha });
    }
  }
  return mudadas;
}

function camposDeAutorComOToken(linhas: Tabelas, id: string): string[] {
  const achados: string[] = [];
  for (const [tabela, lista] of Object.entries(linhas)) {
    for (const linha of lista) {
      for (const [coluna, valor] of Object.entries(linha)) {
        if ((coluna.endsWith("_by") || coluna.endsWith("_by_user_id")) && valor === id) {
          achados.push(`${tabela}.${coluna}`);
        }
      }
    }
  }
  return achados;
}

function emitirTokens(opcoes: { scopes: string[]; role: Papel }): void {
  vi.mocked(validateBearerToken).mockImplementation(async (cabecalho) => {
    const quem = cabecalho?.includes(TOKEN_B)
      ? { org: ORG_B, id: TOKEN_B }
      : cabecalho?.includes(TOKEN_A)
        ? { org: ORG_A, id: TOKEN_A }
        : null;
    if (!quem) throw new McpAuthError(-32001, 401, "Invalid token.");
    return {
      organizationId: quem.org,
      role: opcoes.role,
      actor: { type: "api_token", id: quem.id, role: opcoes.role },
      apiTokenId: quem.id,
      scopes: opcoes.scopes,
    };
  });
}

function requisicao(c: Caso, headers: Record<string, string>): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: c.metodo, headers };
  if (c.corpo) init.body = c.corpo();
  return new NextRequest(`http://localhost${c.caminho}`, init);
}

type Corpo = { error?: { code?: string }; data?: unknown };

async function ler(res: Response): Promise<{ texto: string; json: Corpo }> {
  const texto = await res.text();
  return { texto, json: texto ? (JSON.parse(texto) as Corpo) : {} };
}

function comToken(qual: "A" | "B"): Record<string, string> {
  return { authorization: `Bearer ${qual === "A" ? TOKEN_A : TOKEN_B}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(createAdminClient).mockImplementation(() => {
    throw new Error("cliente admin sem cenário");
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("sessão consultada no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(audit).mockResolvedValue(undefined);
  vi.mocked(listarContas).mockImplementation(async (token) => ({
    ok: true as const,
    dados: [{ id: `act_de_${token}`, nome: `Conta de ${token}`, moeda: "BRL", status: 1 }],
  }));
  vi.mocked(lerCampanhas).mockImplementation(async (token) => ({
    ok: true as const,
    dados: [
      {
        id: `camp_${token}`,
        name: `Campanha de ${token}`,
        status: "ACTIVE",
        effective_status: "ACTIVE",
        objective: "OUTCOME_LEADS",
      },
    ],
  }));
  vi.mocked(lerInsights).mockImplementation(async (token) => ({
    ok: true as const,
    dados: [
      { campaign_id: `camp_${token}`, campaign_name: `Campanha de ${token}`, spend: "10.5", impressions: "1000" },
    ],
  }));
});

// ───────────────────────────── os seis testes por caso ─────────────────────────────

for (const c of CASOS) {
  const rotulo = `${c.metodo} ${c.caminho}`;
  const papelDoToken = c.papelDoToken ?? c.papel;

  describe(`token por área — ${rotulo}`, () => {
    it(`${rotulo}: token de A alcança o recurso de A`, async () => {
      const entrada = c.linhas;
      const f = falsoDe(ORG_A, entrada);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));
      const { texto } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of [...c.soDeB, ...(c.deNinguem ?? [])]) expect(texto).not.toContain(marca);

      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_A)).toEqual([]);
      // Controle de vacuidade: a rota leu mesmo alguma tabela da organização.
      expect(cadeiasDeDado(f).length).toBeGreaterThan(0);
      // Tudo o que a rota criou ou alterou é da organização A.
      const mudadas = linhasMudadas(entrada, f.linhas).filter(
        (m) => !(SEM_ORGANIZACAO as readonly string[]).includes(m.tabela),
      );
      expect(mudadas.filter((m) => m.linha.organization_id !== ORG_A)).toEqual([]);
      // Nenhuma coluna de autor recebe o id do token.
      expect(camposDeAutorComOToken(f.linhas, TOKEN_A)).toEqual([]);

      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      if (c.metodo !== "GET") expect(requireSupportWrite).toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            organizationId: ORG_A,
            action: c.audita,
            actorUserId: null,
            actorApiTokenId: TOKEN_A,
          }),
        );
        expect(mudadas.length).toBeGreaterThan(0);
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
      if (c.autorDaLinha) {
        const { tabela, coluna, eDaCriacao } = c.autorDaLinha;
        const criada = (f.linhas[tabela] ?? []).find(eDaCriacao);
        expect(criada, "a linha criada não apareceu").toBeDefined();
        expect(criada?.[coluna]).toBeNull();
      }
    });

    it(`${rotulo}: token de B não alcança o recurso de A`, async () => {
      // As linhas de B saem do cenário: o recurso de A existe, e B não tem nada.
      const entrada = semLinhasDe(ORG_B, c.linhas);
      const f = falsoDe(ORG_B, entrada);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto, json } = await ler(res);

      // Recurso inexistente para B: o que a rota devolve está na tabela `comoB`.
      expect(res.status).toBe(c.comoB.status);
      if (c.comoB.codigo) expect(json.error?.code).toBe(c.comoB.codigo);
      if (c.comoB.listaVazia) expect(json.data).toEqual([]);
      for (const marca of [...c.soDeA, ...(c.deNinguem ?? [])]) expect(texto).not.toContain(marca);

      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_B)).toEqual([]);
      expect(cadeiasDeDado(f).length).toBeGreaterThan(0);
      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      c.aoFimDeB?.();

      const mudadas = linhasMudadas(entrada, f.linhas).filter(
        (m) => !(SEM_ORGANIZACAO as readonly string[]).includes(m.tabela),
      );
      if (c.comoB.cria) {
        // A linha criada é da B, e nenhuma linha da A foi lida ou alterada: as
        // cadeias acima já ficaram todas dentro de ORG_B, e aqui as linhas.
        expect(mudadas.length).toBeGreaterThan(0);
        expect(mudadas.filter((m) => m.linha.organization_id !== ORG_B)).toEqual([]);
        expect(f.linhas.import_batches?.filter((l) => l.organization_id === ORG_A)).toEqual(
          entrada.import_batches?.filter((l) => l.organization_id === ORG_A),
        );
        expect(audit).toHaveBeenCalled();
        for (const [chamada] of vi.mocked(audit).mock.calls) {
          expect(chamada).toEqual(
            expect.objectContaining({ organizationId: ORG_B, actorUserId: null, actorApiTokenId: TOKEN_B }),
          );
        }
      } else {
        expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
        expect(mudadas).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${rotulo}: token sem o escopo da operação é recusado`, async () => {
      const f = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      // O escopo da OUTRA operação: `mcp:read` num método de escrita, `mcp:write` num GET.
      const outro: Escopo = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      emitirTokens({ scopes: [outro], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(403);
      expect(cadeiasDeDado(f)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    const abaixo = umDegrauAbaixo(papelDoToken);
    if (abaixo) {
      it(`${rotulo}: token abaixo do papel é recusado`, async () => {
        const f = falsoDe(ORG_A, c.linhas);
        vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
        emitirTokens({ scopes: [c.escopo], role: abaixo });

        const res = await c.executar(requisicao(c, comToken("A")));

        expect(res.status).toBe(403);
        expect(cadeiasDeDado(f)).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }
    // Papel `viewer` não tem degrau abaixo: não existe token de papel menor que
    // ele, então o caso "abaixo do papel" não existe para `GET /imports` e
    // `GET /imports/[id]`.

    it(`${rotulo}: acima do teto do token → 429`, async () => {
      const f = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recurso}:tok:${TOKEN_A}`);
      // Nenhuma cadeia de dado da organização: o teto vem antes de tocar o banco.
      expect(cadeiasDeDado(f)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${rotulo}: sessão continua com o mesmo portão`, async () => {
      // Sem `Authorization`: o portão é o de sempre, com o papel da tabela.
      const instalacao = falsoDe(ORG_A, c.linhas);
      const sessao = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(instalacao.cliente as never);
      vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
      vi.mocked(requireRole).mockResolvedValue({
        ok: true,
        user: { id: USUARIO, idioma: "pt-BR" },
        org: { orgId: ORG_A, name: "Org", role: c.papel },
      } as never);

      const res = await c.executar(requisicao(c, {}));
      const { texto } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(requireRole).toHaveBeenCalledWith(
        c.papel,
        expect.objectContaining({ resource: c.recurso, ...c.opcoesDaSessao }),
      );
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of [...c.soDeB, ...(c.deNinguem ?? [])]) expect(texto).not.toContain(marca);
      expect(validateBearerToken).not.toHaveBeenCalled();
      // A sessão não tem teto: o contador nem é tocado.
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.clienteDaSessao) expect(cadeiasDeDado(sessao).length).toBeGreaterThan(0);
      expect(cadeiasForaDaOrganizacao(cadeiasDeDado(sessao), ORG_A)).toEqual([]);
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, action: c.audita, actorUserId: USUARIO }),
        );
        for (const [chamada] of vi.mocked(audit).mock.calls) {
          expect(chamada.actorApiTokenId ?? null).toBeNull();
        }
      }
      if (c.autorDaLinha) {
        const { tabela, coluna, eDaCriacao } = c.autorDaLinha;
        const criada = (sessao.linhas[tabela] ?? []).find(eDaCriacao);
        expect(criada?.[coluna]).toBe(USUARIO);
      }
    });
  });
}

// ───────────────────────────── a borda do proxy ─────────────────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * a porta em `PUBLIC_PATHS` o Bearer nem chega à rota: o handler convertido
 * ficaria inalcançável com todos os testes acima verdes. A porta é estreita:
 * forma de UUID no id, `$` no fim, e nenhum irmão literal de carona.
 *
 * Os irmãos vêm do `ls` das pastas: `ads/meta/` (accounts, campaigns: os dois
 * ganharam porta), `audit/` (`export`: segue só de sessão, é exportação de dado
 * pessoal) e `imports/` (`[id]`: ganhou porta; não há irmão literal).
 */
describe("PUBLIC_PATHS — as portas de ads, audit e imports (borda do proxy)", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/ads/meta/accounts",
    "/api/v1/ads/meta/campaigns",
    "/api/v1/audit",
    "/api/v1/imports",
    `/api/v1/imports/${UUID}`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // id fora da forma de UUID
    "/api/v1/imports/abc",
    "/api/v1/imports/00000000-0000-4000-8000-00000000000",
    // sub-path de cada porta
    "/api/v1/ads/meta/accounts/x",
    "/api/v1/ads/meta/campaigns/x",
    "/api/v1/audit/x",
    "/api/v1/imports/x/y",
    `/api/v1/imports/${UUID}/x`,
    // irmãos literais e pais que não ganharam porta
    "/api/v1/audit/export",
    "/api/v1/ads",
    "/api/v1/ads/meta",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as cinco portas estão nos modelos de leitura", () => {
    const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);
    for (const modelo of [
      "/api/v1/ads/meta/accounts",
      "/api/v1/ads/meta/campaigns",
      "/api/v1/audit",
      "/api/v1/imports",
      "/api/v1/imports/[id]",
    ]) {
      expect(caminhos).toContain(modelo);
    }
  });
});
