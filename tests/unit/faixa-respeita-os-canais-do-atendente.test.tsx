/**
 * A FAIXA CONSULTA OS CANAIS COM O CLIENTE DA SESSÃO.
 *
 * Executa layout e seam reais com dois clientes dublês. A assimetria das
 * respostas prova que o layout entrega a identidade da sessão ao seam e não
 * usa service_role para ler channel_sessions.
 *
 * O recorte por atendente é SIMULADO pelo array policy.linhas. A SELECT nativa
 * é por organização, com acesso de plataforma, e não contém esse vínculo.
 * Este unitário não executa uma policy nem reproduz a instalação derivada do
 * relato #3088. Se a restrição dela estiver só num patch da rota, a troca de
 * cliente não leva esse filtro ao layout.
 *
 * No cenário simulado, o controle positivo exige o próprio canal caído e o
 * controle administrativo exige os dois. Assim, esconder toda a lista também
 * reprova. As asserções protegem o payload entregue à faixa; renderização e
 * CTA por papel têm cerca em conexao-caida-banner-papel.test.tsx.
 */
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";

/** O canal do próprio atendente, e o do outro setor — os dois caídos. */
const CANAL_DO_ATENDENTE = {
  id: "sess-vendas",
  display_name: "Vendas",
  phone_number: "5511900000001",
  status: "FAILED",
  waha_session_name: "vendas-1",
};
/**
 * Sem apelido configurado, de propósito: é o pior caso do vazamento, e o que a
 * faixa mostrava era exatamente isto — o NÚMERO do outro setor como rótulo.
 */
const CANAL_DO_OUTRO_SETOR = {
  id: "sess-suporte",
  display_name: null,
  phone_number: "5511900000002",
  status: "SCAN_QR_CODE",
  waha_session_name: "suporte-1",
};

const pedidos = { sessao: [] as string[], servico: [] as string[] };

/**
 * Cliente PostgREST de mentira, encadeável, que devolve as linhas da tabela.
 * `rotas["channel_sessions"]` é o que cada cliente enxerga — e é aí que os dois
 * dublês divergem.
 */
function clienteFalso(rotas: Record<string, unknown[]>, registro: string[]) {
  return {
    from(tabela: string) {
      registro.push(tabela);
      const linhas = rotas[tabela] ?? [];
      const consulta: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "is", "order", "limit", "in", "neq", "not"]) {
        consulta[metodo] = () => consulta;
      }
      const resposta = async () => ({ data: linhas, error: null });
      consulta.maybeSingle = async () => ({ data: linhas[0] ?? null, error: null });
      consulta.single = consulta.maybeSingle;
      consulta.then = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
        resposta().then(ok, falha);
      return consulta;
    },
  };
}

const ORGANIZACAO = [
  { onboarded_at: "2026-01-01", status: "active", settings: null, timezone: null },
];

/**
 * As linhas ficam num OBJETO, e não numa variável solta: o dublê guarda a
 * referência do array, e trocar o array por outro a cada caso deixaria o dublê
 * respondendo a lista antiga — um teste que passaria sem medir nada.
 */
const policy = { linhas: [] as unknown[] };
let papel: "agent" | "admin" = "agent";

const clienteDaSessao = clienteFalso(
  { channel_sessions: policy.linhas, organizations: ORGANIZACAO },
  pedidos.sessao,
);
/**
 * `service_role`: responde a organização INTEIRA em `channel_sessions`, como a
 * RLS atravessada responde de verdade. É o cliente do defeito.
 */
const clienteDeServico = clienteFalso(
  { channel_sessions: [CANAL_DO_ATENDENTE, CANAL_DO_OUTRO_SETOR], organizations: ORGANIZACAO },
  pedidos.servico,
);

// O seam é o REAL: se ele deixasse de ser chamado pelo layout, este arquivo não
// mediria nada. Só os clientes são dublês.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteDaSessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteDeServico }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "atendente-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: papel, interface_settings: null }),
  isMfaEnrolled: async () => true,
  exigirProvaDeMfa: async () => {},
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect inesperado para ${destino}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

function achar(no: ReactNode, alvo: unknown): ReactElement | null {
  if (!no || typeof no !== "object") return null;
  if (Array.isArray(no)) {
    for (const filho of no) {
      const achado = achar(filho as ReactNode, alvo);
      if (achado) return achado;
    }
    return null;
  }
  const elemento = no as ReactElement<{ children?: ReactNode }>;
  if (elemento.type === alvo) return elemento;
  return achar(elemento.props?.children, alvo);
}

type Caida = { id: string; apelido: string; status: string };

/** Executa o layout de verdade e devolve o payload que chegou à faixa. */
async function payloadDaFaixa(orgId: string): Promise<Caida[] | null> {
  const { ConexaoCaidaBanner } = await import("@/components/app/ConexaoCaidaBanner");
  const { default: AppLayout } = await import("@/app/app/layout");

  const arvore = (await AppLayout({ children: null })) as ReactElement;
  const faixa = achar(arvore, ConexaoCaidaBanner) as ReactElement<{ caidas: Caida[] }> | null;
  if (!faixa) return null;
  expect(orgId).toBe(ORG);
  return faixa.props.caidas;
}

function aPolicyDevolve(...linhas: unknown[]) {
  policy.linhas.length = 0;
  policy.linhas.push(...linhas);
}

beforeEach(() => {
  pedidos.sessao.length = 0;
  pedidos.servico.length = 0;
  policy.linhas.length = 0;
  papel = "agent";
});

describe("a faixa de conexão caída respeita os canais do atendente", () => {
  it("atendente restrito NÃO recebe o canal do outro setor — nem apelido, nem número", async () => {
    aPolicyDevolve(CANAL_DO_ATENDENTE);

    const caidas = await payloadDaFaixa(ORG);

    expect(caidas).not.toBeNull();
    expect(caidas!.map((c) => c.id)).toEqual(["sess-vendas"]);
    // A asserção que interessa não é só o id: o que vazava era o apelido e o
    // número, e é eles que o componente põe na tela.
    const payload = JSON.stringify(caidas);
    expect(payload).not.toContain("Suporte");
    expect(payload).not.toContain("5511900000002");
  });

  it("CONTROLE POSITIVO: o mesmo atendente continua vendo o próprio canal caído", async () => {
    aPolicyDevolve(CANAL_DO_ATENDENTE);

    const caidas = await payloadDaFaixa(ORG);

    // Sem este caso, "esconder tudo" passaria como conserto. Ele mede PRESENÇA,
    // e só isso: afirmar aqui a lista exata repetiria a ausência do caso
    // anterior, e os dois ficariam vermelhos juntos — a sabotagem não
    // conseguiria mostrar que este é o que distingue "filtrou" de "escondeu".
    expect(caidas!.map((c) => c.id)).toContain("sess-vendas");
    expect(caidas!.find((c) => c.id === "sess-vendas")?.apelido).toBe("Vendas");
    expect(caidas!.find((c) => c.id === "sess-vendas")?.status).toBe("FAILED");
  });

  it("admin vê os DOIS canais — a visão administrativa completa fica preservada", async () => {
    papel = "admin";
    aPolicyDevolve(CANAL_DO_ATENDENTE, CANAL_DO_OUTRO_SETOR);

    const caidas = await payloadDaFaixa(ORG);

    expect(caidas!.map((c) => c.apelido)).toEqual(["Vendas", "5511900000002"]);
  });

  it("quem pergunta pelos canais é o cliente da SESSÃO, nunca o de serviço", async () => {
    aPolicyDevolve(CANAL_DO_ATENDENTE);

    await payloadDaFaixa(ORG);

    // A leitura existiu, e foi pela identidade do usuário — é ela que faz a
    // policy valer. Este caso é o que reprova a volta do `createAdminClient`
    // mesmo que o dublê da sessão viesse a responder tudo.
    expect(pedidos.sessao).toContain("channel_sessions");
    expect(pedidos.servico).not.toContain("channel_sessions");
  });

  it("sem canal visível, a faixa não aparece (falha para o lado do silêncio)", async () => {
    // nada visível

    const caidas = await payloadDaFaixa(ORG);

    // Payload vazio: o componente devolve `null` quando não há conexão caída
    // (`if (caidas.length === 0) return null`), então a faixa não aparece. Some
    // um aviso; nunca aparece um canal que a pessoa não pode ver.
    expect(caidas).toEqual([]);
  });
});
