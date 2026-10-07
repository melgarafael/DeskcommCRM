import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  RAZAO_NAO_SELECIONADA,
  prospectingInputSchema,
  razaoDeAbordarSelecionado,
} from "@/lib/prospecting/schema";

/**
 * PROSPECÇÃO — o operador escolhe quais empresas entram na fila (#1896).
 *
 * ## O defeito
 *
 * `activateCampaign` (`lib/prospecting/store.ts`) levava para a fila TODO
 * candidato com `status='new'`. A busca devolve o que o Google Maps traz, e boa
 * parte não serve: quota de 50 tentativas/24h gasta com quem não é público, e
 * mensagem fria para quem não devia recebê-la (risco de denúncia).
 *
 * ## O conserto
 *
 * Uma coluna `selected boolean not null default true` em `prospecting_candidates`
 * (migration 0506). O padrão é TUDO marcado — quem não mexer continua com a
 * mesma fila de antes. A ativação só aborda os marcados; os desmarcados vão para
 * `skipped` com o motivo exato (mesmo estado dos dois motivos que já existiam:
 * "Sem telefone brasileiro válido.", "Contato já existe no CRM…").
 *
 * ## Como este arquivo prova o pedido (e o que NÃO prova)
 *
 * `activateCampaign` é uma função de banco pesada (cria contato, lead, boundary
 * de serviço via `createContactHandler`/`createLeadHandler`/`beginServiceAtOrigin`,
 * valida agente/canal/funil); a suíte não tem um harness de `pg.Pool` para ela.
 * A decisão que o conserto acrescenta é PURA e mora em
 * `razaoDeAbordarSelecionado` (funcional aqui), e a sua colagem na ativação é
 * pinada por leitura do `store.ts` — o mesmo padrão de
 * `tests/unit/falha-de-um-candidato-nao-para-a-campanha.test.ts`, que também
 * lê o worker de verdade. A sabotagem (remover o gate da ativação) derruba os
 * casos que leem `store.ts`.
 */

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("action `select` no schema", () => {
  it("aceita a nova ação com lista de candidatos e booleano", () => {
    expect(
      prospectingInputSchema.safeParse({
        action: "select",
        id: UUID(1),
        candidate_ids: [UUID(2), UUID(3)],
        selected: false,
      }).success,
    ).toBe(true);
  });

  it("rejeita `select` sem lista, com lista vazia ou com campo a mais", () => {
    expect(
      prospectingInputSchema.safeParse({
        action: "select",
        id: UUID(1),
        candidate_ids: [],
        selected: false,
      }).success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({
        action: "select",
        id: UUID(1),
        selected: false,
      }).success,
    ).toBe(false);
    expect(
      prospectingInputSchema.safeParse({
        action: "select",
        id: UUID(1),
        candidate_ids: [UUID(2)],
        selected: false,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("decisão da ativação (função pura)", () => {
  it("o não-marcado NUNCA entra na fila — vai para Não abordado com o motivo exato", () => {
    expect(razaoDeAbordarSelecionado(false)).toBe(RAZAO_NAO_SELECIONADA);
    expect(RAZAO_NAO_SELECIONADA).toBe("Não selecionada pelo operador.");
  });

  it("o marcado segue o caminho normal (a função não inventa motivo)", () => {
    expect(razaoDeAbordarSelecionado(true)).toBeNull();
  });
});

describe("a ativação cola a decisão na fila (leitura do store.ts)", () => {
  const fonte = fs.readFileSync(
    path.resolve(__dirname, "../../lib/prospecting/store.ts"),
    "utf8",
  );

  it("decide pela seleção de CADA candidato, no `status='new'`", () => {
    expect(fonte).toMatch(/razaoDeAbordarSelecionado\(p\.selected\)/);
  });

  it("o não-marcado vira `skipped` sem entrar na fila, usando o motivo decidido", () => {
    const i = fonte.indexOf("razaoDeAbordarSelecionado(p.selected)");
    const bloco = fonte.slice(i, i + 400);
    expect(bloco).toMatch(/update prospecting_candidates set status='skipped'/);
    expect(bloco).toMatch(/error=\$3/);
    expect(bloco).toMatch(/selectionReason/);
    expect(bloco).toMatch(/continue;/);
  });

  it("o `Candidate` carrega `selected` do banco para a decisão", () => {
    expect(fonte).toMatch(/selected: boolean/);
  });

  it("os motivos pré-existentes de `skipped` continuam lá (a seleção não suprime o resto)", () => {
    expect(fonte).toMatch(/Sem telefone brasileiro válido\./);
    expect(fonte).toMatch(/Contato já existe no CRM; atendimento preservado\./);
  });
});

describe("a rota expõe e persiste a seleção (leitura da route)", () => {
  const rota = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/v1/prospecting/route.ts"),
    "utf8",
  );

  it("o GET devolve `p.selected` de cada candidato", () => {
    expect(rota).toMatch(/p\.selected/);
  });

  it("a ação `select` só altera candidato de campanha em `draft`", () => {
    expect(rota).toMatch(/status='draft'/);
  });

  it("a ação `select` só altera candidato ainda `new` (não reescreve em andamento)", () => {
    expect(rota).toMatch(/status='new'/);
  });
});