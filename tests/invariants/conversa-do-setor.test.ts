import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * #4022 — o atendente vê as conversas do PRÓPRIO SETOR (migration 9214).
 *
 * A régua nova é `visibility_mode = 'own_and_sector'`: o papel restrito
 * (`agent`/`ai_operator`) enxerga a conversa cujo `sector_id` é de um setor em
 * que ele está vinculado — inclusive a que está com um COLEGA do setor — e
 * continua sem ver as dos outros setores. Gestor/admin/viewer seguem org-wide.
 *
 * Este arquivo prova o banco, não uma função pura: as leituras são feitas como
 * `authenticated`, com o JWT simulado por `request.jwt.claims`, exatamente o
 * caminho do PostgREST. É o que distingue "a policy devolve" de "a função
 * deveria devolver".
 *
 * ─── Os sete lados opostos, e onde cada um mora aqui ────────────────────────
 *
 *   a. conversa de OUTRO setor continua invisível ............ "outro setor"
 *   b. membro SEM setor: só as que são dele ................... "sem setor"
 *   c. membro com DOIS setores vê os dois ..................... "dois setores"
 *   d. gestor e administrador veem tudo ....................... "gestor/admin"
 *   e. outra ORGANIZAÇÃO continua isolada ..................... "outra organização"
 *   f. abrir pelo ID respeita a mesma régua ................... "abrir pelo id"
 *   g. contadores de fila não vazam ........................... "contadores"
 *
 * E o que NÃO pode ter mudado, medido no banco, com controle positivo: as
 * mensagens da conversa do colega são legíveis (a policy de `messages` herda a de
 * `conversations` por `exists`), a NOTA INTERNA continua oculta (é a régua de
 * `fn_can_view_conversation`, que não conhece o setor — o mesmo recorte do
 * atendimento conjunto), e a escrita segue do dono/gestor: a conversa do colega
 * é somente leitura para o atendente.
 *
 * O custo também é medido: a função de escopo roda UMA vez por consulta, não uma
 * vez por linha — a lição do #3090, que a 0726 pagou caro para consertar.
 */

const ORG_A = "40224022-aaaa-4000-8000-000000000001";
const ORG_B = "40224022-bbbb-4000-8000-000000000001";

const ANA = "40224022-1111-4000-8000-000000000001"; // agent, Atacado
const NATALIA = "40224022-1111-4000-8000-000000000002"; // agent, Atacado
const CAIO = "40224022-1111-4000-8000-000000000003"; // agent, Financeiro
const BIA = "40224022-1111-4000-8000-000000000004"; // agent, SEM setor
const MULT = "40224022-1111-4000-8000-000000000005"; // agent, Atacado + Financeiro
const GERENTE = "40224022-1111-4000-8000-000000000006"; // manager
const ADMIN = "40224022-1111-4000-8000-000000000007"; // admin
const AGENTE_B = "40224022-1112-4000-8000-000000000001"; // agent da OUTRA organização
const GERENTE_B = "40224022-1112-4000-8000-000000000002"; // manager da OUTRA organização

const ATACADO = "40224022-5ec0-4000-8000-000000000001";
const FINANCEIRO = "40224022-5ec0-4000-8000-000000000002";
const COMPRAS_B = "40224022-5ec1-4000-8000-000000000001";

/** As seis conversas da organização A — cada uma com o seu papel no cenário. */
const COLEGA = "40224022-c0a0-4000-8000-000000000001"; // Atacado, com a Natália
const FILA_DO_SETOR = "40224022-c0a0-4000-8000-000000000002"; // Atacado, sem dono
const OUTRO_SETOR = "40224022-c0a0-4000-8000-000000000003"; // Financeiro, com o Caio
const SEM_SETOR = "40224022-c0a0-4000-8000-000000000004"; // sem setor, sem dono
const MINHA = "40224022-c0a0-4000-8000-000000000005"; // Atacado, com a Ana
const DA_BIA = "40224022-c0a0-4000-8000-000000000006"; // Atacado, com a Bia (sem setor)
const CONVERSA_ORG_B = "40224022-c0b0-4000-8000-000000000001"; // organização B

const TODAS_DA_ORG_A = [COLEGA, FILA_DO_SETOR, OUTRO_SETOR, SEM_SETOR, MINHA, DA_BIA];

/** As conversas de ORG_A que o usuário enxerga, em ordem estável. */
function visiveis(usuario: string, organizacao: string = ORG_A): string[] {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
    select coalesce(string_agg(id::text, ',' order by id), 'vazio')
      from public.conversations
     where organization_id = '${organizacao}';
  `);
  // Sentinela, e não string vazia: o psql -tA imprime uma linha VAZIA quando o
  // agregado não casa nada, e `sql()` trima o stdout final — a última linha
  // passaria a ser a saída do set_config acima. Foi medido: sem a sentinela, o
  // caso "outra organização" comparava com o JSON do claim.
  const linha = lastLine(saida);
  return linha === "vazio" ? [] : linha.split(",");
}

/** Quantas linhas o usuário enxerga quando pergunta por UM id (deep link). */
function abrirPeloId(usuario: string, conversa: string): number {
  return Number(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        select count(*) from public.conversations where id = '${conversa}';
      `),
    ),
  );
}

function contar(usuario: string, where: string, tabela = "public.conversations"): number {
  return Number(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        select count(*) from ${tabela} where ${where};
      `),
    ),
  );
}

/** Quantas linhas `fn_conversation_sector_scope()` devolve para o usuário. */
function setoresDoEscopo(usuario: string): number {
  return Number(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        select count(*) from public.fn_conversation_sector_scope();
      `),
    ),
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ANA}',      'ana@4022.test'),
      ('${NATALIA}',  'natalia@4022.test'),
      ('${CAIO}',     'caio@4022.test'),
      ('${BIA}',      'bia@4022.test'),
      ('${MULT}',     'mult@4022.test'),
      ('${GERENTE}',  'gerente@4022.test'),
      ('${ADMIN}',    'admin@4022.test'),
      ('${AGENTE_B}', 'agente-b@4022.test'),
      ('${GERENTE_B}','gerente-b@4022.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'setor-a-4022', 'Setor A', 'Setor A', '{"visibility_mode":"own_and_sector"}'::jsonb),
      ('${ORG_B}', 'setor-b-4022', 'Setor B', 'Setor B', '{"visibility_mode":"own_and_sector"}'::jsonb)
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ANA}',      '${ORG_A}', 'agent',   now()),
      ('${NATALIA}',  '${ORG_A}', 'agent',   now()),
      ('${CAIO}',     '${ORG_A}', 'agent',   now()),
      ('${BIA}',      '${ORG_A}', 'agent',   now()),
      ('${MULT}',     '${ORG_A}', 'agent',   now()),
      ('${GERENTE}',  '${ORG_A}', 'manager', now()),
      ('${ADMIN}',    '${ORG_A}', 'admin',   now()),
      ('${AGENTE_B}', '${ORG_B}', 'agent',   now()),
      ('${GERENTE_B}','${ORG_B}', 'manager', now())
    on conflict do nothing;

    do $canal$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('40224022-c2a0-4000-8000-000000000001', '${ORG_A}', 'setor-a-4022', '\\x00'::bytea);
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('40224022-c2b0-4000-8000-000000000001', '${ORG_B}', 'setor-b-4022', '\\x00'::bytea);
    exception when unique_violation then null; end $canal$;

    insert into public.contacts (id, organization_id, display_name) values
      ('40224022-c001-4000-8000-000000000001', '${ORG_A}', 'Contato do colega'),
      ('40224022-c001-4000-8000-000000000002', '${ORG_A}', 'Contato da fila do setor'),
      ('40224022-c001-4000-8000-000000000003', '${ORG_A}', 'Contato de outro setor'),
      ('40224022-c001-4000-8000-000000000004', '${ORG_A}', 'Contato sem setor'),
      ('40224022-c001-4000-8000-000000000005', '${ORG_A}', 'Contato meu'),
      ('40224022-c001-4000-8000-000000000006', '${ORG_A}', 'Contato da Bia'),
      ('40224022-c001-4000-8000-000000000011', '${ORG_B}', 'Contato da outra organizacao')
    on conflict (id) do nothing;

    insert into public.attendant_sectors (id, organization_id, name) values
      ('${ATACADO}',    '${ORG_A}', 'Atacado'),
      ('${FINANCEIRO}', '${ORG_A}', 'Financeiro'),
      ('${COMPRAS_B}',  '${ORG_B}', 'Compras')
    on conflict (id) do nothing;

    insert into public.attendant_sector_members (organization_id, user_id, sector_id) values
      ('${ORG_A}', '${ANA}',     '${ATACADO}'),
      ('${ORG_A}', '${NATALIA}', '${ATACADO}'),
      ('${ORG_A}', '${CAIO}',    '${FINANCEIRO}'),
      ('${ORG_A}', '${MULT}',    '${ATACADO}'),
      ('${ORG_A}', '${MULT}',    '${FINANCEIRO}'),
      ('${ORG_B}', '${AGENTE_B}','${COMPRAS_B}')
    on conflict do nothing;

    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, sector_id)
    values
      ('${COLEGA}',        '${ORG_A}', '40224022-c001-4000-8000-000000000001', '40224022-c2a0-4000-8000-000000000001', 'claimed', '${NATALIA}', now(), '${ATACADO}'),
      ('${FILA_DO_SETOR}', '${ORG_A}', '40224022-c001-4000-8000-000000000002', '40224022-c2a0-4000-8000-000000000001', 'open',    null,         null,  '${ATACADO}'),
      ('${OUTRO_SETOR}',   '${ORG_A}', '40224022-c001-4000-8000-000000000003', '40224022-c2a0-4000-8000-000000000001', 'claimed', '${CAIO}',    now(), '${FINANCEIRO}'),
      ('${SEM_SETOR}',     '${ORG_A}', '40224022-c001-4000-8000-000000000004', '40224022-c2a0-4000-8000-000000000001', 'open',    null,         null,  null),
      ('${MINHA}',         '${ORG_A}', '40224022-c001-4000-8000-000000000005', '40224022-c2a0-4000-8000-000000000001', 'claimed', '${ANA}',     now(), '${ATACADO}'),
      ('${DA_BIA}',        '${ORG_A}', '40224022-c001-4000-8000-000000000006', '40224022-c2a0-4000-8000-000000000001', 'claimed', '${BIA}',     now(), '${ATACADO}'),
      ('${CONVERSA_ORG_B}', '${ORG_B}', '40224022-c001-4000-8000-000000000011', '40224022-c2b0-4000-8000-000000000001', 'claimed', '${AGENTE_B}', now(), '${COMPRAS_B}')
    on conflict (id) do nothing;

    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body, status)
    values
      ('40224022-3e50-4000-8000-000000000001', '${ORG_A}', '${COLEGA}',
       '40224022-c2a0-4000-8000-000000000001', '40224022-c001-4000-8000-000000000001',
       'text', 'inbound', 'mensagem que a colega recebeu', 'delivered')
    on conflict (id) do nothing;

    insert into public.conversation_notes
      (id, organization_id, conversation_id, created_by_user_id, body)
    values
      ('40224022-9e70-4000-8000-000000000001', '${ORG_A}', '${COLEGA}', '${NATALIA}',
       'nota interna da colega')
    on conflict (id) do nothing;
  `);
});

describe("#4022 — o atendente vê as conversas do próprio setor", () => {
  it("o atendente vê as do setor, inclusive a que está com um colega", () => {
    // GREEN literal: das seis conversas da organização, a Ana enxerga quatro —
    // a dela, a fila do setor (sem dono), a que está com a Natália e a que está
    // com a Bia (que é do Atacado e não tem setor próprio).
    expect(visiveis(ANA).sort()).toEqual([COLEGA, FILA_DO_SETOR, MINHA, DA_BIA].sort());
  });

  it("(a) a conversa de OUTRO setor continua invisível", () => {
    expect(visiveis(ANA)).not.toContain(OUTRO_SETOR);
    // E o outro lado do par: o dono do outro setor enxerga a dele — e nem a fila
    // do Atacado nem a conversa da Ana.
    expect(visiveis(CAIO)).toEqual([OUTRO_SETOR]);
  });

  it("(b) membro SEM setor vê só as conversas que são dele", () => {
    // A Bia não tem vínculo em attendant_sector_members: sem setor, não há escopo
    // de setor. Ela vê a conversa dela — que é do Atacado, setor de OUTRAS
    // pessoas — e não vê a do colega nem a fila.
    expect(visiveis(BIA)).toEqual([DA_BIA]);
    expect(setoresDoEscopo(BIA)).toBe(0);
  });

  it("(c) membro com DOIS setores vê os dois", () => {
    expect(visiveis(MULT).sort()).toEqual(
      [COLEGA, FILA_DO_SETOR, MINHA, DA_BIA, OUTRO_SETOR].sort(),
    );
    expect(setoresDoEscopo(MULT)).toBe(2);
  });

  it("(d) gestor e administrador veem tudo — menos a outra organização", () => {
    expect(visiveis(GERENTE).sort()).toEqual([...TODAS_DA_ORG_A].sort());
    expect(visiveis(ADMIN).sort()).toEqual([...TODAS_DA_ORG_A].sort());
    // O caminho do setor nem é consultado para eles: zero linhas de escopo.
    expect(setoresDoEscopo(GERENTE)).toBe(0);
    expect(setoresDoEscopo(ADMIN)).toBe(0);
  });

  it("(e) outra organização continua isolada, nas duas direções", () => {
    expect(visiveis(AGENTE_B, ORG_B)).toEqual([CONVERSA_ORG_B]);
    expect(visiveis(GERENTE_B, ORG_A)).toEqual([]);
    expect(visiveis(GERENTE, ORG_B)).toEqual([]);
    // Nem o setor de outra organização entra no escopo de quem é de ORG_A.
    expect(abrirPeloId(ANA, CONVERSA_ORG_B)).toBe(0);
  });

  it("(f) abrir pelo ID respeita a mesma régua", () => {
    // É a rota do deep link e a da conversa por id: esconder da lista e entregar
    // pela URL seria o mesmo vazamento com outro nome.
    expect(abrirPeloId(ANA, COLEGA)).toBe(1);
    expect(abrirPeloId(ANA, FILA_DO_SETOR)).toBe(1);
    expect(abrirPeloId(ANA, OUTRO_SETOR)).toBe(0);
    expect(abrirPeloId(ANA, SEM_SETOR)).toBe(0);
    expect(abrirPeloId(GERENTE, OUTRO_SETOR)).toBe(1);
  });

  it("(g) os contadores de fila não vazam o setor alheio", () => {
    // O badge da aba Fila é um count sobre a mesma tabela: se a policy está certa,
    // ele conta só o que o atendente pode abrir.
    expect(contar(ANA, "assigned_to_user_id is null")).toBe(1);
    expect(contar(CAIO, "assigned_to_user_id is null")).toBe(0);
    expect(contar(BIA, "assigned_to_user_id is null")).toBe(0);
    expect(contar(GERENTE, "assigned_to_user_id is null")).toBe(2);
    // E o total do Inbox acompanha (é o count do "Todas" que o gestor vê).
    expect(contar(ANA, "true")).toBe(4);
    expect(contar(GERENTE, "true")).toBe(6);
  });

  it("as mensagens da conversa do colega são legíveis; a NOTA INTERNA não", () => {
    // A policy de messages herda a de conversations por exists: quem passou a ver
    // a conversa passa a ler o histórico. Isso é o que cobre férias.
    expect(contar(ANA, `conversation_id = '${COLEGA}'`, "public.messages")).toBe(1);
    // A nota interna é a régua de fn_can_view_conversation, que NÃO conhece o
    // setor — o mesmo recorte do atendimento conjunto (#2542). Se alguém ampliar
    // aquela função para "fazer o setor funcionar", é este caso que fica vermelho:
    // a ampliação tem de ser decidida, não deslizada.
    expect(contar(ANA, `conversation_id = '${COLEGA}'`, "public.conversation_notes")).toBe(0);
    expect(contar(NATALIA, `conversation_id = '${COLEGA}'`, "public.conversation_notes")).toBe(1);
  });

  it("a conversa do colega é SOMENTE LEITURA para quem não é o responsável", () => {
    // As policies restritivas de UPDATE/DELETE da 9016 continuam valendo: ver não
    // é controlar. Nada nesta migration ampliou escrita.
    expect(
      writeCountAs(ANA, `update public.conversations set unread_count_for_assignee = 3 where id = '${COLEGA}'`),
    ).toBe(0);
    expect(
      writeCountAs(NATALIA, `update public.conversations set unread_count_for_assignee = 3 where id = '${COLEGA}'`),
    ).toBe(1);
    expect(
      writeCountAs(GERENTE, `update public.conversations set unread_count_for_assignee = 3 where id = '${COLEGA}'`),
    ).toBe(1);
  });

  it("o escopo do setor é resolvido uma vez por consulta, não por linha", () => {
    const saida = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ANA}"}', false);
      explain (analyze, format json, costs off) select count(*) from public.conversations;
    `);
    const plano = JSON.stringify(JSON.parse(saida.slice(saida.indexOf("["))));

    // A lição do #3090: nada de chamada por LINHA candidata.
    expect(plano).not.toContain("fn_can_view_conversation");
    // A função nova aparece e é UMA execução (loops=1), não uma por conversa.
    expect(plano).toContain("fn_conversation_sector_scope");
    // O plano em json vem embrulhado: [{ Plan: {...}, "Planning Time": ... }].
    const raiz = JSON.parse(saida.slice(saida.indexOf("["))) as Array<
      Record<string, unknown>
    >;
    const escopos: Array<Record<string, unknown>> = [];
    const empilhar = (no: Record<string, unknown> | undefined) => {
      if (!no) return;
      if (no["Function Name"] === "fn_conversation_sector_scope") escopos.push(no);
      for (const filho of (no["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) {
        empilhar(filho);
      }
    };
    empilhar((raiz[0]?.["Plan"] ?? raiz[0]) as Record<string, unknown>);
    expect(escopos.length).toBeGreaterThan(0);
    for (const no of escopos) expect(no["Actual Loops"]).toBe(1);
  });

  it("o modo novo não amplia nada fora de own_and_sector (controle negativo)", () => {
    // Nas organizações que NÃO ligaram o modo, a função nova devolve zero linhas —
    // e a policy é a de antes. Aqui: ORG_B também está no modo, então o teste do
    // "não amplia" é o da Bia (sem vínculo) e o do papel de gestor, acima.
    expect(setoresDoEscopo(ANA)).toBe(1);
    // Um valor inválido no JSON continua caindo no else da escada: o agente vê só
    // o que é dele. Trocar o modo e voltar prova que a disjunção não é um "ligou
    // para sempre".
    sql(`
      update public.organizations
         set settings = jsonb_set(settings, '{visibility_mode}', '"lixo"'::jsonb)
       where id = '${ORG_A}';
    `);
    try {
      expect(visiveis(ANA)).toEqual([MINHA]);
      expect(setoresDoEscopo(ANA)).toBe(0);
    } finally {
      sql(`
        update public.organizations
           set settings = jsonb_set(settings, '{visibility_mode}', '"own_and_sector"'::jsonb)
         where id = '${ORG_A}';
      `);
    }
  });
});

// Duas bordas a mais: o contato pessoal segue a mesma regra do ramo de participante
// (fora do alcance de quem não é o responsável), e o vínculo de setor de quem saiu
// da organização não dá leitura nenhuma.
describe("#4022 — bordas do escopo do setor", () => {
  const PESSOAL = "40224022-c0a0-4000-8000-0000000000f1";
  const REVOGADO = "40224022-1111-4000-8000-0000000000f2";
  beforeAll(() => {
    sql(`
      insert into public.contacts (id, organization_id, display_name, is_personal) values
        ('40224022-c001-4000-8000-0000000000f1', '${ORG_A}', 'Contato pessoal da colega', true)
      on conflict (id) do nothing;
      insert into public.conversations
        (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, sector_id)
      values ('${PESSOAL}', '${ORG_A}', '40224022-c001-4000-8000-0000000000f1',
              '40224022-c2a0-4000-8000-000000000001', 'claimed', '${NATALIA}', now(), '${ATACADO}')
      on conflict (id) do nothing;
      insert into auth.users (id, email) values ('${REVOGADO}', 'revogado@4022.test') on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
        values ('${REVOGADO}', '${ORG_A}', 'agent', now(), now()) on conflict do nothing;
      insert into public.attendant_sector_members (organization_id, user_id, sector_id)
        values ('${ORG_A}', '${REVOGADO}', '${ATACADO}') on conflict do nothing;
    `);
  });
  it("conversa de contato PESSOAL de colega do setor continua fora do alcance", () => {
    expect(abrirPeloId(ANA, PESSOAL)).toBe(0);
  });
  it("controle: no modo padrão a mesma conversa também não é alcançável", () => {
    sql(`update public.organizations set settings = jsonb_set(settings, '{visibility_mode}', '"own_and_unassigned"'::jsonb) where id = '${ORG_A}';`);
    try { expect(abrirPeloId(ANA, PESSOAL)).toBe(0); }
    finally { sql(`update public.organizations set settings = jsonb_set(settings, '{visibility_mode}', '"own_and_sector"'::jsonb) where id = '${ORG_A}';`); }
  });
  it("membro REVOGADO com vínculo de setor vê nada", () => {
    expect(visiveis(REVOGADO)).toEqual([]);
    expect(setoresDoEscopo(REVOGADO)).toBe(0);
  });
});
