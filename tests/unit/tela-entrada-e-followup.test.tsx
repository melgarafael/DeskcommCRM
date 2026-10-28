/**
 * A TELA DE ENTRADA E FOLLOW-UP (#3603, fatia 3) — e o que ela grava chega
 * INTEIRO ao motor da fatia 1.
 *
 * ─── Por que este arquivo não é só "o formulário chama a action" ───────────
 *
 * A pergunta que a fatia tem de responder não é "o botão salva?", é "a
 * configuração que a pessoa salvou é a que a PRÓXIMA conversa respeita?". Um
 * teste que só espionasse a server action provaria o clique e deixaria o buraco
 * intacto: a tela poderia mandar `ativa: false` para o motor ligado, ou gravar a
 * etapa no campo errado, e o teste ficaria verde.
 *
 * Por isso o caminho aqui é o de verdade, com dublê de banco no lugar do
 * Postgres: o componente chama a action REAL (`definirEntradaAutomaticaNoFunil`,
 * a da fatia 1 — a tela não tem uma cópia), a action grava no dublê, e o
 * SERVIÇO REAL (`abrirNegocioDaConversaNova`) lê o que ficou gravado e é
 * chamado com a conversa nova. O que se afirma no fim é o negócio criado na
 * etapa escolhida — ou a ausência dele, no controle.
 *
 * ─── Casos ─────────────────────────────────────────────────────────────────
 *
 * 1. ⭐ salvar pela tela e a conversa nova seguinte entra no funil escolhido
 *    (ponta a ponta com dublê);
 * 2. ⭐ desligar pela tela e a conversa nova NÃO entra — e o motor não paga
 *    sequer a consulta do funil (controle da fatia);
 * 3. trocar o funil limpa a etapa: nunca se grava o par impossível;
 * 4. ligar sem funil não chama a action (o botão nasce desabilitado);
 * 5. erro da action aparece na tela e NÃO anuncia "salvo";
 * 6. MFA em dívida leva ao desafio em vez de mostrar erro genérico;
 * 7. ⭐ etapa marcada para follow-up aparece marcada ao RECARREGAR (a tela
 *    re-renderizada com o que ficou gravado);
 * 8. desligar o follow-up de uma etapa preserva prazo e texto (religar não
 *    obriga a escrever de novo);
 * 9. etapa ligada sem prazo/texto não chama a action e diz o que falta;
 * 10. papel abaixo de manager não vê a página (redirect /403) e a action recusa;
 * 11. etapa de OUTRA organização é recusada (isolamento por tenant).
 *
 * ─── SABOTAGEM (previsão escrita ANTES) ────────────────────────────────────
 * Ver `cache/scratch/previsao-sabotagem-3603f3.md`. Em resumo: fazer a tela
 * salvar sem chamar a action derruba os casos 1, 2, 7, 8, 9 e 11 — e deixa o 10
 * verde de propósito, porque a recusa de papel mora na action, não no clique.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  requireAuth: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  irAoDesafioDeMfa: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  requireAuth: mocks.requireAuth,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth/ir-ao-desafio-de-mfa", () => ({ irAoDesafioDeMfa: mocks.irAoDesafioDeMfa }));

import { toast } from "sonner";

import { abrirNegocioDaConversaNova } from "@/lib/leads/entrada-automatica-no-funil";
import { followupPorEtapaDeclarado } from "@/lib/schemas/settings";

import { definirFollowupPorEtapa } from "@/app/actions/settings/definirFollowupPorEtapa";
import EntradaEFollowupPage from "@/app/app/settings/entrada-e-followup/page";
import { EntradaNoFunilForm } from "@/app/app/settings/entrada-e-followup/_entrada";
import { FollowupPorEtapaForm } from "@/app/app/settings/entrada-e-followup/_followup";
import type { FunilDaTela } from "@/app/app/settings/entrada-e-followup/_tipos";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "12121212-1212-4121-8121-121212121212";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA_ESCOLHIDA = "77777777-7777-4777-8777-777777777777";
const ETAPA_ABERTA = "88888888-8888-4888-8888-888888888888";
const LIDA = "99999999-9999-4999-8999-999999999999";
const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };

interface EtapaDoDuble {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_archived: boolean;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * O DUBLÊ DE BANCO — um PostgREST mínimo, encadeável, com o ESTADO vivo.
 *
 * O estado é o ponto: a action da fatia 1 grava `settings` aqui e o serviço da
 * fatia 1 lê `settings` DAQUI. Sem estado compartilhado o "ponta a ponta" seria
 * dois testes separados com a mesma piada.
 */
interface Estado {
  settings: Record<string, unknown>;
  funis: Array<{ id: string; organization_id: string; name: string; is_archived: boolean }>;
  etapas: EtapaDoDuble[];
  contato: Record<string, unknown> | null;
  escritas: Array<{ tabela: string; payload: unknown }>;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
  consultadas: string[];
  leadId: string | null;
}

let estado: Estado;

function linhaDe(tabela: string, filtros: Record<string, unknown>, id: string): unknown {
  if (tabela === "organizations") return { settings: estado.settings };
  if (tabela === "crm_pipelines") {
    const achado = estado.funis.find(
      (funil) =>
        funil.id === (filtros.id ?? id) &&
        funil.organization_id === filtros.organization_id &&
        funil.is_archived === false,
    );
    return achado ? { id: achado.id } : null;
  }
  if (tabela === "crm_stages") {
    const candidatas = estado.etapas
      .filter(
        (etapa) =>
          etapa.organization_id === filtros.organization_id &&
          (filtros.pipeline_id === undefined || etapa.pipeline_id === filtros.pipeline_id) &&
          etapa.is_archived === false &&
          etapa.is_won === false &&
          etapa.is_lost === false,
      )
      .sort((a, b) => a.position - b.position);
    // Sem `id` no filtro, o banco responde a PRIMEIRA etapa aberta — é o que
    // `primeiraEtapaAberta` pede quando a etapa declarada não vale.
    const procurada = (filtros.id ?? id) as string;
    const achado = procurada === "" ? candidatas[0] : candidatas.find((e) => e.id === procurada);
    return achado ? { id: achado.id } : null;
  }
  if (tabela === "contacts") return estado.contato;
  return null;
}

function listaDe(
  tabela: string,
  filtros: Record<string, unknown>,
  lista: Record<string, unknown[]>,
): unknown[] {
  if (tabela === "crm_pipelines") {
    return estado.funis
      .filter((funil) => funil.organization_id === filtros.organization_id && !funil.is_archived)
      .map((funil) => ({ id: funil.id, name: funil.name }));
  }
  if (tabela === "crm_stages") {
    const ids = lista.id as string[] | undefined;
    return estado.etapas
      .filter(
        (etapa) =>
          etapa.organization_id === filtros.organization_id &&
          etapa.is_archived === false &&
          etapa.is_won === false &&
          etapa.is_lost === false &&
          (!ids || ids.includes(etapa.id)),
      )
      .map((etapa) => ({ id: etapa.id }));
  }
  return [];
}

function bancoFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const listas: Record<string, unknown[]> = {};
      let payload: unknown;
      let escrevendo = false;
      const api: Record<string, unknown> = {};
      api.select = () => api;
      api.order = () => api;
      api.limit = () => api;
      api.update = (novo: unknown) => {
        payload = novo;
        escrevendo = true;
        return api;
      };
      api.insert = async (novo: unknown) => {
        estado.escritas.push({ tabela, payload: novo });
        return { error: null };
      };
      api.in = (coluna: string, valores: unknown[]) => {
        listas[coluna] = valores;
        return api;
      };
      api.eq = (coluna: string, valor: unknown) => {
        if (escrevendo) {
          estado.escritas.push({ tabela, payload });
          if (tabela === "organizations") {
            const novo = (payload ?? {}) as { settings?: Record<string, unknown> };
            if (novo.settings) estado.settings = novo.settings;
          }
          return Promise.resolve({ error: null });
        }
        filtros[coluna] = valor;
        return api;
      };
      api.maybeSingle = async () => {
        estado.consultadas.push(tabela);
        return { data: linhaDe(tabela, filtros, String(filtros.id ?? "")), error: null };
      };
      // O builder do Supabase é "thenable": `await` na cadeia devolve a lista.
      api.then = (resolve: (valor: unknown) => unknown, reject: (erro: unknown) => unknown) => {
        estado.consultadas.push(tabela);
        try {
          return Promise.resolve({ data: listaDe(tabela, filtros, listas), error: null }).then(
            resolve,
            reject,
          );
        } catch (erro) {
          return Promise.reject(erro).then(resolve, reject);
        }
      };
      return api;
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      estado.rpcs.push({ nome, args });
      if (nome === "fn_nascer_lead_da_conversa") return { data: estado.leadId, error: null };
      return { data: null, error: null };
    },
  };
}

const CATALOGO: FunilDaTela[] = [
  {
    id: FUNIL,
    name: "Comercial",
    etapas: [
      { id: ETAPA_ABERTA, name: "Novo" },
      { id: ETAPA_ESCOLHIDA, name: "Em conversa" },
    ],
  },
];

const SEM_CONFIG = { ativa: false, pipeline_id: null, stage_id: null };

beforeEach(() => {
  vi.clearAllMocks();
  estado = {
    settings: { branding: { accent_hex: "#123456" } },
    funis: [{ id: FUNIL, organization_id: ORG, name: "Comercial", is_archived: false }],
    etapas: [
      {
        id: ETAPA_ABERTA,
        organization_id: ORG,
        pipeline_id: FUNIL,
        name: "Novo",
        position: 1,
        is_archived: false,
        is_won: false,
        is_lost: false,
      },
      {
        id: ETAPA_ESCOLHIDA,
        organization_id: ORG,
        pipeline_id: FUNIL,
        name: "Em conversa",
        position: 2,
        is_archived: false,
        is_won: false,
        is_lost: false,
      },
      // A etapa de OUTRA organização: existe no banco, não é desta empresa.
      {
        id: "abababab-abab-4bab-8bab-abababababab",
        organization_id: OUTRA_ORG,
        pipeline_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        name: "Etapa da vizinha",
        position: 1,
        is_archived: false,
        is_won: false,
        is_lost: false,
      },
    ],
    contato: { is_blocked: false, is_personal: false, display_name: "Fulana", phone_number: null },
    escritas: [],
    rpcs: [],
    consultadas: [],
    leadId: LIDA,
  };
  mocks.createAdminClient.mockReturnValue(bancoFalso());
  mocks.createClient.mockResolvedValue(bancoFalso());
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.requireAuth.mockResolvedValue({
    ...USER,
    idioma: "pt-BR",
    is_platform_admin: false,
  });
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "manager" });
  mocks.mfaEmDivida.mockResolvedValue(false);
});

/** O que a action da fatia 1 deixou gravado no dublê. */
const entradaGravada = () =>
  estado.settings.entrada_automatica_no_funil as
    | { ativa?: boolean; pipeline_id?: string | null; stage_id?: string | null }
    | undefined;

describe("entrada automática no funil — o que a tela salva é o que a conversa respeita", () => {
  it("salvar pela tela e a conversa NOVA seguinte entra na etapa escolhida", async () => {
    render(<EntradaNoFunilForm inicial={SEM_CONFIG} funis={CATALOGO} idioma="pt-BR" />);

    fireEvent.click(screen.getByTestId("entrada-ativa"));
    fireEvent.change(screen.getByTestId("funil-da-entrada"), { target: { value: FUNIL } });
    fireEvent.change(screen.getByTestId("etapa-da-entrada"), {
      target: { value: ETAPA_ESCOLHIDA },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar entrada automática" }));

    await waitFor(() =>
      expect(entradaGravada()).toEqual({
        ativa: true,
        pipeline_id: FUNIL,
        stage_id: ETAPA_ESCOLHIDA,
      }),
    );

    // ─── o motor de verdade, sobre o que a tela acabou de gravar ────────────
    const resultado = await abrirNegocioDaConversaNova(bancoFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
      conversationId: CONVERSA,
    });

    expect(resultado).toEqual({
      criado: true,
      leadId: LIDA,
      pipelineId: FUNIL,
      stageId: ETAPA_ESCOLHIDA,
    });
    // E o resto do `settings` continua onde estava: a gravação é da chave, não
    // do objeto inteiro.
    expect(estado.settings.branding).toEqual({ accent_hex: "#123456" });
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it("desligar pela tela: a próxima conversa NÃO entra — e o motor nem consulta o funil", async () => {
    estado.settings.entrada_automatica_no_funil = {
      ativa: true,
      pipeline_id: FUNIL,
      stage_id: ETAPA_ESCOLHIDA,
    };
    render(
      <EntradaNoFunilForm
        inicial={{ ativa: true, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA }}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    fireEvent.click(screen.getByTestId("entrada-ativa"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar entrada automática" }));

    await waitFor(() => expect(entradaGravada()).toMatchObject({ ativa: false }));
    // Desligar NÃO apaga a escolha: religar não obriga a escolher de novo.
    expect(entradaGravada()).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA });

    estado.consultadas = [];
    const resultado = await abrirNegocioDaConversaNova(bancoFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
      conversationId: CONVERSA,
    });

    expect(resultado).toEqual({ criado: false, motivo: "nao_configurado" });
    expect(estado.consultadas).toEqual(["organizations"]);
    expect(estado.rpcs).toEqual([]);
  });

  it("trocar o funil limpa a etapa: o par impossível não é gravado", async () => {
    render(
      <EntradaNoFunilForm
        inicial={{ ativa: true, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA }}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    fireEvent.change(screen.getByTestId("funil-da-entrada"), { target: { value: "" } });
    expect(screen.getByTestId("etapa-da-entrada")).toHaveValue("");

    fireEvent.change(screen.getByTestId("funil-da-entrada"), { target: { value: FUNIL } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar entrada automática" }));

    await waitFor(() =>
      expect(entradaGravada()).toEqual({ ativa: true, pipeline_id: FUNIL, stage_id: null }),
    );
    // Sem etapa, o motor usa a primeira etapa aberta — e é isso que ele faz.
    const resultado = await abrirNegocioDaConversaNova(bancoFalso() as never, {
      organizationId: ORG,
      contactId: CONTATO,
      conversationId: CONVERSA,
    });
    expect(resultado).toMatchObject({ criado: true, stageId: ETAPA_ABERTA });
  });

  it("ligar sem funil não salva: o botão fica desabilitado e nada é gravado", async () => {
    render(<EntradaNoFunilForm inicial={SEM_CONFIG} funis={CATALOGO} idioma="pt-BR" />);

    fireEvent.click(screen.getByTestId("entrada-ativa"));
    expect(screen.getByRole("button", { name: "Salvar entrada automática" })).toBeDisabled();
    expect(entradaGravada()).toBeUndefined();
  });

  it("recusa da action aparece na tela e NÃO anuncia salvo", async () => {
    // A etapa existe, mas a action vai achá-la fora da empresa: o dublê passa a
    // responder como se o funil tivesse sido arquivado entre abrir e salvar.
    estado.funis = [];
    render(
      <EntradaNoFunilForm
        inicial={{ ativa: true, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA }}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Salvar entrada automática" }));

    await waitFor(() =>
      expect(screen.getByTestId("entrada-erro")).toHaveTextContent(
        "Este funil não existe mais nesta empresa. Escolha outro.",
      ),
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(entradaGravada()).toBeUndefined();
  });

  it("MFA em dívida manda para o desafio, não para uma frase de erro", async () => {
    mocks.mfaEmDivida.mockResolvedValue(true);
    render(
      <EntradaNoFunilForm
        inicial={{ ativa: true, pipeline_id: FUNIL, stage_id: ETAPA_ESCOLHIDA }}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Salvar entrada automática" }));

    await waitFor(() => expect(mocks.irAoDesafioDeMfa).toHaveBeenCalled());
    expect(screen.getByTestId("entrada-erro")).not.toHaveTextContent("Não consegui salvar agora.");
    expect(entradaGravada()).toBeUndefined();
  });
});

describe("follow-up por etapa", () => {
  it("etapa marcada e salva aparece marcada AO RECARREGAR", async () => {
    const { unmount } = render(
      <FollowupPorEtapaForm inicial={{}} funis={CATALOGO} idioma="pt-BR" />,
    );

    const linha = within(screen.getByTestId(`etapa-${ETAPA_ESCOLHIDA}`));
    expect(linha.getByText("Sem follow-up automático")).toBeVisible();

    fireEvent.click(screen.getByTestId(`followup-ativa-${ETAPA_ESCOLHIDA}`));
    fireEvent.change(screen.getByTestId(`followup-prazo-${ETAPA_ESCOLHIDA}`), {
      target: { value: "24" },
    });
    fireEvent.change(screen.getByTestId(`followup-mensagem-${ETAPA_ESCOLHIDA}`), {
      target: { value: "Oi! Consigo te ajudar a seguir?" },
    });
    fireEvent.click(screen.getByTestId("salvar-followup"));

    await waitFor(() =>
      expect(followupPorEtapaDeclarado(estado.settings)[ETAPA_ESCOLHIDA]).toEqual({
        ativa: true,
        prazo_horas: 24,
        mensagem: "Oi! Consigo te ajudar a seguir?",
      }),
    );
    // A etapa que ninguém marcou continua desligada — e foi gravada assim.
    expect(followupPorEtapaDeclarado(estado.settings)[ETAPA_ABERTA]).toEqual({
      ativa: false,
      prazo_horas: null,
      mensagem: null,
    });

    // ─── RELOAD: a tela nasce de novo do que o banco tem ───────────────────
    unmount();
    render(
      <FollowupPorEtapaForm
        inicial={followupPorEtapaDeclarado(estado.settings)}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    const recarregada = within(screen.getByTestId(`etapa-${ETAPA_ESCOLHIDA}`));
    expect(recarregada.getByText("Marcada para follow-up")).toBeVisible();
    expect(screen.getByTestId(`followup-prazo-${ETAPA_ESCOLHIDA}`)).toHaveValue(24);
    expect(screen.getByTestId(`followup-mensagem-${ETAPA_ESCOLHIDA}`)).toHaveValue(
      "Oi! Consigo te ajudar a seguir?",
    );
    expect(
      within(screen.getByTestId(`etapa-${ETAPA_ABERTA}`)).getByText("Sem follow-up automático"),
    ).toBeVisible();
  });

  it("desligar a etapa preserva prazo e texto — religar não obriga a escrever de novo", async () => {
    estado.settings.followup_por_etapa = {
      [ETAPA_ESCOLHIDA]: { ativa: true, prazo_horas: 48, mensagem: "Voltando ao assunto…" },
    };
    render(
      <FollowupPorEtapaForm
        inicial={followupPorEtapaDeclarado(estado.settings)}
        funis={CATALOGO}
        idioma="pt-BR"
      />,
    );

    fireEvent.click(screen.getByTestId(`followup-ativa-${ETAPA_ESCOLHIDA}`));
    fireEvent.click(screen.getByTestId("salvar-followup"));

    await waitFor(() =>
      expect(followupPorEtapaDeclarado(estado.settings)[ETAPA_ESCOLHIDA]).toEqual({
        ativa: false,
        prazo_horas: 48,
        mensagem: "Voltando ao assunto…",
      }),
    );
  });

  it("ligar sem prazo (ou sem texto) não salva e diz o que falta", async () => {
    render(<FollowupPorEtapaForm inicial={{}} funis={CATALOGO} idioma="pt-BR" />);

    fireEvent.click(screen.getByTestId(`followup-ativa-${ETAPA_ESCOLHIDA}`));
    fireEvent.click(screen.getByTestId("salvar-followup"));

    await waitFor(() =>
      expect(screen.getByTestId("followup-erro")).toHaveTextContent(
        "Toda etapa ligada precisa de prazo e de modelo de mensagem.",
      ),
    );
    expect(estado.settings.followup_por_etapa).toBeUndefined();
  });

  it("etapa de OUTRA organização é recusada pela action, e a tela diz por quê", async () => {
    const alheia = "abababab-abab-4bab-8bab-abababababab";
    // A tela renderiza uma etapa que a empresa vizinha é dona (situação de
    // corrida: a etapa foi movida depois que a página abriu).
    const catalogoAlheio: FunilDaTela[] = [
      ...CATALOGO,
      { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", name: "Da vizinha", etapas: [{ id: alheia, name: "Etapa da vizinha" }] },
    ];
    render(<FollowupPorEtapaForm inicial={{}} funis={catalogoAlheio} idioma="pt-BR" />);

    fireEvent.click(screen.getByTestId(`followup-ativa-${alheia}`));
    fireEvent.change(screen.getByTestId(`followup-prazo-${alheia}`), { target: { value: "12" } });
    fireEvent.change(screen.getByTestId(`followup-mensagem-${alheia}`), {
      target: { value: "Oi" },
    });
    fireEvent.click(screen.getByTestId("salvar-followup"));

    await waitFor(() =>
      expect(screen.getByTestId("followup-erro")).toHaveTextContent(
        "Uma das etapas mudou enquanto a tela estava aberta. Recarregue.",
      ),
    );
    expect(estado.settings.followup_por_etapa).toBeUndefined();
  });
});

describe("quem entra na tela", () => {
  it("atendente não vê a página: cai em /403", async () => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "agent" });

    await expect(EntradaEFollowupPage()).rejects.toThrow("REDIRECT:/403");
  });

  it("gerente vê a página com as duas seções", async () => {
    render(await EntradaEFollowupPage());

    expect(screen.getByText("Entrada automática no funil")).toBeVisible();
    expect(screen.getByText("Follow-up por etapa")).toBeVisible();
  });

  it("a action recusa papel abaixo de manager mesmo fora da tela", async () => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "agent" });
    const r = await definirFollowupPorEtapa({
      etapas: [{ stage_id: ETAPA_ESCOLHIDA, ativa: false, prazo_horas: null, mensagem: null }],
    });

    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(estado.settings.followup_por_etapa).toBeUndefined();
  });
});
