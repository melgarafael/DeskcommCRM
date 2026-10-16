/**
 * O "HOJE" DE 4 TELAS É O DIA DE QUEM USA A TELA — NÃO O DIA UTC (#2935).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * As quatro telas nasciam com `new Date().toISOString().slice(0, 10)`, que é o
 * dia UTC. A oeste de Greenwich isso ADIANTA o dia: às 23:30 em Brasília
 * (UTC−3) o relógio UTC já virou, então "hoje" saía AMANHÃ para quem está na
 * tela. Os quatro pontos medidos na issue:
 *
 *   1. faturamento/_lancamentos.tsx: o lançamento novo nascia com a data de
 *      amanhã depois das 21h em Brasília;
 *   2. faturamento/_client.tsx: o período padrão ia "até amanhã" e, no último
 *      dia do mês, o "dia 1º" saltava para o mês seguinte;
 *   3. lib/kanban/filters.ts: "Apenas atrasados" marcava como atrasado o
 *      negócio que fecha HOJE;
 *   4. proposals/novo/_client.tsx: a validade padrão "hoje + 15" saía com 16
 *      dias.
 *
 * ─── A régua ─────────────────────────────────────────────────────────────────
 *
 * A função certa já existia: `diaDeHojeLocal` (lib/ai/pacing-knobs.ts:54) monta
 * `aaaa-mm-dd` pelo fuso do navegador e já era usada no AntiBanSheet. O conserto
 * é usá-la nos quatro pontos — e este arquivo prova os quatro sem depender do
 * relógio real: fuso e instante são FIXOS (`America/Sao_Paulo`, 23:30 locais do
 * último dia do mês), e o relógio é congelado.
 *
 * O instante escolhido é o último dia de setembro de 2026: além de exercitar o
 * "virou o dia", ele é o caso em que o mês também vira no UTC — o "dia 1º" do
 * período pularia de mês.
 *
 * ─── Os casos de controle (senão o arquivo passaria com o defeito de volta)
 *
 * • DISCRIMINADOR: no instante testado, `diaDeHojeLocal()` e o dia UTC são
 *   DIFERENTES. Sem esta asserção, um runner em UTC não distinguiria o conserto
 *   do defeito — os dois dias coincidem.
 * • UTC: com o navegador em UTC, nada muda — o dia local É o dia UTC, e as
 *   quatro telas têm de devolver o que devolviam antes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { hoje as hojeDoLancamento } from "@/app/app/faturamento/_lancamentos";
import {
  hoje as hojeDoPeriodo,
  primeiroDoMes,
} from "@/app/app/faturamento/_client";
import { validadePadrao } from "@/app/app/proposals/novo/_client";
import { diaDeHojeLocal } from "@/lib/ai/pacing-knobs";
import { applyFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/** UTC−3: o fuso de quem opera este produto, e o `PACING_DEFAULTS.timezone`. */
const FUSO_DO_OPERADOR = "America/Sao_Paulo";
/** 2026-09-30T23:30 em America/Sao_Paulo (UTC−3) = 2026-10-01T02:30Z. */
const INSTANTE_23H30_BRT = "2026-10-01T02:30:00.000Z";
const DIA_DE_QUEM_USA = "2026-09-30";
/** O dia UTC no mesmo instante — o valor que o defeito devolvia. */
const DIA_UTC = "2026-10-01";

const TZ_ORIGINAL = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

/** Congela o relógio neste instante, com o navegador neste fuso. */
function relogio(fuso: string, instante: string): void {
  process.env.TZ = fuso;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(instante));
}

/** Um negócio do funil com o mínimo que `applyFilters` lê. */
const lead = (id: string, campos: Partial<Lead> = {}): Lead =>
  ({
    id,
    title: id,
    status: "open",
    owner_user_id: "u1",
    owner_agent_id: null,
    tags: [],
    conversation_tags: [],
    contact_tags: [],
    ...campos,
  }) as Lead;

describe("às 23:30 em Brasília, o 'hoje' das 4 telas é o dia de quem usa a tela", () => {
  it("DISCRIMINADOR: o dia local e o dia UTC divergem neste instante", () => {
    relogio(FUSO_DO_OPERADOR, INSTANTE_23H30_BRT);
    // Se estes dois fossem iguais, o arquivo inteiro passaria com o defeito de
    // volta — é esta a asserção que dá o direito de exigir o dia local.
    expect(diaDeHojeLocal()).toBe(DIA_DE_QUEM_USA);
    expect(new Date().toISOString().slice(0, 10)).toBe(DIA_UTC);
    expect(DIA_DE_QUEM_USA).not.toBe(DIA_UTC);
  });

  it("ponto 1 — o lançamento novo nasce com o dia de HOJE, não de amanhã", () => {
    relogio(FUSO_DO_OPERADOR, INSTANTE_23H30_BRT);
    // O `data` do lançamento novo vem de `hoje()` (faturamento/_lancamentos.tsx).
    expect(hojeDoLancamento()).toBe(DIA_DE_QUEM_USA);
    // E `new Date().toISOString()...` — o defeito — devolveria amanhã.
    expect(hojeDoLancamento()).not.toBe(DIA_UTC);
  });

  it("ponto 2 — o período termina HOJE e o 'dia 1º' é do mês de hoje", () => {
    relogio(FUSO_DO_OPERADOR, INSTANTE_23H30_BRT);
    // O último dia do mês: com o dia UTC, `primeiroDoMes` pulava de mês.
    expect(hojeDoPeriodo()).toBe(DIA_DE_QUEM_USA);
    expect(primeiroDoMes()).toBe("2026-09-01");
    // O defeito devolveria o mês seguinte no "dia 1º".
    expect(primeiroDoMes()).not.toBe(`${DIA_UTC.slice(0, 7)}-01`);
  });

  it("ponto 3 — 'Apenas atrasados' NÃO marca quem fecha HOJE", () => {
    relogio(FUSO_DO_OPERADOR, INSTANTE_23H30_BRT);
    const fechaHoje = lead("fecha-hoje", { expected_close_date: DIA_DE_QUEM_USA });
    const fechouOntem = lead("fechou-ontem", { expected_close_date: "2026-09-29" });
    const fechaAmanha = lead("fecha-amanha", { expected_close_date: DIA_UTC });

    const atrasados = applyFilters([fechaHoje, fechouOntem, fechaAmanha], {
      overdueOnly: true,
    });
    // Só o que fechou ANTES de hoje é atrasado; o que fecha hoje ainda está no
    // prazo. Com o dia UTC, `fecha-hoje` entrava nesta lista.
    expect(atrasados.map((l) => l.id)).toEqual(["fechou-ontem"]);
  });

  it("ponto 4 — a validade padrão é hoje + 15 exatos, não 16 dias", () => {
    relogio(FUSO_DO_OPERADOR, INSTANTE_23H30_BRT);
    // 2026-09-30 + 15 dias = 2026-10-15. O defeito (soma local + formato UTC)
    // devolvia 2026-10-16.
    expect(validadePadrao()).toBe("2026-10-15");
    expect(validadePadrao()).not.toBe("2026-10-16");
  });
});

describe("com o navegador em UTC, nada muda — o dia local É o dia UTC", () => {
  it("as 4 telas devolvem o que devolviam antes (dia UTC = dia local)", () => {
    relogio("UTC", INSTANTE_23H30_BRT);
    expect(diaDeHojeLocal()).toBe(DIA_UTC);
    expect(hojeDoLancamento()).toBe(DIA_UTC);
    expect(hojeDoPeriodo()).toBe(DIA_UTC);
    expect(primeiroDoMes()).toBe("2026-10-01");
    expect(validadePadrao()).toBe("2026-10-16");
  });

  it("o funil em UTC trata hoje como hoje (nenhum atraso inventado)", () => {
    relogio("UTC", INSTANTE_23H30_BRT);
    const fechaHoje = lead("fecha-hoje", { expected_close_date: DIA_UTC });
    const fechouOntem = lead("fechou-ontem", { expected_close_date: "2026-09-30" });
    expect(
      applyFilters([fechaHoje, fechouOntem], { overdueOnly: true }).map((l) => l.id),
    ).toEqual(["fechou-ontem"]);
  });
});
