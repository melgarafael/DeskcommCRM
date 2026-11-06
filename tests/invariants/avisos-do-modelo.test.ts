/**
 * O AVISO DO MODELO NO CANAL DIRETO, NO BANCO QUE O KIT INSTALA (migration 9084).
 *
 * Duas coisas moram no banco e só um Postgres real prova:
 *
 *  1. O CHECK de `agent_inbox_items.kind` aceita `channel_template_review_direct`
 *     — sem ele o INSERT do handler é recusado num caminho que trata a falha
 *     sem 5xx (`abrirAvisoDoModelo` devolve `"falhou"`) e o aviso simplesmente
 *     nunca aparece. É o modo de falha silencioso que a 0129 já pagou uma vez.
 *  2. O índice único PARCIAL `agent_inbox_modelo_direto_aberto_unico` é o que
 *     fecha a corrida de duas entregas iguais do webhook: o SELECT-antes-do-
 *     INSERT do handler não basta sozinho, e é o `23505` que ele lê como
 *     "já aberto". Parcial em `status = 'open'` para um evento NOVO poder abrir
 *     aviso depois que o anterior foi resolvido.
 *
 * O `ref_id` é a CONEXÃO: a mesma chave em outra conexão da organização TEM de
 * ser aceita — é o que impede o aviso de vazar entre números da mesma empresa.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_SESSION,
  seedGov,
  sql,
} from "./gov-helpers";

const KIND = "channel_template_review_direct";
/** Duas conexões da MESMA organização (ids de `channel_sessions` já semeados). */
const SESSAO_A = GOV_SESSION;
const SESSAO_B = GOV_CONV_UNASSIGNED;
const TITULO = 'Modelo "boas_vindas" (pt_BR) foi aprovado';

function abrir(kind: string, refId: string, titulo = TITULO): void {
  sql(`insert into public.agent_inbox_items
         (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ('${GOV_ORG}', '${kind}', 'info', '${titulo}', 'corpo', 'channel_session', '${refId}');`);
}

function limpar(): void {
  sql(`delete from public.agent_inbox_items
        where organization_id = '${GOV_ORG}' and kind = '${KIND}';`);
}

function contagem(refId: string): number {
  return Number(
    sql(`select count(*) from public.agent_inbox_items
          where organization_id = '${GOV_ORG}' and kind = '${KIND}' and ref_id = '${refId}';`),
  );
}

beforeAll(() => seedGov());

describe("aviso do modelo no canal oficial direto", () => {
  it("o banco aceita o kind novo — e segue recusando um inventado", () => {
    limpar();
    abrir(KIND, SESSAO_A);
    expect(contagem(SESSAO_A)).toBe(1);

    expect(() => abrir("channel_template_review_direct_inventado", SESSAO_A)).toThrow(
      /agent_inbox_items_kind_check/,
    );
  });

  it("duas entregas iguais com o aviso ABERTO: a segunda viola o índice único", () => {
    limpar();
    abrir(KIND, SESSAO_A);

    expect(() => abrir(KIND, SESSAO_A)).toThrow(/agent_inbox_modelo_direto_aberto_unico/);
    expect(contagem(SESSAO_A)).toBe(1);
  });

  it("o mesmo modelo em OUTRA conexão da organização abre aviso próprio", () => {
    limpar();
    abrir(KIND, SESSAO_A);
    abrir(KIND, SESSAO_B);

    expect(contagem(SESSAO_A)).toBe(1);
    expect(contagem(SESSAO_B)).toBe(1);
  });

  it("resolvido o aviso, um evento novo pode abrir outro (índice é parcial)", () => {
    limpar();
    abrir(KIND, SESSAO_A);
    sql(`update public.agent_inbox_items
            set status = 'resolved'
          where organization_id = '${GOV_ORG}' and kind = '${KIND}' and ref_id = '${SESSAO_A}';`);

    // Um desfecho diferente também muda o título; aqui repetimos o mesmo de
    // propósito: o que libera é o status, não o texto.
    abrir(KIND, SESSAO_A);
    expect(contagem(SESSAO_A)).toBe(2);
  });
});
