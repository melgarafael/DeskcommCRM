/**
 * A TELA DA OUVIDORIA — E QUEM PODE LER (#3611, fatia 3).
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ────────────────────────
 *
 * Mede as cinco garantias do critério da fatia, uma a uma:
 *
 *   1. a lista só mostra manifestações da ORGANIZAÇÃO da sessão (controle
 *      cruzando tenants);
 *   2. papel sem permissão não vê a tela NEM a action (a régua é a mesma da
 *      leitura da fatia 1, e é reusada — não recriada);
 *   3. mudar status GRAVA AUDITORIA, com `de`, `para` e o motivo da reabertura;
 *   4. a sessão de ACOMPANHAMENTO continua barrada, e a barreira vem antes de
 *      resolver tenant;
 *   5. `concluida` não volta para `recebida` sem motivo.
 *
 * NÃO mede a RLS: aqui o cliente do Supabase é dublado. A segunda cerca
 * (`ouvidoria_manifestacoes_admin_select`, migration 9030) é de
 * `tests/invariants/ouvidoria-registro-privado.test.ts`, que exige banco. Está
 * escrito para ninguém contar duas vezes a mesma garantia.
 *
 * ─── Por que dois dublês, e não um ────────────────────────────────────────
 *
 * O dublê de FUNIL (`tests/helpers/stages-db-double.ts`) aplica os `eq`, o
 * `order`, o `range` e a contagem de verdade — é ele que deixa o caso de TENANT
 * medir o código em vez do dublê: apagar o `.eq("organization_id", …)` faz a
 * linha do vizinho aparecer, e é isso que fica vermelho. Para o caso de CONFLITO
 * ele é usado DUAS vezes, com duas bases diferentes: a leitura vê um status, a
 * escrita encontra outro, e o compare-and-set do UPDATE não casa — que é
 * exatamente o que acontece quando outra pessoa conclui a manifestação entre o
 * clique e a gravação.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  audit: vi.fn(),
}));

/** As duas bases: a do cliente de SESSÃO e a do cliente de SERVIÇO. */
const bancos = vi.hoisted(() => ({
  leitura: undefined as unknown,
  escrita: undefined as unknown,
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  requireAuth: mocks.loadAuthUser,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bancos.escrita }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, isServiceRoleConfigured: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { listarManifestacoesDaOuvidoria } from "@/app/actions/ouvidoria/listar-manifestacoes";
import { mudarStatusDaManifestacao } from "@/app/actions/ouvidoria/mudar-status-manifestacao";
import ManifestacaoPage from "@/app/app/ouvidoria/[id]/page";
import OuvidoriaPage from "@/app/app/ouvidoria/page";
import { createClient } from "@/lib/supabase/server";
import { OUTRA_ORG, ORG_ID, USER_ID, makeDb, type DbOpts } from "@/tests/helpers/stages-db-double";

const MAN_A = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organization_id: ORG_ID,
  protocolo: "OUV-20261028-AAAA1111",
  canal: "whatsapp",
  texto: "Relato sigiloso da empresa A.",
  contact_id: null,
  status: "recebida",
  created_at: "2026-10-28T12:00:00.000Z",
  updated_at: "2026-10-28T12:00:00.000Z",
};

const MAN_B = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  organization_id: OUTRA_ORG,
  protocolo: "OUV-20261028-BBBB2222",
  canal: "telefone",
  texto: "Relato sigiloso da empresa B.",
  contact_id: null,
  status: "recebida",
  created_at: "2026-10-28T13:00:00.000Z",
  updated_at: "2026-10-28T13:00:00.000Z",
};

/**
 * Monta as duas bases e aponta cada cliente para a sua.
 *
 * ⚠️ `makeDb` aponta `createClient` para o ÚLTIMO dublê que criou. Como o
 * cliente de SESSÃO é quem lê, a implementação é restaurada explicitamente
 * depois — sem isso o teste mediria a base errada e o caso de conflito passaria
 * por acidente.
 *
 * ⚠️ As linhas são COPIADAS. O dublê guarda o array recebido e o UPDATE escreve
 * NO PRÓPRIO objeto; com a constante compartilhada, o caso "mudar o status"
 * deixava a manifestação de `MAN_A` com o status novo para os casos seguintes —
 * e o teste do salto passava a medir uma transição válida. Cópia por caso é o
 * que mantém cada teste contando a sua própria história.
 */
function prepararBancos(opcoes: { leitura: DbOpts; escrita?: DbOpts }) {
  const copiar = (o: DbOpts): DbOpts => ({
    ...o,
    manifestacoes: (o.manifestacoes ?? []).map((linha) => ({ ...linha })),
  });

  const bLeitura = makeDb(copiar(opcoes.leitura));
  const bEscrita = opcoes.escrita ? makeDb(copiar(opcoes.escrita)) : bLeitura;
  bancos.leitura = bLeitura.client;
  bancos.escrita = bEscrita.client;
  vi.mocked(createClient).mockImplementation(async () => bancos.leitura as never);
  return { bLeitura, bEscrita };
}

/** Sessão de trabalho. `support` só quando o caso é o de acompanhamento. */
function sessao(
  role: "admin" | "manager" | "agent" | "viewer" = "admin",
  support: Record<string, unknown> | null = null,
) {
  mocks.loadAuthUser.mockResolvedValue({
    id: USER_ID,
    idioma: "pt-BR",
    support,
  });
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_ID, name: "Org", role });
}

function acompanhamento() {
  sessao("admin", {
    id: "77777777-7777-4777-8777-777777777777",
    organization_id: ORG_ID,
    actor_user_id: USER_ID,
    auth_session_id: "88888888-8888-4888-8888-888888888888",
    previous_organization_id: null,
    expires_at: "2030-01-01T00:00:00.000Z",
    name: "Suporte",
    locale: null,
    access_mode: "support_readonly",
    status: "active",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  sessao("admin");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. A barreira — a mesma da fatia 1, e antes de resolver tenant
// ─────────────────────────────────────────────────────────────────────────────

describe("a porta da ouvidoria: quem entra", () => {
  it("sem sessão: unauthenticated, sem tocar no banco", async () => {
    mocks.loadAuthUser.mockResolvedValue(null);
    const { bLeitura } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    await expect(listarManifestacoesDaOuvidoria({})).resolves.toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(mocks.resolveActiveOrg).not.toHaveBeenCalled();
    expect(bLeitura.escritas).toHaveLength(0);
  });

  it("⭐ sessão de acompanhamento não vê a lista — barrada ANTES de resolver tenant", async () => {
    acompanhamento();
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    await expect(listarManifestacoesDaOuvidoria({})).resolves.toEqual({
      ok: false,
      error: "forbidden_role",
    });
    // A barreira é a da fatia 1: descobrir a organização ativa já é informação
    // que a sessão de acompanhamento não precisa para ser recusada.
    expect(mocks.resolveActiveOrg).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("⭐ papel abaixo de admin não vê a lista nem a action", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    for (const role of ["agent", "manager", "viewer"] as const) {
      sessao(role);
      await expect(listarManifestacoesDaOuvidoria({})).resolves.toEqual({
        ok: false,
        error: "forbidden_role",
      });
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it("admin da organização vê a lista da própria empresa", async () => {
    const { bLeitura } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await listarManifestacoesDaOuvidoria({});

    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.pagina.manifestacoes.map((m) => m.protocolo)).toEqual([MAN_A.protocolo]);
    expect(bLeitura.escritas).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A cerca de tenant — o caso que a sabotagem derruba
// ─────────────────────────────────────────────────────────────────────────────

describe("a lista só mostra a organização da sessão", () => {
  it("⭐ admin da empresa A não vê a manifestação da empresa B", async () => {
    // As duas organizações com manifestação na MESMA base: sem o predicado de
    // organização, a linha da B entra na página e este `toEqual` recebe duas.
    const { bLeitura } = prepararBancos({ leitura: { manifestacoes: [MAN_A, MAN_B] } });

    const resultado = await listarManifestacoesDaOuvidoria({});

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.pagina.manifestacoes.map((m) => m.protocolo)).toEqual([MAN_A.protocolo]);
    expect(resultado.pagina.total).toBe(1);
    expect(bLeitura.escritas).toHaveLength(0);
  });

  it("o filtro de status não abre a porta para o outro tenant", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A, MAN_B] } });

    const resultado = await listarManifestacoesDaOuvidoria({ status: "recebida" });

    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.pagina.manifestacoes.map((m) => m.id)).toEqual([MAN_A.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Filtro e paginação — o pedido da URL é tratado como hostil
// ─────────────────────────────────────────────────────────────────────────────

describe("filtro por status e página", () => {
  const linhas = [
    { ...MAN_A, id: "11111111-1111-4111-8111-111111111111", status: "concluida", protocolo: "OUV-20261028-CCCC3333" },
    { ...MAN_A, id: "22222222-2222-4222-8222-222222222222", status: "em_analise", protocolo: "OUV-20261028-DDDD4444" },
    MAN_A,
  ];

  it("status válido filtra; status desconhecido cai em TODAS (não em página vazia)", async () => {
    prepararBancos({ leitura: { manifestacoes: linhas } });

    const concluidas = await listarManifestacoesDaOuvidoria({ status: "concluida" });
    expect(concluidas.ok).toBe(true);
    if (concluidas.ok) expect(concluidas.pagina.manifestacoes.map((m) => m.status)).toEqual(["concluida"]);

    // Um link antigo com `?status=aberta` não pode dizer "não há manifestação".
    const invalido = await listarManifestacoesDaOuvidoria({ status: "aberta" });
    expect(invalido.ok).toBe(true);
    if (invalido.ok) expect(invalido.pagina.total).toBe(3);
  });

  it("página inválida (0, -3, abc) vira página 1; página além do fim é vazia, sem erro", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    for (const pagina of ["0", "-3", "abc", "2x"]) {
      const resultado = await listarManifestacoesDaOuvidoria({ pagina });
      expect(resultado.ok).toBe(true);
      if (resultado.ok) expect(resultado.pagina.pagina).toBe(1);
    }

    const { bLeitura } = prepararBancos({
      leitura: {
        manifestacoes: [MAN_A],
        readError: () => ({ code: "PGRST103", message: "Requested range not satisfiable" }),
      },
    });
    const alemDoFim = await listarManifestacoesDaOuvidoria({ pagina: "9" });
    expect(alemDoFim.ok).toBe(true);
    if (alemDoFim.ok) {
      expect(alemDoFim.pagina.manifestacoes).toEqual([]);
      expect(alemDoFim.pagina.pagina).toBe(9);
    }
    expect(bLeitura.escritas).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Mudança de status — transição, compare-and-set e TRILHA
// ─────────────────────────────────────────────────────────────────────────────

describe("mudança de status", () => {
  it("⭐ recebida → em_analise grava com organização, id e status de origem, e AUDITA", async () => {
    const { bEscrita } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "em_analise" });

    expect(resultado).toEqual({ ok: true, de: "recebida", para: "em_analise" });
    expect(bEscrita.escritas).toHaveLength(1);
    expect(bEscrita.escritas[0]!.tipo).toBe("update");
    expect(bEscrita.escritas[0]!.patch).toEqual({
      status: "em_analise",
      updated_at: expect.any(String),
    });
    // Os TRÊS predicados: sem `organization_id` a escrita alcançaria a
    // manifestação homônima do vizinho; sem `status` não haveria
    // compare-and-set, e a trilha diria que Ana mudou o que já era outro estado.
    expect(bEscrita.escritas[0]!.filtros).toEqual([
      ["organization_id", ORG_ID],
      ["id", MAN_A.id],
      ["status", "recebida"],
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ouvidoria.status_updated",
        actorUserId: USER_ID,
        organizationId: ORG_ID,
        resourceType: "ouvidoria_manifestacao",
        resourceId: MAN_A.id,
        metadata: { de: "recebida", para: "em_analise", motivo: null, reabertura: false },
      }),
    );
  });

  it("⭐ concluida → recebida SEM motivo é recusada: nada é escrito e nada é auditado", async () => {
    const { bEscrita } = prepararBancos({
      leitura: { manifestacoes: [{ ...MAN_A, status: "concluida" }] },
    });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "recebida" });

    expect(resultado).toEqual({ ok: false, error: "motivo_obrigatorio" });
    expect(bEscrita.escritas).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("⭐ concluida → recebida COM motivo grava e leva o motivo para a trilha", async () => {
    const { bEscrita } = prepararBancos({
      leitura: { manifestacoes: [{ ...MAN_A, status: "concluida" }] },
    });
    const motivo = "A pessoa respondeu que o problema voltou.";

    const resultado = await mudarStatusDaManifestacao({
      id: MAN_A.id,
      status: "recebida",
      motivo,
    });

    expect(resultado).toEqual({ ok: true, de: "concluida", para: "recebida" });
    expect(bEscrita.escritas).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ouvidoria.status_updated",
        metadata: { de: "concluida", para: "recebida", motivo, reabertura: true },
      }),
    );
  });

  it("motivo curto demais não é motivo", async () => {
    const { bEscrita } = prepararBancos({
      leitura: { manifestacoes: [{ ...MAN_A, status: "concluida" }] },
    });

    const resultado = await mudarStatusDaManifestacao({
      id: MAN_A.id,
      status: "recebida",
      motivo: "ok",
    });

    expect(resultado).toEqual({ ok: false, error: "motivo_obrigatorio" });
    expect(bEscrita.escritas).toHaveLength(0);
  });

  it("pular a análise (recebida → concluida) é recusado", async () => {
    const { bEscrita } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "concluida" });

    expect(resultado).toEqual({ ok: false, error: "salto_de_etapa" });
    expect(bEscrita.escritas).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("status igual ao atual não é transição", async () => {
    const { bEscrita } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "recebida" });

    expect(resultado).toEqual({ ok: false, error: "mesmo_status" });
    expect(bEscrita.escritas).toHaveLength(0);
  });

  it("⭐ compare-and-set: se o status mudou entre a leitura e a escrita, é conflito (nada gravado de novo)", async () => {
    // A leitura enxerga `em_analise`; a escrita encontra a linha já `concluida`
    // — outra pessoa concluiu no meio. O UPDATE com `.eq("status", "em_analise")`
    // casa zero linhas e o `single()` responde PGRST116.
    prepararBancos({
      leitura: { manifestacoes: [{ ...MAN_A, status: "em_analise" }] },
      escrita: { manifestacoes: [{ ...MAN_A, status: "concluida" }] },
    });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "concluida" });

    expect(resultado).toEqual({ ok: false, error: "conflito" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("⭐ manifestação de outra organização: not_found, sem escrita e sem auditoria", async () => {
    const { bEscrita } = prepararBancos({ leitura: { manifestacoes: [MAN_B] } });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_B.id, status: "em_analise" });

    expect(resultado).toEqual({ ok: false, error: "not_found" });
    expect(bEscrita.escritas).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("⭐ sessão de acompanhamento não muda status", async () => {
    acompanhamento();
    const { bEscrita } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await mudarStatusDaManifestacao({ id: MAN_A.id, status: "em_analise" });

    expect(resultado).toEqual({ ok: false, error: "forbidden_role" });
    expect(bEscrita.escritas).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("papel abaixo de admin não muda status", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    for (const role of ["agent", "manager", "viewer"] as const) {
      sessao(role);
      await expect(
        mudarStatusDaManifestacao({ id: MAN_A.id, status: "em_analise" }),
      ).resolves.toEqual({ ok: false, error: "forbidden_role" });
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("pedido com campo a mais é recusado antes de qualquer leitura", async () => {
    const { bLeitura } = prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    const resultado = await mudarStatusDaManifestacao({
      id: MAN_A.id,
      status: "em_analise",
      organization_id: OUTRA_ORG,
    } as never);

    expect(resultado).toEqual({ ok: false, error: "validation_failed" });
    expect(bLeitura.escritas).toHaveLength(0);
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A TELA — quem vê o quê
// ─────────────────────────────────────────────────────────────────────────────

describe("a tela da ouvidoria", () => {
  it("⭐ viewer e agent não veem a tela: redireciona em vez de mostrar lista vazia", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    for (const role of ["agent", "manager", "viewer"] as const) {
      sessao(role);
      await expect(OuvidoriaPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
        "redirect:/app",
      );
    }
    // Lista vazia diria "a empresa não tem manifestação" — outra frase.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("⭐ a sessão de acompanhamento também não vê a tela do detalhe", async () => {
    acompanhamento();
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    await expect(
      ManifestacaoPage({ params: Promise.resolve({ id: MAN_A.id }) }),
    ).rejects.toThrow("redirect:/app");
  });

  it("admin vê protocolo, canal e status — e o RELATO não está na lista", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    render(await OuvidoriaPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(MAN_A.protocolo)).toBeInTheDocument();
    expect(screen.getByText("Recebida")).toBeInTheDocument();
    // O relato é do DETALHE: a lista carrega 25 linhas e nenhum texto.
    expect(screen.queryByText(MAN_A.texto)).toBeNull();
  });

  it("a lista obedece o filtro da URL", async () => {
    prepararBancos({
      leitura: {
        manifestacoes: [
          MAN_A,
          { ...MAN_B, organization_id: ORG_ID, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", protocolo: "OUV-20261028-EEEE5555", status: "concluida" },
        ],
      },
    });

    render(
      await OuvidoriaPage({ searchParams: Promise.resolve({ status: "concluida" }) }),
    );

    expect(screen.getByText("OUV-20261028-EEEE5555")).toBeInTheDocument();
    expect(screen.queryByText(MAN_A.protocolo)).toBeNull();
  });

  it("o detalhe mostra o relato a quem é autorizado", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_A] } });

    render(await ManifestacaoPage({ params: Promise.resolve({ id: MAN_A.id }) }));

    expect(screen.getByText(MAN_A.texto)).toBeInTheDocument();
    expect(screen.getByText(MAN_A.protocolo)).toBeInTheDocument();
    // O formulário de status é oferecido com a etapa seguinte — nunca com o
    // salto, que a action recusaria.
    expect(screen.getByRole("heading", { name: "Mudar status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Em análise" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Concluída" })).toBeNull();
  });

  it("detalhe de outra organização: 'não encontrada' e o relato não aparece", async () => {
    prepararBancos({ leitura: { manifestacoes: [MAN_B] } });

    render(await ManifestacaoPage({ params: Promise.resolve({ id: MAN_B.id }) }));

    expect(screen.getByText("Manifestação não encontrada.")).toBeInTheDocument();
    expect(screen.queryByText(MAN_B.texto)).toBeNull();
  });
});
