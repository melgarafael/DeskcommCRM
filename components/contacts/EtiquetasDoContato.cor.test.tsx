/**
 * AS ETIQUETAS DA FICHA COM A COR DA ORGANIZAÇÃO (issue #3235).
 *
 * ─── O defeito que este arquivo tranca ──────────────────────────────────────
 *
 * A ficha do contato era o único editor de `contacts.tags` fora da cor que a
 * #2718 levou ao Inbox: a lista de sugestões saía inteira em cinza tracejado
 * (quem opera não distingue `vip` azul de `fornecedor` vermelho sem abrir
 * Configurações → Tags), a etiqueta nova nascia sem tom e a que já estava no
 * contato não tinha por onde ser repintada.
 *
 * O que cada caso prova:
 *   1. a sugestão sai PINTADA com o tom do vocabulário — e continua tracejada;
 *   2. etiqueta sem cor continua saindo exatamente como antes (nada inventado);
 *   3. clicar numa sugestão abre a paleta com o tom ATUAL marcado, e escolher
 *      outro grava `definir_cor` na MESMA grafia da etiqueta;
 *   4. confirmar sem trocar o tom NÃO regrava cor (nada de escrita à toa);
 *   5. a etiqueta NOVA criada pela ficha passa pela paleta antes de entrar;
 *   6. "Sem cor" escolhido de propósito não grava cor nenhuma;
 *   7. sem permissão de vocabulário o campo é o de antes: sugere, cria direto e
 *      não mostra gatilho de cor;
 *   8. a ficha entrega a paleta ao campo quando quem edita pode mexer no
 *      vocabulário — e o POST sai com o corpo que a rota espera;
 *   9. e não entrega para quem é `agent` (a rota exigiria manager + MFA);
 *  10. o diálogo de NOVO contato deixou o campo "separadas por vírgula" e usa o
 *      MESMO seletor: a etiqueta escolhida entra no payload da criação e a cor
 *      vai para o vocabulário.
 *
 * ─── Por que o mapa de cores entra pelo PROVEDOR, e não por um dublê ────────
 *
 * A pintura depende de `GET /api/v1/tags/cores` ser lido, mapeado e chegar ao
 * chip — é o caminho inteiro que a ficha passou a usar. Dublar o contexto
 * provaria só que o dublê está ligado, então aqui o `apiClient` é mockado no
 * fio (a resposta é a FORMA da rota) e o `ProvedorDeCoresDasEtiquetas` é o de
 * verdade.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { EtiquetasDoContato } from "@/components/contacts/EtiquetasDoContato";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import type { Contact } from "@/lib/types/contacts";

/** O que o diálogo de novo contato entrega à criação (o payload da rota). */
const mutateCriar = vi.hoisted(() => vi.fn(async () => ({ data: { contact: null } })));

/** O papel de quem edita — lido pelos dois hooks de auth que a ficha usa. */
const estado = vi.hoisted(() => ({ papel: "manager" as string }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: estado.papel } }),
  useActiveOrg: () => ({
    orgId: "org-1",
    role: estado.papel,
    name: "Organização de teste",
    currency: "BRL",
    country: null,
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/useCreateContact", () => ({
  useCreateContact: () => ({ mutateAsync: mutateCriar, isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    // O cliente devolve o CORPO já parseado, e cada rota tem a sua forma: o
    // vocabulário de sugestões sai lista crua, a de cores sai `{tag, cor}`.
    get: vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/v1/tags/cores")) {
        return {
          data: [
            { tag: "vip", cor: "#0091ff" },
            { tag: "fornecedor", cor: "#cf3716" },
          ],
        };
      }
      return { data: ["vip", "fornecedor"] };
    }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

const AZUL = "#0091ff";
const ROXO = "#ab4aba";

/** A cor de FUNDO aplicada, comparada no MESMO formato que o navegador usa. */
function mesmaCor(el: HTMLElement | null, hex: string): boolean {
  if (!el) return false;
  const prova = document.createElement("span");
  prova.style.backgroundColor = hex;
  return (
    window.getComputedStyle(el).backgroundColor === window.getComputedStyle(prova).backgroundColor
  );
}

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProvedorDeCoresDasEtiquetas>{ui}</ProvedorDeCoresDasEtiquetas>
    </QueryClientProvider>,
  );
}

/** O campo da ficha, com espiões para o que ele entrega a quem o monta. */
function renderarCampo(props: Partial<Parameters<typeof EtiquetasDoContato>[0]> = {}) {
  const onChange = vi.fn();
  const onDefinirCor = vi.fn();
  envolver(
    <EtiquetasDoContato
      value={[]}
      onChange={onChange}
      onDefinirCor={onDefinirCor}
      {...props}
    />,
  );
  return { onChange, onDefinirCor };
}

const campo = () => screen.getByLabelText("Adicionar etiqueta");
/** A confirmação da paleta — o rodapé do `DialogoDeNovaEtiqueta`. */
const confirmarPaleta = () => screen.getByRole("button", { name: "Adicionar tag" });

const CONTATO = {
  id: "ct-3235",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: ["VIP"],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

beforeEach(() => {
  estado.papel = "manager";
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EtiquetasDoContato — a cor na ficha (issue #3235)", () => {
  it("a sugestão sai pintada com o tom do vocabulário, e continua tracejada", async () => {
    renderarCampo({ vocabulario: ["vip", "fornecedor"] });

    const vip = await screen.findByTestId("sugestao-vip");
    await waitFor(() => expect(mesmaCor(vip, AZUL)).toBe(true));
    expect(mesmaCor(screen.getByTestId("sugestao-fornecedor"), "#cf3716")).toBe(true);
    // O tracejado é o que distingue "ainda não está no contato" do chip sólido.
    expect(vip.className).toContain("border-dashed");
    expect(vip).toHaveTextContent("vip");
  });

  it("etiqueta sem cor continua como era: nenhuma pintura inventada", async () => {
    renderarCampo({ vocabulario: ["vip", "sem-cor"] });

    // A espera é do MAPA chegar (provada na sugestão que tem cor); só então a
    // ausência de pintura na outra diz alguma coisa.
    const vip = await screen.findByTestId("sugestao-vip");
    await waitFor(() => expect(mesmaCor(vip, AZUL)).toBe(true));
    expect(screen.getByTestId("sugestao-sem-cor").getAttribute("style")).toBeNull();
  });

  it("clicar na sugestão abre a paleta com o tom ATUAL marcado, e trocar grava definir_cor na mesma grafia", async () => {
    const user = userEvent.setup();
    const { onChange, onDefinirCor } = renderarCampo({ vocabulario: ["VIP"] });

    const sugestao = await screen.findByTestId("sugestao-vip");
    await waitFor(() => expect(mesmaCor(sugestao, AZUL)).toBe(true));
    await user.click(sugestao);

    // A paleta abre com o tom que a etiqueta JÁ tem: confirmar sem mexer nele
    // não pode apagar a cor que estava lá (#2771).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Azul" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Roxo" }));
    await user.click(confirmarPaleta());

    expect(onChange).toHaveBeenCalledWith(["VIP"]);
    expect(onDefinirCor).toHaveBeenCalledWith("VIP", ROXO);
  });

  it("confirmar a paleta sem trocar o tom não regrava cor", async () => {
    const user = userEvent.setup();
    const { onChange, onDefinirCor } = renderarCampo({ vocabulario: ["VIP"] });

    const sugestao = await screen.findByTestId("sugestao-vip");
    await waitFor(() => expect(mesmaCor(sugestao, AZUL)).toBe(true));
    await user.click(sugestao);
    await user.click(await screen.findByRole("button", { name: "Azul" }));
    await user.click(confirmarPaleta());

    expect(onChange).toHaveBeenCalledWith(["VIP"]);
    expect(onDefinirCor).not.toHaveBeenCalled();
  });

  it("a etiqueta NOVA criada pela ficha passa pela paleta antes de entrar na lista", async () => {
    const user = userEvent.setup();
    const { onChange, onDefinirCor } = renderarCampo({ vocabulario: ["vip"] });

    await user.type(campo(), "cliente diamante");
    await user.click(screen.getByTestId("criar-etiqueta"));
    await user.click(await screen.findByRole("button", { name: "Roxo" }));
    await user.click(confirmarPaleta());

    expect(onChange).toHaveBeenCalledWith(["cliente diamante"]);
    expect(onDefinirCor).toHaveBeenCalledWith("cliente diamante", ROXO);
  });

  it("“Sem cor” escolhido de propósito não grava cor nenhuma", async () => {
    const user = userEvent.setup();
    const { onChange, onDefinirCor } = renderarCampo({ vocabulario: ["vip"] });

    await user.type(campo(), "cliente diamante");
    await user.click(screen.getByTestId("criar-etiqueta"));
    await user.click(await screen.findByRole("button", { name: "Sem cor" }));
    await user.click(confirmarPaleta());

    expect(onChange).toHaveBeenCalledWith(["cliente diamante"]);
    expect(onDefinirCor).not.toHaveBeenCalled();
  });

  it("sem permissão de vocabulário o campo é o de antes: sem gatilho e criando direto", async () => {
    const user = userEvent.setup();
    const { onChange, onDefinirCor } = renderarCampo({
      value: ["vip"],
      vocabulario: ["vip"],
      onDefinirCor: undefined,
    });

    expect(screen.queryByRole("button", { name: "Cor da etiqueta vip" })).toBeNull();

    await user.type(campo(), "cliente diamante{Enter}");
    // O Enter grava direto, sem paleta — o comportamento de sempre.
    expect(onChange).toHaveBeenCalledWith(["vip", "cliente diamante"]);
    expect(onDefinirCor).not.toHaveBeenCalled();
  });
});

describe("EditContactDialog — a ficha entrega a paleta a quem pode mexer no vocabulário", () => {
  it("manager: o gatilho de cor existe e o POST sai com o corpo que a rota espera", async () => {
    const user = userEvent.setup();
    envolver(
      <EditContactDialog
        contact={CONTATO}
        open
        onOpenChange={vi.fn()}
        vocabulario={["VIP"]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Cor da etiqueta VIP" }));
    await user.click(await screen.findByRole("button", { name: "Roxo" }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
        acao: "definir_cor",
        tag: "VIP",
        destino: null,
        cor: ROXO,
      }),
    );
  });

  it("agent: sem gatilho de cor, e a sugestão entra direto no contato", async () => {
    estado.papel = "agent";
    const user = userEvent.setup();
    envolver(
      <EditContactDialog
        contact={{ ...CONTATO, tags: [] }}
        open
        onOpenChange={vi.fn()}
        vocabulario={["VIP"]}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Cor da etiqueta/ })).toBeNull();

    await user.click(await screen.findByTestId("sugestao-vip"));
    // Sem paleta: o chip entra na ficha, que é o comportamento de antes.
    expect(await screen.findByRole("button", { name: "Remover etiqueta VIP" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar tag" })).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe("NewContactDialog — o contato novo também nasce com etiqueta colorida", () => {
  it("a sugestão sai pintada e a etiqueta escolhida entra no payload da criação", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "joana@exemplo.com");
    const sugestao = await screen.findByTestId("sugestao-vip");
    await waitFor(() => expect(mesmaCor(sugestao, AZUL)).toBe(true));

    await user.click(sugestao);
    await user.click(await screen.findByRole("button", { name: "Roxo" }));
    await user.click(confirmarPaleta());
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() =>
      expect(mutateCriar).toHaveBeenCalledWith(expect.objectContaining({ tags: ["vip"] })),
    );
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
      acao: "definir_cor",
      tag: "vip",
      destino: null,
      cor: ROXO,
    });
  });

  it("agent: a etiqueta digitada e não confirmada com Enter entra na criação", async () => {
    estado.papel = "agent";
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Email"), "joana@exemplo.com");
    await user.type(campo(), "recompra");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() =>
      expect(mutateCriar).toHaveBeenCalledWith(expect.objectContaining({ tags: ["recompra"] })),
    );
  });

  it("fechar sem criar descarta a etiqueta digitada: ela não vaza para o próximo contato", async () => {
    estado.papel = "agent";
    const user = userEvent.setup();
    const { rerender } = envolver(<NewContactDialog open onOpenChange={vi.fn()} />);
    // O MESMO tipo de árvore na mesma posição: o diálogo segue montado e só o
    // `open` muda, como na tela de contatos.
    const qc = new QueryClient();
    const remontar = (open: boolean) =>
      rerender(
        <QueryClientProvider client={qc}>
          <ProvedorDeCoresDasEtiquetas>
            <NewContactDialog open={open} onOpenChange={vi.fn()} />
          </ProvedorDeCoresDasEtiquetas>
        </QueryClientProvider>,
      );

    await user.type(campo(), "recompra");
    remontar(false);
    remontar(true);
    await user.type(screen.getByLabelText("Email"), "joana@exemplo.com");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => expect(mutateCriar).toHaveBeenCalled());
    expect(mutateCriar).toHaveBeenCalledWith(expect.not.objectContaining({ tags: expect.anything() }));
  });
});
