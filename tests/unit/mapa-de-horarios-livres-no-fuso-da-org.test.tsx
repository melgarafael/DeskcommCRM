/**
 * A AgendaInterativa monta o mapa dos horários livres NO FUSO DA ORGANIZAÇÃO
 * (issue #1362 — o item que a revisão de 28/09 apontou).
 *
 * ─── O defeito ────────────────────────────────────────────────────────────
 *
 * `components/agenda/GradeDaAgenda.tsx` já desenhava no fuso da org, mas quem
 * CONSTRÓI o mapa de slots é a `AgendaInterativa`
 * (`components/agenda/AgendaInterativa.tsx:115-122`), e ali as duas chaves
 * saíam do relógio do NAVEGADOR: `format(d, "yyyy-MM-dd")` e `format(d, "HH:mm")`.
 *
 * Com um slot publicado às `13:00Z` numa org em `America/Sao_Paulo`, o bloco
 * caía na linha certa das 10:00 (a grade calcula sozinha, com `fuso`), mas o
 * rótulo do slot dizia `09:00` em `America/New_York` — a MESMA tela
 * anunciando duas horas para o mesmo compromisso. A discordância só trocou
 * de lado.
 *
 * A prova precisa do rótulo, não da posição: `horarioNaCelula` devolve o
 * objeto do mapa com o `rotulo` que ele mesmo carrega, então é ali que o fuso
 * errado chega no `aria-label` do bloco.
 *
 * ─── A prova ──────────────────────────────────────────────────────────────
 *
 * 1. O slot é um instante FIXO (`2026-09-16T13:00:00Z`), para a asserção não
 *    virar loteria.
 * 2. Com org em `America/Sao_Paulo` (UTC-3), a parede é 10:00 — e é o que o
 *    `aria-label` tem que dizer, sob QUALQUER fuso de navegador.
 * 3. A asserção de DESIGUALDADE contra o relógio do ambiente é o que faz o
 *    teste reprovar com o defeito de volta: se o mapa voltasse a ler o
 *    navegador, o rótulo seria o do ambiente e a igualdade com 10:00 morreria
 *    onde os dois fusos diferem.
 *
 * Quando o fuso do ambiente for o mesmo da org, a conversão é a IDENTIDADE e
 * o item 3 é pulado com um `expect` explícito — o teste não pode escolher
 * fuso à toa, senão reprova o código certo.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { ptBR } from "date-fns/locale";

const SLOT = "2026-09-16T13:00:00.000Z";

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({
    data: {
      slots: [{ inicio: SLOT, fim: "2026-09-16T13:30:00.000Z" }],
      fuso_da_regra: "America/Sao_Paulo",
      publicou_horarios: true,
    },
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (chave: string) => chave,
}));

vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  // Objeto `Locale` do date-fns, não string: `format(d, ..., { locale })`
  // lê `.preprocessor` e uma string derruba a montagem inteira da coluna.
  useLocaleDeData: () => ptBR,
}));

vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ remarcar: vi.fn() }),
}));

afterEach(cleanup);

/** Org em São Paulo: 13:00Z = 10:00 de parede. */
const FUSO_DA_ORG = "America/Sao_Paulo";
const PAREDE_ESPERADA = "10:00";

function montar(fuso: string) {
  const pessoas: Pessoa[] = [];
  const agendamentos: Agendamento[] = [];
  return render(
    <AgendaInterativa
      visao="dia"
      ancora={new Date(2026, 8, 16, 12)}
      agora={new Date("2026-09-16T10:00:00Z")}
      fuso={fuso}
      pessoas={pessoas}
      agendamentos={agendamentos}
      recorte={{ de: "2026-09-16T13:00:00.000Z", ate: "2026-09-16T14:00:00.000Z" }}
      tipo={{ id: "t1", duracaoMin: 30 }}
      tipos={[{ id: "t1", nome: "Consulta", duracaoMin: 30 }]}
      onEscolherTipo={vi.fn()}
      onMarcarEm={vi.fn()}
    />,
  );
}

/** O rótulo que o RELÓGIO DO AMBIENTE diria para o mesmo instante. */
function paredeDoAmbiente(): string {
  const hora = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(SLOT));
  return hora;
}

describe("o mapa dos horários livres nasce no fuso da organização", () => {
  it("anuncia a hora de parede da ORG, não a do navegador", () => {
    montar(FUSO_DA_ORG);

    const livres = screen.getAllByTestId(/^bloco-/).filter((n) => within(n).queryAllByRole("button").length > 0);
    const primeiro = document.querySelector("[data-livre='true']");
    expect(primeiro).not.toBeNull();
    const aria = primeiro?.getAttribute("aria-label") ?? "";
    expect(aria).toContain(`Marcar às ${PAREDE_ESPERADA}`);

    // A data também na régua da org: 13:00Z é o dia 16 lá.
    expect(document.querySelector(`[data-testid^="bloco-${"2026-09-16"}-"]`)).not.toBeNull();
    void livres;
  });

  it("reprova se o mapa voltar a ler o relógio do ambiente", () => {
    const doAmbiente = paredeDoAmbiente();
    expect(partesNoFuso(new Date(SLOT), FUSO_DA_ORG).hora).toBe(10);

    if (doAmbiente === PAREDE_ESPERADA) {
      // Ambiente E org no mesmo fuso: a conversão é a identidade e não há o
      // que provar — dizemos isso em vez de deixar um teste que passa à toa.
      expect(doAmbiente).toBe(PAREDE_ESPERADA);
      return;
    }

    montar(FUSO_DA_ORG);
    const primeiro = document.querySelector("[data-livre='true']");
    expect(primeiro).not.toBeNull();
    const aria = primeiro?.getAttribute("aria-label") ?? "";

    // Com o defeito, o rótulo seria o do ambiente — e ele NÃO é este.
    expect(aria).not.toContain(`Marcar às ${doAmbiente}`);
    expect(aria).toContain(`Marcar às ${PAREDE_ESPERADA}`);
  });
});
