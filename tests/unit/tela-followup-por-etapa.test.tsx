/**
 * A TELA DO FOLLOW-UP POR ETAPA (#3603) — E O DEFEITO QUE ELA NÃO PODE TER.
 *
 * ─── O que este arquivo vigia ──────────────────────────────────────────────
 *
 * A primeira versão desta tela guardava o prazo em
 * `organizations.settings.followup_por_etapa` e a varredura passou a obedecê-lo
 * no lugar das regras: dois donos para o mesmo prazo. O mantenedor recusou com a
 * razão certa, e a versão de hoje é uma JANELA para `automation_rules` — lê os
 * fluxos de `lead.stage_stale`, mostra os que alcançam cada etapa e grava o
 * prazo NO PRÓPRIO FLUXO.
 *
 * Os dois defeitos que a revisão vai procurar são, por isso, exatamente os dois
 * que estes testes têm de pegar:
 *
 *   1. ⭐ a tela gravar um prazo que NÃO está em nenhum fluxo — o "segundo dono"
 *      voltando pela porta dos fundos. Provado em dois níveis: o pedido de
 *      gravação só nasce de um fluxo lido do banco (`pedidosDePrazo`), e a tela,
 *      ao salvar, só chama a rota de regras com ids que ela recebeu.
 *   2. ⭐ dois fluxos da mesma etapa escondidos atrás de um valor só. Provado
 *      pela contagem de campos: uma etapa com dois fluxos tem DOIS inputs, com
 *      os prazos de cada um, e salvar grava os dois.
 *
 * Os casos marcados com ⭐ são os que a sabotagem derruba (ver o comentário do
 * caso e `sabotagem` no relatório do PR).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
  requireAuth: vi.fn(),
  resolveActiveOrg: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: unknown }) =>
    createElement("a", { href, ...resto }, children as never),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: mocks.requireAuth,
  resolveActiveOrg: mocks.resolveActiveOrg,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch: mocks.patch } }));

import {
  configComNovoPrazo,
  fluxosDaEtapaParada,
  fluxosQueAlcancam,
  pedidosDePrazo,
  type FluxoDeEtapaParada,
} from "@/lib/automation/prazos-da-etapa-parada";
import { FollowupPorEtapaForm } from "@/app/app/settings/followup-por-etapa/_followup";
import FollowupPorEtapaPage from "@/app/app/settings/followup-por-etapa/page";
import type { FunilDaTela } from "@/app/app/settings/followup-por-etapa/_tipos";

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const OUTRO_FUNIL = "45454545-4545-4545-8545-454545454545";
const ETAPA_ABERTA = "77777777-7777-4777-8777-777777777777";
const ETAPA_PROPOSTA = "88888888-8888-4888-8888-888888888888";
const REGRA_2_DIAS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGRA_7_DIAS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REGRA_QUALQUER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REGRA_OUTRO_FUNIL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const CATALOGO: FunilDaTela[] = [
  {
    id: FUNIL,
    name: "Comercial",
    etapas: [
      { id: ETAPA_ABERTA, name: "Novo" },
      { id: ETAPA_PROPOSTA, name: "Proposta" },
    ],
  },
];

/** As regras como o banco devolve: `{dias, pipeline_id, stage_id, proteger_pela_agenda}`. */
const REGRAS = [
  {
    id: REGRA_2_DIAS,
    name: "Proposta em 2 dias",
    is_active: true,
    actions: [{ type: "send_whatsapp_message", config: { texto: "Oi!" } }],
    trigger_config: {
      dias: 2,
      pipeline_id: FUNIL,
      stage_id: ETAPA_PROPOSTA,
      proteger_pela_agenda: true,
    },
  },
  {
    id: REGRA_7_DIAS,
    name: "Proposta em 7 dias",
    is_active: true,
    actions: [{ type: "send_ai_message", config: {} }],
    trigger_config: {
      dias: 7,
      pipeline_id: FUNIL,
      stage_id: ETAPA_PROPOSTA,
      proteger_pela_agenda: false,
    },
  },
  {
    id: REGRA_QUALQUER,
    name: "Qualquer etapa, 30 dias",
    is_active: false,
    actions: [],
    trigger_config: { dias: 30, pipeline_id: FUNIL, stage_id: null, proteger_pela_agenda: true },
  },
  {
    id: REGRA_OUTRO_FUNIL,
    name: "Funil de suporte",
    is_active: true,
    actions: [],
    trigger_config: { dias: 3, pipeline_id: OUTRO_FUNIL, stage_id: ETAPA_PROPOSTA, proteger_pela_agenda: false },
  },
];

const FLUXOS: FluxoDeEtapaParada[] = fluxosDaEtapaParada(REGRAS);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue({ data: {} });
});

describe("os fluxos que alcançam a etapa (a mesma régua da varredura)", () => {
  it("lê o trigger_config de etapa parada sem inventar campo de mensagem", () => {
    const fluxo = FLUXOS.find((f) => f.id === REGRA_2_DIAS)!;
    expect(fluxo).toMatchObject({
      dias: 2,
      pipelineId: FUNIL,
      stageId: ETAPA_PROPOSTA,
      ativo: true,
      temMensagem: true,
    });
    // O texto NÃO é campo desta tela: ele vive na ação do fluxo.
    expect(Object.keys(fluxo.config).sort()).toEqual([
      "dias",
      "pipeline_id",
      "proteger_pela_agenda",
      "stage_id",
    ]);
  });

  it("regra sem etapa alcança TODAS as etapas do funil dela", () => {
    const alcancam = fluxosQueAlcancam(FLUXOS, FUNIL, ETAPA_ABERTA).map((f) => f.id);
    expect(alcancam).toEqual([REGRA_QUALQUER]);
    const naProposta = fluxosQueAlcancam(FLUXOS, FUNIL, ETAPA_PROPOSTA).map((f) => f.id);
    expect(naProposta).toEqual([REGRA_2_DIAS, REGRA_7_DIAS, REGRA_QUALQUER]);
  });

  it("regra de outro funil não aparece", () => {
    const ids = fluxosQueAlcancam(FLUXOS, FUNIL, ETAPA_PROPOSTA).map((f) => f.id);
    expect(ids).not.toContain(REGRA_OUTRO_FUNIL);
  });
});

describe("o que o salvar grava — e o que ele nunca grava", () => {
  it("⭐ prazo que não é de nenhum fluxo NÃO vira gravação (a chave órfã morre aqui)", () => {
    // Um rascunho indexado por ID DE ETAPA é exatamente a forma da versão
    // recusada (settings.followup_por_etapa[stage_id]). Ele não tem fluxo
    // correspondente, então não há pedido de gravação para ele.
    const pedidos = pedidosDePrazo({ [ETAPA_PROPOSTA]: "5", [REGRA_2_DIAS]: "4" }, FLUXOS);
    expect(pedidos).toEqual([{ regraId: REGRA_2_DIAS, dias: 4 }]);
    expect(pedidos.map((p) => p.regraId)).not.toContain(ETAPA_PROPOSTA);
  });

  it("prazo igual ao gravado não gera escrita", () => {
    const pedidos = pedidosDePrazo(
      { [REGRA_2_DIAS]: "2", [REGRA_7_DIAS]: "7" },
      FLUXOS,
    );
    expect(pedidos).toEqual([]);
  });

  it("prazo fora de 1..3650 ou não inteiro não gera escrita", () => {
    expect(pedidosDePrazo({ [REGRA_2_DIAS]: "0" }, FLUXOS)).toEqual([]);
    expect(pedidosDePrazo({ [REGRA_2_DIAS]: "3651" }, FLUXOS)).toEqual([]);
    expect(pedidosDePrazo({ [REGRA_2_DIAS]: "2,5" }, FLUXOS)).toEqual([]);
    expect(pedidosDePrazo({ [REGRA_2_DIAS]: "" }, FLUXOS)).toEqual([]);
  });

  it("o PATCH preserva o recorte do fluxo e só troca o prazo", () => {
    const fluxo = FLUXOS.find((f) => f.id === REGRA_2_DIAS)!;
    expect(configComNovoPrazo(fluxo.config, 9)).toEqual({
      dias: 9,
      pipeline_id: FUNIL,
      stage_id: ETAPA_PROPOSTA,
      proteger_pela_agenda: true,
    });
  });
});

describe("a tela: todas as linhas, cada uma com o seu prazo", () => {
  it("⭐ etapa com dois fluxos mostra os DOIS, com o prazo de cada um", () => {
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);

    const daProposta = screen.getByTestId(`etapa-${ETAPA_PROPOSTA}`);
    // Três fluxos alcançam a Proposta: os dois presos nela e o "qualquer etapa".
    expect(daProposta.querySelectorAll("[data-testid^='fluxo-']").length).toBe(3);

    const primeiro = within(daProposta).getByTestId(`prazo-fluxo-${REGRA_2_DIAS}`) as HTMLInputElement;
    const segundo = within(daProposta).getByTestId(`prazo-fluxo-${REGRA_7_DIAS}`) as HTMLInputElement;
    const qualquer = within(daProposta).getByTestId(`prazo-fluxo-${REGRA_QUALQUER}`) as HTMLInputElement;
    expect(primeiro.value).toBe("2");
    expect(segundo.value).toBe("7");
    expect(qualquer.value).toBe("30");

    // Um campo por FLUXO — não existe "o prazo da etapa" agregando os dois.
    expect(daProposta.querySelectorAll("input")).toHaveLength(3);

    // O fluxo "qualquer etapa" aparece em TODAS as etapas que alcança, e não
    // num agregado: dois campos, um por etapa, com o mesmo prazo da regra.
    const emTodas = screen.getAllByTestId(`prazo-fluxo-${REGRA_QUALQUER}`) as HTMLInputElement[];
    expect(emTodas.map((campo) => campo.value)).toEqual(["30", "30"]);
    // Cada cópia tem id próprio e o seu rótulo: com id repetido, o rótulo da 2ª
    // etapa em diante focaria o campo da 1ª.
    expect(new Set(emTodas.map((campo) => campo.id)).size).toBe(emTodas.length);
    for (const campo of emTodas) {
      expect(document.querySelectorAll(`label[for="${campo.id}"]`)).toHaveLength(1);
    }
  });

  it("etapa que nenhum fluxo alcança não ganha campo de prazo", () => {
    render(<FollowupPorEtapaForm fluxos={[]} funis={CATALOGO} idioma="pt-BR" />);
    expect(screen.getByTestId(`etapa-sem-fluxo-${ETAPA_ABERTA}`)).toBeTruthy();
    expect(screen.queryByTestId(`prazo-fluxo-${REGRA_2_DIAS}`)).toBeNull();
    expect(screen.getByTestId("followup-sem-fluxos")).toBeTruthy();
  });

  it("o fluxo com mensagem linka o construtor em vez de abrir campo de texto", () => {
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);
    const link = screen.getByTestId(`construtor-${REGRA_2_DIAS}`) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/app/webhooks/automacoes/${REGRA_2_DIAS}`);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("⭐ salvar grava em CADA fluxo editado, pelo id da regra, sem tocar em settings", async () => {
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);

    fireEvent.change(screen.getByTestId(`prazo-fluxo-${REGRA_2_DIAS}`), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId(`prazo-fluxo-${REGRA_7_DIAS}`), { target: { value: "9" } });
    fireEvent.click(screen.getByTestId("salvar-followup"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));

    const porId = new Map(mocks.patch.mock.calls.map((chamada) => [chamada[0] as string, chamada[1]]));
    expect(porId.get(`/api/v1/automation-rules/${REGRA_2_DIAS}`)).toEqual({
      trigger_event: "lead.stage_stale",
      trigger_config: {
        dias: 3,
        pipeline_id: FUNIL,
        stage_id: ETAPA_PROPOSTA,
        proteger_pela_agenda: true,
      },
    });
    expect(porId.get(`/api/v1/automation-rules/${REGRA_7_DIAS}`)).toMatchObject({
      trigger_config: { dias: 9, stage_id: ETAPA_PROPOSTA, proteger_pela_agenda: false },
    });

    // ⭐ Nenhuma chamada fora das regras que a tela recebeu — a chave paralela
    // (`settings.followup_por_etapa`) não tem por onde voltar.
    const idsConhecidos = new Set(FLUXOS.map((fluxo) => fluxo.id));
    for (const [url, corpo] of mocks.patch.mock.calls) {
      const alvo = String(url);
      expect(alvo.startsWith("/api/v1/automation-rules/")).toBe(true);
      expect(idsConhecidos.has(alvo.replace("/api/v1/automation-rules/", ""))).toBe(true);
      expect(JSON.stringify(corpo)).not.toContain("followup_por_etapa");
    }
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("salvar sem mexer em nada não chama a rota", () => {
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);
    fireEvent.click(screen.getByTestId("salvar-followup"));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Nenhum prazo mudou.");
  });

  it("prazo inválido não chama a rota e diz o que está errado", () => {
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);
    fireEvent.change(screen.getByTestId(`prazo-fluxo-${REGRA_2_DIAS}`), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("salvar-followup"));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId("followup-erro").textContent).toContain("de 1 a 3650");
  });

  it("recusa da rota aparece na tela e NÃO anuncia salvo", async () => {
    const { ApiError } = await import("@/lib/api/types");
    mocks.patch.mockRejectedValueOnce(new ApiError(403, "forbidden_role", undefined, "req-1"));
    render(<FollowupPorEtapaForm fluxos={FLUXOS} funis={CATALOGO} idioma="pt-BR" />);
    fireEvent.change(screen.getByTestId(`prazo-fluxo-${REGRA_2_DIAS}`), { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("salvar-followup"));
    await waitFor(() =>
      expect(screen.getByTestId("followup-erro").textContent).toContain(
        "gerente ou administrador",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("a página LÊ automation_rules — e nunca um mapa paralelo de prazo", () => {
  /**
   * O dublê de banco conta as TABELAS consultadas. É a prova do desenho: se a
   * página voltar a ler `organizations.settings` para montar a tabela, a
   * contagem de tabelas muda e o caso falha antes de qualquer asserção de HTML.
   */
  function bancoFalso(consultadas: string[]) {
    const dados: Record<string, unknown[]> = {
      automation_rules: REGRAS,
      crm_pipelines: [{ id: FUNIL, name: "Comercial" }],
      crm_stages: [
        { id: ETAPA_ABERTA, name: "Novo", pipeline_id: FUNIL, position: 1 },
        { id: ETAPA_PROPOSTA, name: "Proposta", pipeline_id: FUNIL, position: 2 },
      ],
    };
    return {
      from(tabela: string) {
        consultadas.push(tabela);
        const api: Record<string, unknown> = {};
        api.select = () => api;
        api.eq = () => api;
        api.order = () => api;
        api.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({ data: dados[tabela] ?? [], error: null }).then(resolve, reject);
        return api;
      },
    };
  }

  it("⭐ monta a tabela a partir das regras de etapa parada, sem ler settings da organização", async () => {
    const consultadas: string[] = [];
    mocks.requireAuth.mockResolvedValue({ id: "u1", idioma: "pt-BR", support: null });
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "manager" });
    mocks.createClient.mockResolvedValue(bancoFalso(consultadas));

    const elemento = (await FollowupPorEtapaPage()) as unknown as {
      props: { children: Array<{ type: unknown; props: Record<string, unknown> }> };
    };
    const formulario = elemento.props.children.find(
      (filho) => filho && filho.type === FollowupPorEtapaForm,
    )!;

    expect(consultadas).toContain("automation_rules");
    expect(consultadas).not.toContain("organizations");

    const fluxosDaPagina = formulario.props.fluxos as FluxoDeEtapaParada[];
    expect(fluxosDaPagina.map((f) => [f.id, f.dias])).toEqual([
      [REGRA_2_DIAS, 2],
      [REGRA_7_DIAS, 7],
      [REGRA_QUALQUER, 30],
      [REGRA_OUTRO_FUNIL, 3],
    ]);
  });

  it("papel abaixo de manager não vê a página", async () => {
    mocks.requireAuth.mockResolvedValue({ id: "u1", idioma: "pt-BR", support: null });
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "agent" });
    await expect(FollowupPorEtapaPage()).rejects.toThrow("REDIRECT:/403");
  });
});
