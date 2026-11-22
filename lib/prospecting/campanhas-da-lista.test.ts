/**
 * GUARDA DA LEITURA DO CARTÃO (#4947).
 *
 * O cartão da Prospecção diz "N empresas" sobre o que está NA LISTA, então a contagem
 * sai das linhas de `prospecting_candidates`. O defeito que este teste impede de
 * voltar: alguém reintroduzir a leitura de `prospecting_campaigns.result_count` — o
 * número guardado que nenhuma operação de SAÍDA de linha atualiza (o "Usar lista em
 * outra campanha", a limpeza das desmarcadas, o expurgo por retenção), e que deixava
 * o cartão da campanha de origem dizendo 3 depois de 2 das 3 empresas irem embora.
 *
 * A semântica (3 → leva 2 → 1 na origem e 2 no destino) é provada num Postgres de
 * verdade em `tests/invariants/prospeccao-contagem-do-cartao-no-movimento.test.ts`;
 * aqui a guarda é sobre a CONSULTA, que um banco de mentira não saberia julgar.
 */
import { describe, expect, it, vi } from "vitest";

import { CAMPANHAS_DA_LISTA_SQL, listarCampanhasDaLista } from "./campanhas-da-lista";

describe("a contagem do cartão é derivada das linhas", () => {
  it("a consulta conta as empresas da lista em vez de ler a coluna guardada", () => {
    // O agregado sobre `prospecting_candidates` é a única fonte do número.
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/count\(\*\)::int as empresas/i);
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/from prospecting_candidates/i);
    // E a coluna guardada da campanha NÃO é lida: é ela que fica velha no movimento.
    expect(CAMPANHAS_DA_LISTA_SQL).not.toMatch(/c\.result_count/i);
    // O `left join` é o que mantém a campanha vazia na lista, com 0.
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/left join/i);
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/coalesce\(k\.empresas,0\)::int as result_count/i);
  });

  it("filtra pela organização e mantém a ordem e o teto da tela (#4359, 50 cartões)", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await listarCampanhasDaLista({ query } as never, "org-1");
    expect(query).toHaveBeenCalledWith(CAMPANHAS_DA_LISTA_SQL, ["org-1"]);
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/where c\.organization_id=\$1/i);
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/arquivada_em/i);
    expect(CAMPANHAS_DA_LISTA_SQL).toMatch(/limit 50/i);
  });

  it("devolve as linhas como vieram do banco, sem recontar no cliente", async () => {
    const linhas = [
      { id: "a", result_count: 1 },
      { id: "b", result_count: 0 },
    ];
    const query = vi.fn(async () => ({ rows: linhas }));
    await expect(listarCampanhasDaLista({ query } as never, "org-1")).resolves.toEqual(linhas);
  });
});
