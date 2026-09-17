import { describe, expectTypeOf, it } from "vitest";

import type { Database } from "@/lib/database.types";

/**
 * O TIPO DA VIEW DE OCUPAÇÃO NÃO OFERECE O `title` QUE O BANCO NÃO TEM.
 *
 * A migration 0261 recriou `calendar_selected_external_events` com lista
 * explícita de colunas e sem `title`: o título do compromisso pessoal do Google
 * saiu do alcance de todo login de usuário. O Row da view em
 * `lib/database.types.ts`, porém, era o da TABELA menos `starts_at`/`ends_at` —
 * então `.from("calendar_selected_external_events").select("title")` passava no
 * typecheck e quebrava em produção com 42703 (`column
 * calendar_selected_external_events.title does not exist`, medido no PostgREST
 * com o JWT de um membro).
 *
 * O contrato mudou no banco; este arquivo o prende no tipo. É verificado pelo
 * `pnpm typecheck` (tsconfig.typecheck.json inclui `tests/**`): o `expectTypeOf`
 * não faz nada em tempo de execução, e é por isso que a asserção é de TIPO.
 * O lado do banco — a view sem a coluna — é vigiado por
 * `tests/invariants/titulo-do-evento-pessoal-fora-do-alcance.test.ts`.
 */
type LinhaDaView = Database["public"]["Views"]["calendar_selected_external_events"]["Row"];
type LinhaDaTabela = Database["public"]["Tables"]["calendar_external_events"]["Row"];

describe("o tipo da view de ocupação do Google", () => {
  it("não tem `title` — pedi-lo tem de falhar no typecheck, não em produção", () => {
    expectTypeOf<LinhaDaView>().not.toHaveProperty("title");
  });

  it("segue com a ocupação que a tela lê (controle: o tipo não virou vazio)", () => {
    expectTypeOf<LinhaDaView>().toHaveProperty("starts_at").toEqualTypeOf<string>();
    expectTypeOf<LinhaDaView>().toHaveProperty("ends_at").toEqualTypeOf<string>();
    expectTypeOf<LinhaDaView>().toHaveProperty("status");
    expectTypeOf<LinhaDaView>().toHaveProperty("transparency");
    expectTypeOf<LinhaDaView>().toHaveProperty("connection_id");
  });

  it("a tabela do espelho continua com a coluna `title` — service_role mantém SELECT/UPDATE nela, e o sincronizador a grava nula", () => {
    expectTypeOf<LinhaDaTabela>().toHaveProperty("title");
  });
});
