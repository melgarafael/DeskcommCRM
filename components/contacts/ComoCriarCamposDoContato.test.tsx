/**
 * ONDE SE CRIA CAMPO DO CONTATO (#4744) — a ficha diz, em vez de calar.
 *
 * Quem acabou de instalar abria "Novo contato" ou "Editar contato" procurando
 * onde acrescentar um campo e não achava nada: a caixa "Campos personalizados"
 * só existia quando já havia campo, e o lugar de criar (o funil padrão, em
 * Etapas do funil) não aparece na barra lateral. Aqui se mede, nas duas janelas:
 *
 *   • administrador, funil padrão lido e nenhum campo do contato → a dica
 *     aparece, com o nome do funil e o link para Etapas do funil em outra aba;
 *   • a dica NÃO aparece quando a resposta seria falsa ou inútil: o funil ainda
 *     não foi lido (ou nem é lido, como na edição pela lista de contatos), o
 *     papel não consegue criar campo, ou já existe campo (a caixa de sempre);
 *   • em espanhol, a frase inteira sai em espanhol, com os rótulos da outra tela.
 */
import { createElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Contact } from "@/lib/types/contacts";

const { org, funilPadrao } = vi.hoisted(() => ({
  org: { role: "admin" as string },
  /** O que `useDefaultPipeline` devolve: `undefined` = a leitura ainda corre. */
  funilPadrao: { data: undefined as unknown },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "22222222-2222-4222-8222-222222222222", country: null, role: org.role }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/useCreateContact", () => ({
  useCreateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn(async () => true) }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: funilPadrao.data }),
}));

const NOME_DO_FUNIL = "Atendimento - Clínica Sorriso (novo)";

const CAMPO_DO_CONTATO: CustomFieldDef = {
  key: "convenio",
  label: "Convênio",
  type: "text",
  escopo: "contato",
} as CustomFieldDef;

/** A frase inteira como o administrador lê, com o nome do funil no meio. */
const DICA_PT =
  "Você pode criar campos do contato na tela Etapas do funil: no funil Atendimento - Clínica Sorriso (novo), " +
  "clique em “Editar vocabulário e campos deste funil” e em “Adicionar campo”. " +
  "Em “Este campo pertence a:”, troque para “Contato” e salve. Abrir Etapas do funil em outra aba";
const DICA_ES =
  "Puedes crear campos del contacto en la pantalla Etapas del embudo: en el embudo Atendimento - Clínica Sorriso (novo), " +
  "haz clic en “Editar vocabulario y campos de este embudo” y en “Agregar campo”. " +
  "En “Este campo pertenece a:”, cambia a “Contacto” y guarda. Abrir Etapas del embudo en otra pestaña";

const contato = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "22222222-2222-4222-8222-222222222222",
  name: "Ana",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
} as unknown as Contact;

function noIdioma(locale: "pt-BR" | "es", tela: ReactElement) {
  return render(createElement(IdiomaProvider, { locale, children: tela }));
}

function edicao(
  props: Partial<Parameters<typeof EditContactDialog>[0]> = {},
  locale: "pt-BR" | "es" = "pt-BR",
) {
  return noIdioma(
    locale,
    <EditContactDialog
      contact={contato}
      open
      onOpenChange={vi.fn()}
      customFieldDefs={[]}
      funilDosCampos={{ name: NOME_DO_FUNIL }}
      {...props}
    />,
  );
}

function cadastro(locale: "pt-BR" | "es" = "pt-BR") {
  return noIdioma(locale, <NewContactDialog open onOpenChange={vi.fn()} />);
}

function funilLido(fields: CustomFieldDef[] = []) {
  funilPadrao.data = {
    pipeline: { id: "p1", name: NOME_DO_FUNIL, settings: { fields } },
    stages: [],
  };
}

const dica = () => screen.queryByTestId("como-criar-campos-do-contato");

beforeEach(() => {
  org.role = "admin";
  funilPadrao.data = undefined;
});

describe("Editar contato (a ficha)", () => {
  it("administrador, funil lido e nenhum campo: diz onde criar, com link em outra aba", () => {
    edicao();
    expect(dica()).toHaveTextContent(DICA_PT, { normalizeWhitespace: true });
    const link = screen.getByTestId("link-criar-campos-do-contato");
    expect(link).toHaveAttribute("href", "/app/settings/tenant/pipelines");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("em espanhol, a frase inteira sai em espanhol", () => {
    edicao({}, "es");
    expect(dica()).toHaveTextContent(DICA_ES, { normalizeWhitespace: true });
  });

  it("sem o funil lido (a lista de contatos, ou a leitura em curso) não afirma que falta campo", () => {
    edicao({ funilDosCampos: undefined });
    expect(dica()).toBeNull();
  });

  it("gerente não vê a dica: criar campo é só do administrador", () => {
    org.role = "manager";
    edicao();
    expect(dica()).toBeNull();
  });

  it("com campo do contato, a caixa de sempre e nenhuma dica", () => {
    edicao({ customFieldDefs: [CAMPO_DO_CONTATO] });
    expect(dica()).toBeNull();
    expect(screen.getByText("Campos definidos no funil padrão da organização.")).toBeInTheDocument();
  });
});

describe("Novo contato", () => {
  it("administrador, funil lido e nenhum campo do contato: diz onde criar", () => {
    funilLido();
    cadastro();
    expect(dica()).toHaveTextContent(DICA_PT, { normalizeWhitespace: true });
  });

  it("enquanto o funil não chega, nada pisca", () => {
    cadastro();
    expect(dica()).toBeNull();
  });

  it("atendente não vê a dica", () => {
    org.role = "agent";
    funilLido();
    cadastro();
    expect(dica()).toBeNull();
  });

  it("com campo do contato, mostra o campo e nenhuma dica", () => {
    funilLido([CAMPO_DO_CONTATO]);
    cadastro();
    expect(dica()).toBeNull();
    expect(screen.getByText("Campos personalizados")).toBeInTheDocument();
  });

  it("campo só do negócio não conta: a ficha do contato continua sem campo e a dica aparece", () => {
    funilLido([{ key: "valor", label: "Valor", type: "text" } as CustomFieldDef]);
    cadastro();
    expect(dica()).toHaveTextContent(DICA_PT, { normalizeWhitespace: true });
  });
});
