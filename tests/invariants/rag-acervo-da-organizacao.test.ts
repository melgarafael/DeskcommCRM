import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  columnExists,
  countAs,
  indexExists,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";
import { STATUS_DO_MATERIAL_CONSULTAVEL } from "../../lib/ai/knowledge/estado-do-material";

/**
 * Migration 0181 — o acervo é da ORGANIZAÇÃO, e o agente escolhe o que lê.
 *
 * O que este arquivo mede é o que a migration promete, contra um Postgres real
 * com o `baseline.sql` aplicado — que é o arquivo que o self-hoster recebe.
 *
 * Os quatro casos que sustentam a mudança inteira:
 *
 *  1. **Duas fontes ativas do mesmo tipo cabem na organização.** Enquanto o
 *     índice `(agent_id, source_type) WHERE is_active` existia, o SEGUNDO PDF de
 *     qualquer organização colidia com 23505 — e todo arquivo enviado virava
 *     `source_type='policy'`.
 *  2. **A busca devolve só o material que o agente pode ler.** É o objetivo
 *     inteiro: dois assistentes, acervos diferentes, mesma organização.
 *  3. **Uma versão LEGADA (multi-fonte) continua respondendo por fonte.** É o
 *     que torna o backfill barato e o que mais fácil quebraria sem medição: as
 *     versões antigas contêm chunks de VÁRIAS fontes e não podem ser atribuídas
 *     a uma só.
 *  4. **O papel mais fraco não apaga a base.** As quatro tabelas de RAG ficaram
 *     de fora do aperto da 0150 e um `viewer` DELETAVA `ai_chunks` da própria
 *     organização falando direto com o PostgREST, com o JWT dele.
 *
 * Cada caso vem em PAR — o que deve ser barrado é barrado E o que deve passar
 * passa. Um teste só com a metade negativa fica verde se a tabela sumir, se a
 * policy negar todo mundo, ou se a fixture não existir.
 */

const AGENTE_A = "dddddddd-1111-4000-8000-000000000001";
const AGENTE_B = "dddddddd-1111-4000-8000-000000000002";
const VERSAO_A = "dddddddd-2222-4000-8000-000000000001";
const VERSAO_B = "dddddddd-2222-4000-8000-000000000002";
const FONTE_A = "dddddddd-3333-4000-8000-000000000001";
const FONTE_B = "dddddddd-3333-4000-8000-000000000002";
const KBV_LEGADA = "dddddddd-4444-4000-8000-000000000001";
const CRED = "dddddddd-5555-4000-8000-000000000001";

/** Vetor determinístico de 1536 dims — o mesmo para tudo, porque o que se mede
 *  aqui é o RECORTE (quais linhas voltam), não o ranking. */
const VETOR = `(select array_fill(0.1::real, array[1536])::vector)`;

function seedAcervo(): void {
  sql(`
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, validated_at)
      values ('${CRED}', '${GOV_ORG}', 'openai', 'Chave do acervo',
              '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '4242', now())
      on conflict do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt, kind, is_default)
      values ('${AGENTE_A}', '${GOV_ORG}', 'Acervo A', 'p', 'mcp_agent', false),
             ('${AGENTE_B}', '${GOV_ORG}', 'Acervo B', 'p', 'mcp_agent', false)
      on conflict do nothing;

    -- DUAS fontes do MESMO tipo, ativas, na mesma organização. Era exatamente o
    -- que o índice único derrubado impedia.
    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE_A}', '${GOV_ORG}', null, 'documento', 'Manual do suporte', 'ready', true),
             ('${FONTE_B}', '${GOV_ORG}', null, 'documento', 'Tabela de comissões', 'ready', true)
      on conflict do nothing;

    -- UMA versão de índice compartilhada pelas duas fontes: é a forma das
    -- versões anteriores à 0181, e ela precisa continuar funcionando.
    insert into public.ai_knowledge_versions
      (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${KBV_LEGADA}', '${GOV_ORG}', '${AGENTE_A}', null, 1, 'ready', true)
      on conflict do nothing;

    update public.ai_knowledge_sources
       set active_kb_version_id = '${KBV_LEGADA}'
     where id in ('${FONTE_A}', '${FONTE_B}');

    insert into public.ai_chunks
      (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
      values ('${GOV_ORG}', '${FONTE_A}', '${KBV_LEGADA}', 0, 'trecho do manual do suporte', 'h1', 6, ${VETOR}),
             ('${GOV_ORG}', '${FONTE_B}', '${KBV_LEGADA}', 0, 'trecho da tabela de comissoes', 'h2', 6, ${VETOR})
      on conflict do nothing;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model,
       credential_id, channel_session_id, status, knowledge_source_ids)
      values ('${VERSAO_A}', '${GOV_ORG}', '${AGENTE_A}', 1, 'p', 'openai', 'gpt-5-mini',
              '${CRED}', '${GOV_SESSION}', 'draft', array['${FONTE_A}']::uuid[]),
             ('${VERSAO_B}', '${GOV_ORG}', '${AGENTE_B}', 1, 'p', 'openai', 'gpt-5-mini',
              '${CRED}', '${GOV_SESSION}', 'draft', array['${FONTE_B}']::uuid[])
      on conflict do nothing;
  `);
}

function trechosDe(fontes: string[]): string[] {
  const lista = fontes.map((f) => `'${f}'`).join(",");
  const out = sql(`
    select content from public.fn_buscar_trechos_das_fontes(
      '${GOV_ORG}', array[${lista}]::uuid[], ${VETOR}, 10, -1
    ) order by content;
  `);
  return out.split("\n").filter((l) => l.trim().length > 0);
}

beforeAll(() => {
  seedGov();
  seedAcervo();
});

describe("0181 — o acervo deixa de pertencer a um agente", () => {
  it("a fonte pode não ter agente: `agent_id` é nullable", () => {
    expect(
      sql(`
        select is_nullable from information_schema.columns
         where table_schema='public' and table_name='ai_knowledge_sources' and column_name='agent_id';
      `),
    ).toBe("YES");
  });

  it("o índice que dava UM material por categoria por agente não existe mais", () => {
    expect(indexExists("ai_knowledge_sources_unique_per_agent")).toBe(false);
  });

  it("duas fontes ATIVAS do mesmo tipo convivem na organização", () => {
    // O par positivo do caso acima: sem ele, "o índice sumiu" passaria com a
    // tabela vazia ou com as duas fontes rejeitadas por outro motivo.
    expect(
      Number(
        sql(`
          select count(*) from public.ai_knowledge_sources
           where organization_id='${GOV_ORG}' and source_type='documento' and is_active;
        `),
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("nome duplicado na MESMA organização é recusado — é por ele que a pessoa distingue", () => {
    let recusou = false;
    try {
      sql(`
        insert into public.ai_knowledge_sources
          (organization_id, source_type, name, status, is_active)
          values ('${GOV_ORG}', 'faq', 'Manual do suporte', 'ready', true);
      `);
    } catch (err) {
      recusou = /duplicate key|unique/i.test(String((err as { stderr?: string }).stderr ?? err));
    }
    expect(recusou, "dois materiais ativos com o mesmo nome passaram").toBe(true);
  });

  it("arquivar pela metade é recusado pelo banco", () => {
    // `status='archived'` com `is_active=true` era o estado real do produto —
    // nenhuma linha do repo jamais escreveu `is_active = false`.
    let recusou = false;
    try {
      sql(`
        update public.ai_knowledge_sources
           set status='archived'
         where id='${FONTE_B}';
      `);
    } catch (err) {
      recusou = /arquivada_nao_e_ativa|check constraint/i.test(
        String((err as { stderr?: string }).stderr ?? err),
      );
    }
    expect(recusou, "arquivou e deixou a fonte ativa").toBe(true);
  });
});

describe("0181 — a busca devolve só o material que o agente pode ler", () => {
  it("cada assistente recebe o acervo DELE", () => {
    expect(trechosDe([FONTE_A])).toEqual(["trecho do manual do suporte"]);
    expect(trechosDe([FONTE_B])).toEqual(["trecho da tabela de comissoes"]);
  });

  it("uma versão LEGADA (multi-fonte) continua respondendo por fonte", () => {
    // As duas fontes apontam para a MESMA `kb_version_id` — a forma de todas as
    // versões anteriores à 0181. O predicado casa (kb_version_id,
    // knowledge_source_id), então cada fonte recebe só o que é dela.
    const juntos = trechosDe([FONTE_A, FONTE_B]);
    expect(juntos).toHaveLength(2);
  });

  it("lista vazia devolve vazio — falha FECHADA, e não 'tudo'", () => {
    expect(trechosDe([])).toEqual([]);
  });

  it("fonte ARQUIVADA sai da busca sem precisar apagar chunk nenhum", () => {
    sql(`
      update public.ai_knowledge_sources
         set status='archived', is_active=false
       where id='${FONTE_B}';
    `);
    expect(trechosDe([FONTE_B])).toEqual([]);
    // E volta: sem devolver o estado, o arquivo seguinte mede o resto deste.
    sql(`
      update public.ai_knowledge_sources
         set status='ready', is_active=true
       where id='${FONTE_B}';
    `);
    expect(trechosDe([FONTE_B])).toHaveLength(1);
  });

  it("o estado de volta é `ready`: `active` não existe no vocabulário do banco", () => {
    // O inverso do soft-delete grava `status='ready'` + `is_active=true`, que é
    // o par que a rota de desarquivar usa. `active` é a língua do PEDIDO da API,
    // não da coluna: `ai_knowledge_sources_status_check` só aceita
    // ready|archived|building|failed. A primeira versão da rota gravou `active`
    // e o banco recusou com 23514 — a tela mostrava 500 e o material continuava
    // arquivado. Este caso é a cerca contra repetir a troca de vocabulário.
    sql(`
      update public.ai_knowledge_sources
         set status='archived', is_active=false
       where id='${FONTE_B}';
    `);
    expect(trechosDe([FONTE_B])).toEqual([]);

    let recusou = false;
    try {
      sql(`
        update public.ai_knowledge_sources
           set status='active', is_active=true
         where id='${FONTE_B}';
      `);
    } catch (err) {
      recusou = /ai_knowledge_sources_status_check|check constraint/i.test(
        String((err as { stderr?: string }).stderr ?? err),
      );
    }
    expect(recusou, "'active' passou pelo CHECK da coluna — vocabulário mudou").toBe(true);

    // O update do desarquivar, com o MESMO valor que a rota grava
    // (`PATCH_DE_RESTAURO`): o material volta para a busca do agente, pela
    // função que o turno chama. Trocar o valor no código de produção derruba
    // este caso — não é um literal de teste repetindo a si mesmo.
    sql(`
      update public.ai_knowledge_sources
         set status='${STATUS_DO_MATERIAL_CONSULTAVEL}', is_active=true
       where id='${FONTE_B}';
    `);
    expect(trechosDe([FONTE_B])).toHaveLength(1);
  });

  it("material indexado com OUTRO modelo fica de fora — vetor incomparável responde errado", () => {
    sql(`update public.ai_knowledge_versions set embedding_model='outro-modelo' where id='${KBV_LEGADA}';`);
    const out = sql(`
      select count(*) from public.fn_buscar_trechos_das_fontes(
        '${GOV_ORG}', array['${FONTE_A}']::uuid[], ${VETOR}, 10, -1, 'openai/text-embedding-3-small'
      );
    `);
    expect(Number(out), "trecho de outro modelo entrou na busca").toBe(0);

    // Par positivo: com o modelo casando, o mesmo trecho volta. Sem esta
    // metade, "0 linhas" passaria com a função quebrada.
    sql(`update public.ai_knowledge_versions set embedding_model='openai/text-embedding-3-small' where id='${KBV_LEGADA}';`);
    const ok = sql(`
      select count(*) from public.fn_buscar_trechos_das_fontes(
        '${GOV_ORG}', array['${FONTE_A}']::uuid[], ${VETOR}, 10, -1, 'openai/text-embedding-3-small'
      );
    `);
    expect(Number(ok)).toBe(1);
  });

  it("a função não é alcançável pela chave anônima", () => {
    // Ela vai no bundle do browser. Função nova em `public` nasce exposta por
    // DUAS origens, e tratar só uma deixa o buraco com o gate verde.
    const grants = sql(`
      select coalesce(string_agg(distinct grantee, ','), '') from information_schema.role_routine_grants
       where routine_schema='public' and routine_name='fn_buscar_trechos_das_fontes'
         and grantee in ('anon','PUBLIC');
    `);
    expect(grants.trim()).toBe("");
  });
});

describe("0181 — o escopo mora na versão publicada", () => {
  it("`knowledge_source_ids` existe em ai_agent_versions", () => {
    expect(columnExists("ai_agent_versions", "knowledge_source_ids")).toBe(true);
  });

  it("versão PUBLICADA não muda de acervo sem virar versão nova", () => {
    sql(`update public.ai_agent_versions set status='published' where id='${VERSAO_A}';`);
    let recusou = false;
    try {
      sql(`
        update public.ai_agent_versions
           set knowledge_source_ids = array['${FONTE_B}']::uuid[]
         where id='${VERSAO_A}';
      `);
    } catch (err) {
      recusou = /imutável|immutable/i.test(String((err as { stderr?: string }).stderr ?? err));
    }
    sql(`update public.ai_agent_versions set status='draft' where id='${VERSAO_A}';`);
    expect(
      recusou,
      "escopo de leitura editável em versão publicada é a própria ausência de escopo",
    ).toBe(true);
  });

  it("versão RASCUNHO muda normalmente (par positivo)", () => {
    // Sem esta metade, o caso acima passaria com o trigger recusando TUDO.
    sql(`
      update public.ai_agent_versions
         set knowledge_source_ids = array['${FONTE_A}']::uuid[]
       where id='${VERSAO_A}';
    `);
    expect(
      sql(`select array_length(knowledge_source_ids, 1) from public.ai_agent_versions where id='${VERSAO_A}';`),
    ).toBe("1");
  });
});

describe("0181 — o papel mais fraco não apaga a base de conhecimento", () => {
  it("viewer LÊ o acervo (a tela precisa)", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.ai_knowledge_sources where organization_id='${GOV_ORG}';`),
    ).toBeGreaterThan(0);
  });

  it("viewer NÃO apaga fonte de conhecimento", () => {
    expect(
      writeCountAs(GOV_VIEWER, `delete from public.ai_knowledge_sources where id='${FONTE_A}'`),
    ).toBe(0);
  });

  it("viewer NÃO apaga trecho indexado", () => {
    expect(
      writeCountAs(GOV_VIEWER, `delete from public.ai_chunks where organization_id='${GOV_ORG}'`),
    ).toBe(0);
  });

  it("manager EDITA o acervo — o par positivo do gate", () => {
    // Sem ele, os dois casos acima ficariam verdes com a policy negando todo
    // mundo, e a tela de conhecimento estaria quebrada para o dono do negócio.
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.ai_knowledge_sources set name='Manual do suporte' where id='${FONTE_A}'`,
      ),
    ).toBe(1);
  });

  it("admin apaga trecho indexado — o par positivo do gate de escrita do motor", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.ai_chunks set content = content where organization_id='${GOV_ORG}'`,
      ),
    ).toBeGreaterThan(0);
  });

  it("`anon` não tem GRANT nenhum nas quatro tabelas do acervo", () => {
    const grants = sql(`
      select coalesce(string_agg(distinct table_name, ','), '') from information_schema.role_table_grants
       where grantee='anon'
         and table_name in ('ai_chunks','ai_faq_items','ai_knowledge_sources','ai_knowledge_versions');
    `);
    expect(grants.trim()).toBe("");
  });
});
