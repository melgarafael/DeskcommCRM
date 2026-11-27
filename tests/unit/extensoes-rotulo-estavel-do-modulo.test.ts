/**
 * `/admin/extensoes` — o rótulo de cada empresa é ESTÁVEL, e o "lido em" sai no fuso da empresa (#5097).
 *
 * ── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * A lista da "Leitura dos avisos pelo módulo" é ordenada por atraso (`lag desc`, `last_read_at nulls
 * first`). O rótulo era o ÍNDICE nessa lista: a empresa que acabou de ler perdia o primeiro lugar e
 * passava de "Empresa 1" para "Empresa 2" — quem acompanha o atraso de um dia para o outro não
 * consegue dizer se é a mesma empresa. E o "lido em" era formatado no fuso do PROCESSO (a VPS roda em
 * UTC), então quem administra de São Paulo via a hora três horas à frente.
 *
 * ── O que estes casos fixam ────────────────────────────────────────────────
 *
 * 1. O rótulo é DERIVADO do id da organização (hash curto), não da posição: a mesma organização tem
 *    o mesmo rótulo com a ordem invertida. É o caso que reprova o código de antes.
 * 2. O rótulo não revela o nome da empresa — requisito da tela (`/admin/extensoes` é da INSTALAÇÃO,
 *    e o dono do servidor não deve ver a lista de clientes).
 * 3. O "lido em" é o mesmo texto com o processo em UTC e em São Paulo, e é a hora da empresa.
 *
 * A tela é renderizada de verdade (`await Page()`), com o cliente do banco dublado: o que se prova é
 * o que sai no DOM, não o formato de um objeto intermediário.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instalacoes: [] as unknown[],
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ is_platform_admin: true, locale: "pt-BR" })),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-interno-do-servidor-0123456789" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: (tabela: string) => {
      const dados = tabela === "extension_installations" ? mocks.instalacoes : [];
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "order", "is", "eq", "in"]) cadeia[m] = () => cadeia;
      cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
      return cadeia;
    },
  }),
}));

import { HOST_API_VERSION } from "@/lib/extensions/manifest";

import Page from "../../app/admin/(protected)/extensoes/page";

const AGORA = Date.parse("2026-11-21T13:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA - h * 3_600_000).toISOString();

/** As duas organizações, com o nome que a tela NÃO pode mostrar (requisito do admin da instalação). */
const ORG_A = { id: "0b1f7c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f", nome: "Clínica Aurora Ltda" };
const ORG_B = { id: "7d2e4f60-2b3c-4d4e-9f5a-6b7c8d9e0f1a", nome: "Padaria do Bairro ME" };

/**
 * O rótulo curto: os 6 primeiros caracteres do md5 do id. A ORGANIZAÇÃO é a mesma para sempre, então
 * o rótulo dela também é — entre sessões, entre dias e entre ordens da lista.
 */
const rotuloDe = (id: string) => createHash("md5").update(id).digest("hex").slice(0, 6);

const INSTALACAO = {
  id: "i1",
  publisher: "acme",
  name: "servico",
  version: "1.0.0",
  installed_at: horasAtras(500),
  disabled_at: null,
  extension_artifacts: {
    manifest: {
      profile: "connected",
      host_api: { min: HOST_API_VERSION, max: HOST_API_VERSION },
      permissions: ["area.contatos.leitura"],
    },
  },
};

/** Uma linha do `fn_extensions_events_lag`, como o banco a devolve (sem nome, com rótulo e fuso). */
function vinculo(
  org: { id: string; nome: string },
  campos: { last_event_id: number; last_read_at: string; lag: number; contacts_pending?: number },
) {
  return {
    rotulo: rotuloDe(org.id),
    fuso: "America/Sao_Paulo",
    contacts_pending: 0,
    oldest_unread_at: campos.lag > 0 ? horasAtras(1) : null,
    ...campos,
  };
}

async function abrir() {
  render(await Page());
}

const TZ_DO_PROCESSO = process.env.TZ;

/** Roda o corpo com o relógio do PROCESSO num fuso — é o que a VPS (UTC) e o Brasil (SP) fazem. */
async function comFusoDoProcesso<T>(fuso: string, corpo: () => Promise<T>): Promise<T> {
  process.env.TZ = fuso;
  try {
    return await corpo();
  } finally {
    if (TZ_DO_PROCESSO === undefined) delete process.env.TZ;
    else process.env.TZ = TZ_DO_PROCESSO;
  }
}

function textoDaLinha(cursor: number): string {
  const linhas = screen.getAllByTestId(/^leitura-eventos-acme-servico-\d+$/);
  const alvo = linhas.find((l) => (l.textContent ?? "").includes(`#${cursor}`));
  if (!alvo) throw new Error(`nenhuma linha com o cursor #${cursor}`);
  return alvo.textContent ?? "";
}

/** O rótulo é a primeira coluna da linha, antes do primeiro separador. */
function rotuloDeQuemLeu(cursor: number): string {
  return textoDaLinha(cursor).split(" · ")[0] ?? "";
}

/** O "lido em" é a data depois do rótulo "lido em", até o próximo separador. */
function lidoEmDeQuemLeu(cursor: number): string {
  const m = /lido em (.+?)(?: · |$)/.exec(textoDaLinha(cursor));
  if (!m) throw new Error(`linha sem "lido em": ${textoDaLinha(cursor)}`);
  return m[1] ?? "";
}

/** A hora de um instante no fuso pedido, na mesma forma que a tela usa. */
function horaNoFuso(iso: string, fuso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: fuso,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  mocks.rpc.mockReset();
  mocks.instalacoes = [INSTALACAO];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("/admin/extensoes: o rótulo da empresa é estável", () => {
  it("com a ordem de atraso invertida, a MESMA organização mantém o MESMO rótulo", async () => {
    const atrasada = vinculo(ORG_A, { last_event_id: 41, last_read_at: horasAtras(30), lag: 7 });
    const emDia = vinculo(ORG_B, { last_event_id: 9, last_read_at: horasAtras(1), lag: 0 });

    mocks.rpc.mockResolvedValue({ data: [atrasada, emDia], error: null });
    await abrir();
    const antes = rotuloDeQuemLeu(41);
    cleanup();

    // A organização da esquerda leu tudo: agora está em dia, e a ordem da lista se inverte.
    const leuAgora = { ...atrasada, lag: 0, last_read_at: horasAtras(0) };
    mocks.rpc.mockResolvedValue({ data: [emDia, leuAgora], error: null });
    await abrir();
    const depois = rotuloDeQuemLeu(41);

    // A asserção do defeito: hoje `antes` = "Empresa 1" e `depois` = "Empresa 2" — a empresa trocou
    // de nome porque trocou de posição.
    expect(depois).toBe(antes);
    expect(antes).toBe(`Empresa ${rotuloDe(ORG_A.id)}`);
    // E a vizinha também: cada organização com o seu, nunca um índice reciclado.
    expect(rotuloDeQuemLeu(9)).toBe(`Empresa ${rotuloDe(ORG_B.id)}`);
    expect(rotuloDeQuemLeu(9)).not.toBe(depois);
  });

  it("o rótulo não revela o nome da empresa nem o id dela", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        vinculo(ORG_A, { last_event_id: 41, last_read_at: horasAtras(2), lag: 3 }),
        vinculo(ORG_B, { last_event_id: 9, last_read_at: horasAtras(1), lag: 0 }),
      ],
      error: null,
    });
    await abrir();

    for (const org of [ORG_A, ORG_B]) {
      const rotulo = rotuloDeQuemLeu(org === ORG_A ? 41 : 9);
      // Forma fechada: "Empresa " + 6 hex. Nome não cabe, e nada além do prefixo aparece.
      expect(rotulo).toMatch(/^Empresa [0-9a-f]{6}$/);
      expect(rotulo).toBe(`Empresa ${rotuloDe(org.id)}`);
      // Asserção explícita do requisito da tela: o nome da empresa não está ali.
      expect(rotulo).not.toContain(org.nome);
      expect(rotulo.toLowerCase()).not.toContain(org.nome.slice(0, 7).toLowerCase());
      expect(rotulo).not.toContain(org.id);
    }
    // A tela inteira também não nomeia ninguém.
    const corpo = document.body.textContent ?? "";
    expect(corpo).not.toContain(ORG_A.nome);
    expect(corpo).not.toContain(ORG_B.nome);
  });
});

describe("/admin/extensoes: o \"lido em\" sai no fuso da empresa", () => {
  const INSTANTE = "2026-11-21T12:34:00.000Z";

  it("o mesmo instante sai igual com o processo em UTC e em São Paulo", async () => {
    mocks.rpc.mockResolvedValue({
      data: [vinculo(ORG_A, { last_event_id: 41, last_read_at: INSTANTE, lag: 0 })],
      error: null,
    });

    const emUtc = await comFusoDoProcesso("UTC", async () => {
      await abrir();
      const texto = lidoEmDeQuemLeu(41);
      cleanup();
      return texto;
    });
    const emSaoPaulo = await comFusoDoProcesso("America/Sao_Paulo", async () => {
      await abrir();
      const texto = lidoEmDeQuemLeu(41);
      cleanup();
      return texto;
    });

    // Controle do instrumento: as duas réguas de fato diferem neste instante (12:34 UTC = 09:34 SP).
    expect(horaNoFuso(INSTANTE, "UTC")).not.toBe(horaNoFuso(INSTANTE, "America/Sao_Paulo"));
    // O defeito: hoje a primeira leitura (processo em UTC) sai 3 h à frente da segunda.
    expect(emUtc).toBe(emSaoPaulo);
    // E o texto é a hora da empresa, no fuso dela.
    expect(emUtc).toBe(horaNoFuso(INSTANTE, "America/Sao_Paulo"));
  });

  it("duas empresas em fusos diferentes mostram cada uma a própria hora do mesmo instante", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        vinculo(ORG_A, { last_event_id: 41, last_read_at: INSTANTE, lag: 0 }),
        { ...vinculo(ORG_B, { last_event_id: 9, last_read_at: INSTANTE, lag: 0 }), fuso: "America/Manaus" },
      ],
      error: null,
    });

    const emUtc = await comFusoDoProcesso("UTC", async () => {
      await abrir();
      const deSaoPaulo = lidoEmDeQuemLeu(41);
      const deManaus = lidoEmDeQuemLeu(9);
      cleanup();
      return { deSaoPaulo, deManaus };
    });

    expect(emUtc.deSaoPaulo).toBe(horaNoFuso(INSTANTE, "America/Sao_Paulo"));
    expect(emUtc.deManaus).toBe(horaNoFuso(INSTANTE, "America/Manaus"));
    expect(emUtc.deSaoPaulo).not.toBe(emUtc.deManaus);
  });
});
