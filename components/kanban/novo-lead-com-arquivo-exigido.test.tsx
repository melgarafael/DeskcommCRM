/**
 * NOVO LEAD NUMA ETAPA QUE EXIGE UM CAMPO DE ARQUIVO (#3433).
 *
 * ─── O defeito, medido na main antes do conserto ────────────────────────────
 *
 * Com um campo do tipo "Arquivo" exigido na etapa escolhida, o diálogo "Novo
 * Lead" não tinha o que enviar: o anexo mora em `crm_lead_attachments.lead_id`,
 * e o negócio ainda não existe. A tela fazia o certo ao dizer "Os anexos ficam
 * no negócio." no lugar do uploader — e o errado ao continuar contando esse
 * campo em `faltandoNaEtapa`: o aviso "Preencha os campos obrigatórios antes de
 * continuar: <campo>" aparecia e o "Criar lead" NUNCA chamava a API. Pela API,
 * o `POST /api/v1/leads` recusava com o mesmo 422. Não havia saída.
 *
 * ─── O que estes casos provam ───────────────────────────────────────────────
 *
 * 1. o diálogo CRIA numa etapa que exige só o arquivo, e a tela continua
 *    dizendo que o anexo entra depois (a frase honesta não foi removida);
 * 2. já não aparece o aviso de campo obrigatório sem saída — era ele que
 *    travava o botão;
 * 3. CONTROLE — com um campo de TEXTO exigido e vazio na MESMA etapa, o
 *    diálogo continua não indo à rede e continua dizendo o que falta. O
 *    afrouxamento é do arquivo, não da régua.
 *
 * Sabotagem prevista (escrita ANTES de reverter, ver ANEXO-VIEWER-SABOTAGEM.md):
 * removida a linha que pula `type === "file"` em `lib/leads/campos-exigidos.ts`,
 * caem os casos 1 e 2 (2 de 3) e o controle 3 segue verde.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const criarLead = vi.fn();
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// `components/funil/novo-lead-com-campo-obrigatorio.test.tsx`).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import type { Stage } from "@/lib/kanban/types";

const ETAPA = "11111111-1111-4111-8111-111111111111";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

const ETAPA_QUE_PEDE_DOCUMENTO = {
  id: ETAPA,
  pipeline_id: FUNIL,
  name: "Contrato assinado",
  is_won: false,
  is_lost: false,
  is_archived: false,
} as unknown as Stage;

/** O campo da issue: arquivo exigido para o negócio ENTRAR nesta etapa. */
function campoArquivo() {
  return {
    key: "comprovante",
    label: "Comprovante",
    type: "file",
    obrigatorio_em: { etapas: [ETAPA] },
  };
}

/** O controle: um campo de texto exigido na mesma etapa. */
function campoTexto() {
  return {
    key: "tipo_de_cliente",
    label: "Tipo de cliente",
    type: "text",
    obrigatorio_em: { etapas: [ETAPA] },
  };
}

function abrir(fields: unknown[]) {
  return render(
    <NewLeadDialog
      open
      onOpenChange={() => {}}
      pipelineId={FUNIL}
      stages={[ETAPA_QUE_PEDE_DOCUMENTO]}
      contactId={CONTATO}
      settings={{ fields }}
    />,
  );
}

async function preencherTitulo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Título"), "Contrato do João");
}

beforeEach(() => {
  criarLead.mockReset();
  criarLead.mockResolvedValue({ data: { id: "lead-1" } });
});

afterEach(cleanup);

describe("Novo Lead numa etapa que exige campo de ARQUIVO (#3433)", () => {
  it("cria o negócio, e a tela explica que o anexo entra depois", async () => {
    const user = userEvent.setup();
    abrir([campoArquivo()]);

    // A frase honesta continua na tela: o anexo é do negócio, que ainda não
    // existe. Ela não é o problema — o problema era ela não ter saída.
    expect(await screen.findByText("Os anexos ficam no negócio.")).toBeTruthy();

    await preencherTitulo(user);
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ title: "Contrato do João" });
  });

  it("o aviso de campo obrigatório sem saída não aparece mais — era ele que travava o botão", async () => {
    const user = userEvent.setup();
    abrir([campoArquivo()]);

    await preencherTitulo(user);

    // Nenhum alerta citando o campo de arquivo: não há como preenchê-lo aqui.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("CONTROLE: campo de TEXTO exigido e vazio continua barrando a criação", async () => {
    const user = userEvent.setup();
    abrir([campoArquivo(), campoTexto()]);

    await preencherTitulo(user);
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    expect(criarLead).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Tipo de cliente");
    // O de arquivo não entra na frase: ele não é preenchível aqui.
    expect(screen.getByRole("alert").textContent).not.toContain("Comprovante");
  });
});
