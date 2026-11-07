import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * A CHAVE DO TIPO REABRE COMO FOI GRAVADA (#4006, doc 272).
 *
 * O formulário lê `defaultChecked` e o salvar manda o estado da caixa. Se a tela
 * de configuração não ler a coluna, a chave ligada reabre desmarcada e salvar sem
 * mexer DESLIGA, sem ninguém pedir. Este teste reabre a página com um banco de
 * mentira que só devolve as colunas pedidas no `select`, como o PostgREST.
 */

const TIPO_GRAVADO = {
  id: "tipo-1",
  name: "Reunião",
  levar_dados_do_negocio: true,
  buffer_before_minutes: 5,
};

/** Devolve de `linha` só o que o `select` pediu. */
function projetar(colunas: string, linha: Record<string, unknown>) {
  const pedidas = colunas.split(",").map((c) => c.trim());
  return Object.fromEntries(Object.entries(linha).filter(([k]) => pedidas.includes(k)));
}

function consulta(data: unknown) {
  const resposta = { data, error: null };
  const elo = {
    eq: () => elo,
    is: () => elo,
    order: () => elo,
    maybeSingle: () => Promise.resolve(resposta),
    then: (ok: (r: typeof resposta) => unknown) => Promise.resolve(resposta).then(ok),
  };
  return elo;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => ({
      select: (colunas: string) =>
        consulta(tabela === "calendar_event_types" ? [projetar(colunas, TIPO_GRAVADO)] : null),
    }),
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u", is_platform_admin: false, idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org", role: "admin" }),
}));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: async () => [] }));
vi.mock("@/lib/agenda/lembrete-por-modelo", () => ({ modelosQueOLembreteEnvia: async () => [] }));
vi.mock("@/lib/agenda/rotulos-dos-responsaveis", () => ({
  rotulosDosResponsaveisDaAgenda: async () => new Map(),
}));
vi.mock("@/app/app/settings/tenant/agenda/_client", () => ({
  TiposDeAgendamentoClient: function TiposDeAgendamentoClient() {
    return null;
  },
}));

function acharOFormulario(no: ReactNode): ReactElement<{ tiposIniciais: unknown[] }> | null {
  for (const filho of Children.toArray(no)) {
    if (!isValidElement<{ children?: ReactNode; tiposIniciais?: unknown[] }>(filho)) continue;
    if (filho.props.tiposIniciais) return filho as ReactElement<{ tiposIniciais: unknown[] }>;
    const dentro = acharOFormulario(filho.props.children);
    if (dentro) return dentro;
  }
  return null;
}

describe("#4006 · a tela do tipo reabre com o que está no banco", () => {
  it("a chave ligada chega ligada ao formulário", async () => {
    const { default: Pagina } = await import("@/app/app/settings/tenant/agenda/page");

    const formulario = acharOFormulario(await Pagina());

    expect(formulario?.props.tiposIniciais).toEqual([
      expect.objectContaining({ id: "tipo-1", levar_dados_do_negocio: true }),
    ]);
  });
});
