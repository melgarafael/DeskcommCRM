import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * O PEDIDO QUE CHEGA DE UMA PLATAFORMA SEM CONECTOR PRÓPRIO ENTRA POR UMA ORIGEM GENÉRICA.
 *
 * Issue #2442: a loja da instalação vende pelo site em **Tray**, que não tem
 * integração nativa no CRM. Os pedidos entram em `orders` por uma ponte própria
 * (fora do produto) com o contato ligado pelo telefone — e batiam em
 * `orders_external_provider_check`, que só aceitava `nuvemshop`, `vtex` e
 * `shopify`. Gravar exigia alterar a restrição NA INSTALAÇÃO, e o risco apontado
 * pela issue é o da atualização no meio do caminho: uma migration futura que
 * recriasse a restrição com uma lista sem `tray` falharia nas linhas já gravadas.
 *
 * A escolha da issue é a opção 2 (a que o autor prefere): **uma origem genérica**
 * — `external` — para pedidos que chegam por integração própria, com o NOME da
 * plataforma no `payload`. Assim a mesma entrada serve Tray, Loja Integrada,
 * WooCommerce e o que vier, sem a lista crescer a cada caso.
 *
 * O que este arquivo cobre, e por que cada perna:
 *
 * 1. **a gravação genérica passa** — é o defeito: sem o alargamento, o INSERT
 *    recebe `23514` e a ponte perde o pedido em silêncio;
 * 2. **os três conectores nativos seguem aceitos** — o alargamento não pode
 *    mexer no que já funcionava (a ponte da Nuvemshop faz UPSERT nessa lista);
 * 3. **a cerca continua de pé** — valor fora do vocabulário ainda é barrado e a
 *    recusa nomeia a constraint. Sem esta perna, um apagão da restrição também
 *    deixaria o caso 1 verde, e o teste não provaria alargamento, só ausência de
 *    guarda;
 * 4. **a lista vigente tem os quatro valores** — a régua de escopo declarada,
 *    lida do próprio banco (`pg_get_constraintdef`), não de memória;
 * 5. **o clone da própria issue atualiza** — a instalação que alargou a lista à
 *    mão e gravou pedidos 'tray' re-aplica o bloco do `baseline.sql` (o que o
 *    update.sh faz) e termina COM a guarda e com a linha convertida. Sem o
 *    backfill, o bloco falharia e o update repetiria o erro a cada vez,
 *    mantendo a restrição que havia, sem nunca aceitar 'external';
 * 6. **falhar não deixa a tabela sem guarda** — drop, conversão e add formam um
 *    bloco DO só. Numa colisão forjada da conversão, o bloco inteiro é desfeito
 *    e a restrição de antes continua lá, sem linha convertida pela metade.
 *
 * A plataforma fica no `payload` e NÃO no `external_provider`: o único que
 * precisava de nome era quem lê o pedido (o agente, pela ferramenta
 * `crm_list_contact_orders`, e o PDF da LGPD, que imprime o valor da coluna).
 *
 * ─── SABOTAGEM (prova no CI) ────────────────────────────────────────────────
 * Sem o apêndice da migration no `baseline.sql` (é ele que o kit self-host
 * aplica, install E update): cai "a origem genérica grava" e "a lista vigente é
 * a de quatro" — 2 vermelhos de 4, os dois previstos; as pernas 2 e 3 continuam
 * verdes porque a restrição antiga não mexe no que já passava.
 * Com os três comandos soltos no lugar do bloco DO (o head 9b5507382): cai só a
 * perna 6, com "expected '' to contain 'tray'" — a falha deixou a tabela sem
 * restrição nenhuma.
 * Linha para reverter: bloco `orders_external_provider_check` no fim de
 * `supabase/baseline.sql` (e `supabase/migrations/<timestamp>_..._2442.sql`).
 */

/** `sql` usa `ON_ERROR_STOP=1`: o `23514` derruba a sessão, e o texto volta aqui. */
function recusaDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const erro = e as { stderr?: string; message?: string };
    return `${erro.stderr ?? ""}${erro.message ?? ""}`;
  }
}

/** Grava um pedido de prova e devolve o id. */
function gravaPedido(args: {
  id: string;
  externalId: string;
  provedor: string;
  payload?: string;
}): void {
  sql(`
    insert into public.orders
      (id, organization_id, external_id, external_provider, status, total_cents, ordered_at, payload)
    values
      ('${args.id}', '${GOV_ORG}', '${args.externalId}', '${args.provedor}',
       'paid', 129900, '2026-10-01T12:00:00Z', '${args.payload ?? "{}"}');
  `);
}

describe("pedido de plataforma sem integração nativa: origem genérica", () => {
  it("a origem genérica grava — a ponte da Tray não perde o pedido", () => {
    seedGov();
    const id = "eeeeeeee-0000-4000-8000-000000002442";

    gravaPedido({
      id,
      externalId: "tray:10231",
      provedor: "external",
      payload: '{"platform":"tray","pedido":"10231"}',
    });

    expect(sql(`select count(*) from public.orders where id = '${id}';`)).toBe("1");
    expect(
      sql(`select payload ->> 'platform' from public.orders where id = '${id}';`),
    ).toBe("tray");
  });

  it("os três conectores nativos continuam aceitos", () => {
    seedGov();
    const nativos = ["nuvemshop", "vtex", "shopify"];
    for (const [i, provedor] of nativos.entries()) {
      gravaPedido({
        id: `eeeeeeee-0000-4000-8000-0000000025${i.toString().padStart(2, "0")}`,
        externalId: `${provedor}:10231`,
        provedor,
      });
    }
    expect(
      sql(
        `select count(*) from public.orders
          where external_provider in ('nuvemshop', 'vtex', 'shopify')
            and external_id like '%:10231';`,
      ),
    ).toBe("3");
  });

  it("valor fora do vocabulário continua barrado — a cerca não caiu", () => {
    seedGov();
    const recusa = recusaDe(`
      insert into public.orders
        (id, organization_id, external_id, external_provider, status, total_cents, ordered_at)
      values
        ('eeeeeeee-0000-4000-8000-000000002601', '${GOV_ORG}', 'loja:1', 'loja_inexistente',
         'paid', 100, '2026-10-01T12:00:00Z');
    `);

    expect(recusa, "a restrição não barrou valor fora do vocabulário").toContain(
      "orders_external_provider_check",
    );
  });

  it("a lista vigente é os três conectores mais a origem genérica", () => {
    seedGov();
    const definicao = sql(
      `select pg_get_constraintdef(oid)
         from pg_constraint
        where conname = 'orders_external_provider_check';`,
    );

    for (const valor of ["nuvemshop", "vtex", "shopify", "external"]) {
      expect(definicao, `lista sem ${valor}: ${definicao}`).toContain(`'${valor}'`);
    }
  });

  it("o clone da issue (restrição alargada à mão, pedido 'tray') re-aplica o bloco e fica com a guarda", () => {
    seedGov();
    const id = "eeeeeeee-0000-4000-8000-000000002670";
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const marcador = "-- ---- pedidos de plataforma sem conector próprio entram por origem genérica";
    const inicio = baseline.indexOf(marcador);
    expect(inicio, `marcador não encontrado no baseline.sql: ${marcador}`).toBeGreaterThan(-1);
    const fim = baseline.indexOf("\n-- ---- ", inicio + marcador.length);
    const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);

    sql(`
      alter table public.orders drop constraint orders_external_provider_check;
      alter table public.orders add constraint orders_external_provider_check
        check (external_provider in ('nuvemshop', 'vtex', 'shopify', 'tray')) not valid;
    `); // not valid: as pernas anteriores deste arquivo já gravaram 'external'
    try {
      // id diferente do da perna 1, que já gravou (external, tray:10231) neste banco
      gravaPedido({ id, externalId: "20462", provedor: "tray" });
      sql(bloco);

      expect(
        sql(
          `select external_provider || '|' || external_id || '|' || (payload ->> 'platform')
             from public.orders where id = '${id}';`,
        ),
      ).toBe("external|tray:20462|tray");
      expect(
        sql(
          `select pg_get_constraintdef(oid) from pg_constraint
            where conname = 'orders_external_provider_check';`,
        ),
        "o update deixou a tabela sem a restrição",
      ).toContain("'external'");
    } finally {
      sql(`delete from public.orders where id = '${id}';`);
      sql(bloco);
    }
  });

  it("se a conversão colide, o bloco inteiro desfaz — a instalação fica com a restrição que tinha", () => {
    seedGov();
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const marcador = "-- ---- pedidos de plataforma sem conector próprio entram por origem genérica";
    const inicio = baseline.indexOf(marcador);
    const fim = baseline.indexOf("\n-- ---- ", inicio + marcador.length);
    const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);
    const ja = "eeeeeeee-0000-4000-8000-000000002671";
    const tray = "eeeeeeee-0000-4000-8000-000000002672";

    sql(`
      alter table public.orders drop constraint orders_external_provider_check;
      alter table public.orders add constraint orders_external_provider_check
        check (external_provider in ('nuvemshop', 'vtex', 'shopify', 'tray', 'external')) not valid;
    `);
    try {
      // caso forjado: a linha 'external' com o id prefixado já existe, então a
      // conversão da linha 'tray' recebe 23505
      gravaPedido({ id: ja, externalId: "tray:30001", provedor: "external" });
      gravaPedido({ id: tray, externalId: "30001", provedor: "tray" });

      const erro = recusaDe(bloco);
      expect(erro, "o bloco devia falhar na colisão").toMatch(/duplicate key|23505/);

      expect(
        sql(
          `select pg_get_constraintdef(oid) from pg_constraint
            where conname = 'orders_external_provider_check';`,
        ),
        "a falha deixou a tabela sem a restrição (o drop ficou feito)",
      ).toContain("'tray'");
      expect(
        sql(`select external_provider || '|' || external_id from public.orders where id = '${tray}';`),
        "a falha deixou a conversão pela metade",
      ).toBe("tray|30001");
    } finally {
      sql(`delete from public.orders where id in ('${ja}', '${tray}');`);
      sql(bloco);
    }
  });
});
