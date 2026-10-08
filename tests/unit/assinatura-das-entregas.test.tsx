/**
 * A TELA DIZ SE O WHATSAPP JÁ ASSINA — doc 99 do mantenedor, opção A.
 *
 * O padrão de "Exigir assinatura nas entregas do canal" continua desligado; o
 * que muda é que `/admin/sistema` passa a mostrar se as últimas entregas
 * chegaram assinadas e a sugerir ligar quando a resposta é sim.
 *
 * As duas direções que importam:
 *   - SIM só quando nada chegou sem assinatura desde a primeira assinada — se o
 *     número que não assina entregou algo depois disso, sugerir ligar o cortaria
 *     (um número que não assina e ficou quieto NÃO aparece: limite da regra);
 *   - a sugestão só aparece com o interruptor DESLIGADO e a resposta SIM.
 *
 * Sabotagem que confirma a guarda: trocar `primeiraAssinadaEm` por
 * `ultimaAssinadaEm` na comparação de `responderAssinatura` deixa o caso dos
 * dois números vermelho; tirar `!valores.exigir_assinatura_no_webhook` da
 * condição da sugestão deixa o caso do interruptor ligado vermelho.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/settings/updateComportamento", () => ({ updateComportamento: vi.fn() }));
vi.mock("@/app/actions/settings/updateModuloDaInstalacao", () => ({ updateModuloDaInstalacao: vi.fn() }));

import { FormularioDeComportamento, type AssinaturaNaTela } from "@/app/admin/(protected)/sistema/_form";
import {
  JANELA_DAS_ENTREGAS_EM_DIAS,
  lerAssinaturaDasEntregas,
  responderAssinatura,
} from "@/lib/channels/assinatura-das-entregas";
import type { ComportamentoDaInstalacao } from "@/lib/instalacao/comportamento";

const T1 = "2026-10-05T10:00:00.000Z";
const T2 = "2026-10-05T11:00:00.000Z";
const T3 = "2026-10-05T12:00:00.000Z";

describe("a regra do sim", () => {
  it("só assinadas na janela: sim", () => {
    expect(
      responderAssinatura({ primeiraAssinadaEm: T1, ultimaAssinadaEm: T3, ultimaSemAssinaturaEm: null }).assinadas,
    ).toBe(true);
  });

  it("só sem assinatura: não", () => {
    expect(
      responderAssinatura({ primeiraAssinadaEm: null, ultimaAssinadaEm: null, ultimaSemAssinaturaEm: T3 }).assinadas,
    ).toBe(false);
  });

  it("nenhuma entrega: não opina", () => {
    expect(
      responderAssinatura({ primeiraAssinadaEm: null, ultimaAssinadaEm: null, ultimaSemAssinaturaEm: null }).assinadas,
    ).toBeNull();
  });

  it("as sem assinatura são todas de ANTES da primeira assinada (quem atualizou): sim", () => {
    expect(
      responderAssinatura({ primeiraAssinadaEm: T2, ultimaAssinadaEm: T3, ultimaSemAssinaturaEm: T1 }).assinadas,
    ).toBe(true);
  });

  it("chegou sem assinatura DEPOIS da primeira assinada, mesmo antes da última (dois números): não", () => {
    expect(
      responderAssinatura({ primeiraAssinadaEm: T1, ultimaAssinadaEm: T3, ultimaSemAssinaturaEm: T2 }).assinadas,
    ).toBe(false);
  });
});

/** Um cliente que grava os filtros de cada consulta e devolve o que o teste mandar. */
function clienteFalso(respostas: Array<{ data: unknown; error: unknown }>) {
  const consultas: Array<Array<[string, ...unknown[]]>> = [];
  const admin = {
    from(tabela: string) {
      const chamadas: Array<[string, ...unknown[]]> = [["from", tabela]];
      consultas.push(chamadas);
      const resposta = respostas[consultas.length - 1];
      const q: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "gte", "is", "order", "limit"]) {
        q[m] = (...a: unknown[]) => {
          chamadas.push([m, ...a]);
          return q;
        };
      }
      q.maybeSingle = async () => resposta;
      return q;
    },
  };
  return { admin: admin as never, consultas };
}

describe("a leitura das entregas", () => {
  const agora = new Date("2026-10-06T12:00:00.000Z");

  it("lê só o transporte do interruptor, na janela, pelo índice parcial — e responde", async () => {
    const { admin, consultas } = clienteFalso([
      { data: { received_at: T2 }, error: null },
      { data: { received_at: T3 }, error: null },
      { data: { received_at: T1 }, error: null },
    ]);
    const r = await lerAssinaturaDasEntregas(admin, agora);
    expect(r).toEqual({ assinadas: true, ultimaAssinadaEm: T3, ultimaSemAssinaturaEm: T1 });

    const desde = new Date(agora.getTime() - JANELA_DAS_ENTREGAS_EM_DIAS * 86_400_000).toISOString();
    expect(consultas).toHaveLength(3);
    for (const c of consultas) {
      expect(c).toContainEqual(["from", "webhook_events_log"]);
      expect(c).toContainEqual(["eq", "provider", "waha"]);
      expect(c).toContainEqual(["gte", "received_at", desde]);
      expect(c).toContainEqual(["is", "archived_at", null]);
    }
    expect(consultas[0]).toContainEqual(["eq", "valid_signature", true]);
    expect(consultas[0]).toContainEqual(["order", "received_at", { ascending: true }]);
    expect(consultas[1]).toContainEqual(["eq", "valid_signature", true]);
    expect(consultas[1]).toContainEqual(["order", "received_at", { ascending: false }]);
    expect(consultas[2]).toContainEqual(["eq", "valid_signature", false]);
    expect(consultas[2]).toContainEqual(["order", "received_at", { ascending: false }]);
  });

  it("leitura recusada não vira 'sem entregas': devolve null, e a tela cala", async () => {
    const { admin } = clienteFalso([
      { data: null, error: { message: "permission denied" } },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    expect(await lerAssinaturaDasEntregas(admin, agora)).toBeNull();
  });
});

const DESLIGADO: ComportamentoDaInstalacao = {
  orcamento_de_ia: "on",
  exigir_assinatura_no_webhook: false,
  divulgacao_de_pagamento: "inject",
  promessa_semantica: false,
};
const SIM: AssinaturaNaTela = { assinadas: true, ultimaAssinada: "06/10/2026, 09:00", ultimaSemAssinatura: null };

describe("a tela, ao lado do interruptor", () => {
  afterEach(cleanup);

  it("sim + interruptor desligado: diz quando foi a última e sugere ligar", () => {
    render(<FormularioDeComportamento inicial={DESLIGADO} assinatura={SIM} />);
    const bloco = screen.getByTestId("assinatura-das-entregas").textContent;
    expect(bloco).toContain("chegaram assinadas: sim (última em 06/10/2026, 09:00)");
    expect(bloco).toContain("Pode ligar: o WhatsApp já assina.");
  });

  it("sim + interruptor já ligado: não sugere", () => {
    render(
      <FormularioDeComportamento inicial={{ ...DESLIGADO, exigir_assinatura_no_webhook: true }} assinatura={SIM} />,
    );
    expect(screen.getByTestId("assinatura-das-entregas").textContent).not.toContain("Pode ligar");
  });

  it("não: diz não, mostra as duas datas e não sugere", () => {
    render(
      <FormularioDeComportamento
        inicial={DESLIGADO}
        assinatura={{ assinadas: false, ultimaAssinada: "05/10/2026, 08:00", ultimaSemAssinatura: "06/10/2026, 10:00" }}
      />,
    );
    const bloco = screen.getByTestId("assinatura-das-entregas").textContent;
    expect(bloco).toContain("chegaram assinadas: não.");
    expect(bloco).toContain("Última assinada: 05/10/2026, 08:00.");
    expect(bloco).toContain("Última sem assinatura: 06/10/2026, 10:00.");
    expect(bloco).not.toContain("Pode ligar");
  });

  it("leitura falhou: a tela não diz nada", () => {
    render(<FormularioDeComportamento inicial={DESLIGADO} assinatura={null} />);
    expect(screen.queryByTestId("assinatura-das-entregas")).toBeNull();
  });
});
