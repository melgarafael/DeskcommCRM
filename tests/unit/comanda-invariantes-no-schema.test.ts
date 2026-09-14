/**
 * Os invariantes do módulo financeiro estão no SCHEMA, não na prosa.
 *
 * Este arquivo lê o `baseline.sql` — o arquivo que o self-hoster realmente
 * aplica — e cobra que cada invariante tenha garantia mecânica. Invariante que
 * só existe em comentário é invariante que o primeiro PR apressado desfaz sem
 * nada reprovar.
 *
 * Não substitui `pnpm test:db`, que aplica o SQL de verdade. É o que dá para
 * provar sem Postgres, e o que impede a REGRESSÃO silenciosa destas decisões.
 *
 * ═══ ⚠️ POR QUE TUDO RODA SEM COMENTÁRIOS ═══
 *
 * Medido nesta sessão: a asserção do `for update` passava **com o lock removido
 * do SQL**, porque casava com a linha `-- FOR UPDATE: duas finalizações
 * simultâneas...` que EXPLICA o lock.
 *
 * O comentário que descreve um invariante é, por construção, o texto mais
 * parecido com o invariante — então é ele que faz a asserção passar quando o
 * código some. Um teste satisfeito pela prosa que o explica não vigia nada.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const baseline = readFileSync(join(__dirname, "..", "..", "supabase", "baseline.sql"), "utf8");

/** Tira os comentários de linha: só o SQL executável entra nas asserções. */
function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** O bloco do módulo, para não casar com trecho de outra parte do arquivo. */
const bloco = (() => {
  const i = baseline.indexOf("-- ---- comanda, financeiro");
  expect(i, "o bloco do módulo financeiro sumiu do baseline").toBeGreaterThan(-1);
  return semComentarios(baseline.slice(i));
})();

/** O corpo de uma função, do `create` até o `revoke` dela. */
function corpoDaFuncao(nome: string): string {
  const f = bloco.slice(bloco.indexOf(`create or replace function public.${nome}`));
  const fim = f.indexOf(`revoke execute on function public.${nome}`);
  expect(fim, `não achei o revoke de ${nome}`).toBeGreaterThan(0);
  return f.slice(0, fim);
}

describe("invariante 1 — nada é apagado", () => {
  it("a comanda cancela por STATUS, não por delete", () => {
    expect(bloco).toMatch(/status text not null default 'open'[\s\S]{0,120}'cancelled'/);
  });

  it("o item só cai junto se a ORGANIZAÇÃO sair", () => {
    // `on delete cascade` no `sale_id` é seguro porque a comanda nunca é
    // apagada. Se alguém introduzir um DELETE de comanda, este par vira perda
    // silenciosa de histórico.
    expect(bloco).toMatch(/sale_id uuid not null references public\.sales\(id\) on delete cascade/);
  });
});

describe("invariante 2 — saldo é sempre derivado", () => {
  it("nenhuma tabela do módulo tem coluna de saldo", () => {
    const suspeitas = [
      ...bloco.matchAll(/^\s*(\w*balance\w*|\w*saldo\w*|points_total|total_points)\s/gim),
    ];
    expect(
      suspeitas.map((m) => m[1]),
      "saldo gravado diverge dos lançamentos no primeiro estorno, sem dar sinal",
    ).toEqual([]);
  });

  it("a fidelidade é ledger: pontos assinados, sem coluna de tipo", () => {
    expect(bloco).toMatch(/create table if not exists public\.loyalty_ledger/);
    expect(bloco).toMatch(/points integer not null/);
    expect(bloco.slice(bloco.indexOf("loyalty_ledger"))).not.toMatch(
      /^\s*type text not null[\s\S]{0,60}(ganho|resgate)/im,
    );
  });
});

describe("invariante 3 — estorno é contra-lançamento", () => {
  it("o lançamento aponta para o que estorna", () => {
    expect(bloco).toMatch(/reverses_entry_id uuid references public\.financial_entries\(id\)/);
  });

  it("a função de estorno INSERE, e nunca apaga o original", () => {
    const corpo = corpoDaFuncao("fn_estornar_comanda");
    expect(corpo).toMatch(/insert into public\.financial_entries/);
    expect(corpo, "estorno que apaga não conta história nenhuma").not.toMatch(
      /delete\s+from\s+public\.financial_entries/i,
    );
  });

  it("lançamento pago é imutável por TRIGGER, não por convenção", () => {
    expect(bloco).toMatch(/create or replace function public\.fn_lancamento_pago_e_imutavel/);
    expect(bloco).toMatch(/create trigger trg_financial_entries_imutavel/);
    for (const campo of ["amount_cents", "account_id", "direction", "entry_date"]) {
      expect(bloco, `${campo} precisa estar protegido depois de pago`).toMatch(
        new RegExp(`new\\.${campo}\\s+is distinct from old\\.${campo}`),
      );
    }
  });
});

describe("invariante 4 — a comissão é congelada na inclusão", () => {
  const corpo = corpoDaFuncao("fn_finalizar_comanda");

  it("o percentual mora no ITEM", () => {
    expect(bloco).toMatch(/commission_percent numeric\(5, 2\) not null/);
    expect(corpo).toMatch(/v_item\.commission_percent/);
  });

  it("a finalização NÃO consulta a regra — mudar hoje não mexe no que foi combinado ontem", () => {
    expect(corpo).not.toMatch(/from\s+public\.commission_rules/i);
  });

  it("incide sobre o ITEM, nunca sobre o desconto da comanda", () => {
    // Um desconto de caixa não pode reduzir o que quem atendeu combinou.
    expect(corpo).toMatch(/v_item\.total_cents \* v_item\.commission_percent/);
  });
});

describe("invariante 5 — a numeração não reinicia", () => {
  it("é por organização e monotônica", () => {
    expect(bloco).toMatch(/create unique index if not exists sales_org_numero_key/);
    expect(bloco).toMatch(/coalesce\(max\(number\), 0\) \+ 1/);
  });
});

describe("a finalização", () => {
  const corpo = corpoDaFuncao("fn_finalizar_comanda");

  it("trava a linha — sem isso, duas chamadas geram lançamento em dobro", () => {
    // Ancorado na consulta que o lock protege, e no SQL sem comentários: foi
    // exatamente aqui que a asserção genérica passou com o lock removido.
    expect(corpo).toMatch(/from public\.sales[\s\S]{0,120}for update\s*;/i);
  });

  it("é idempotente: comanda já finalizada devolve o mesmo desfecho, sem erro", () => {
    expect(corpo).toMatch(/ja_finalizada/);
  });

  it("recusa forma de pagamento SEM conta em vez de escolher uma", () => {
    expect(corpo).toMatch(/forma_sem_conta/);
  });

  it("não desfaz um agendamento cancelado ou faltou ao faturar", () => {
    expect(corpo).toMatch(/status not in \('cancelled', 'no_show'\)/);
  });

  it("finalizar EXIGE forma de pagamento — no CHECK, não só na função", () => {
    expect(bloco).toMatch(/constraint sales_finalizada_tem_forma/);
  });
});
