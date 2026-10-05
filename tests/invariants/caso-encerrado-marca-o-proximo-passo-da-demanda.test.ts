/**
 * O CASO ENCERRADO MARCA O PRÓXIMO PASSO DA DEMANDA — E SÓ DA SUA (#2294).
 *
 * A migration 0505 (`trg_demanda_marca_proximo_passo_com_o_caso`) já está na
 * `main`, e o irmão `tests/unit/demanda-marca-proximo-passo-com-o-caso.test.ts`
 * lê o FONTE: ele reprova quem mexe na migration, mas não prova que o gatilho
 * DISPARA, que a guarda SEGURA o passo de alguém, nem que o filtro de tenant
 * vale. Este arquivo é a outra metade — cada caso escreve no Postgres real
 * (o efêmero do `scripts/test-db.sh`, com o `baseline.sql` aplicado em modo
 * install E update) e lê de volta.
 *
 * ## Os 5 pontos do corpo da issue, um por caso
 *
 *   1. `resolved` e `cancelled` preenchem `proximo_passo` da demanda que o
 *      caso abriu — e nada mais: `estado`, `desfecho` e `fechada_em` ficam como
 *      estavam (a doutrina proíbe o sistema decidir que a demanda acabou);
 *   2. a SEGUNDA mudança de status não reescreve um `proximo_passo` já
 *      preenchido — é este caso que fica vermelho sob sabotagem;
 *   3. `escalated` (não terminal) não tem efeito algum;
 *   4. demanda de OUTRA organização com o mesmo `agent_case_id` não é tocada;
 *   5. sabotagem: tirar `and proximo_passo is null` do `where` do gatilho
 *      deixa o caso 2 vermelho (provado no gate, restaurado byte a byte).
 *
 * ## Por que o caso 2 não pode ser o caso 1
 *
 * O gatilho grava UMA constante. Se o caso 2 só repetisse "o texto do gatilho
 * está lá", sabotar a guarda mudaria o `where` para... casar a mesma linha e
 * gravar a MESMA constante, e o teste continuaria verde — sabotagem que não
 * derruba nada não prova nada. É por isso que o caso 2 dá à demanda um passo
 * de PESSOA entre as duas mudanças de status: com a guarda, o `update` casa
 * ZERO linhas (e a `revision` da demanda nem sobe, porque `trg_demanda_revision`
 * só existe para linha atualizada); sem ela, o passo da pessoa vira a constante
 * do sistema e o caso cai com o valor literal na mensagem.
 *
 *   pnpm test:db tests/invariants/caso-encerrado-marca-o-proximo-passo-da-demanda.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/** A frase que a 0505 grava — a mesma que `fn_service_status` usa no fecho por conversa. */
const FRASE_DO_GATILHO = "Revisar o caso encerrado e registrar o desfecho da demanda";
/** Passo escolhido por uma PESSOA — é ele que a sabotagem apagaria. */
const PASSO_DE_PESSOA = "Ligar para a cliente e confirmar a troca";

// Namespace próprio (0505dd-), como nas ondas anteriores; sem colisão medida
// com os demais invariantes.
const ORG_A = "0505dd00-0000-4000-8000-000000000001";
const ORG_B = "0505dd00-0000-4000-8000-000000000002";
const SESSAO_A = "0505dd00-1111-4000-8000-000000000001";
const SESSAO_B = "0505dd00-1111-4000-8000-000000000002";
const CONTATO_A = "0505dd00-2222-4000-8000-000000000001";
const CONTATO_B = "0505dd00-2222-4000-8000-000000000002";
const CONVERSA_A = "0505dd00-3333-4000-8000-000000000001";
const CONVERSA_B = "0505dd00-3333-4000-8000-000000000002";

const CASO_RESOLVIDO = "0505dd00-4444-4000-8000-000000000001";
const CASO_CANCELADO = "0505dd00-4444-4000-8000-000000000002";
const CASO_SEGUNDA_TROCA = "0505dd00-4444-4000-8000-000000000003";
const CASO_ESCALADO = "0505dd00-4444-4000-8000-000000000004";
const CASO_DE_VIZINHA = "0505dd00-4444-4000-8000-000000000005";

const DEM_RESOLVIDA = "0505dd00-5555-4000-8000-000000000001";
const DEM_CANCELADA = "0505dd00-5555-4000-8000-000000000002";
const DEM_SEGUNDA = "0505dd00-5555-4000-8000-000000000003";
const DEM_ESCALADA = "0505dd00-5555-4000-8000-000000000004";
const DEM_DA_ORG_A = "0505dd00-5555-4000-8000-000000000005";
const DEM_DA_ORG_B = "0505dd00-5555-4000-8000-000000000006";

/** Última linha do psql (`-tA`); NULL vira `<nulo>` para o valor não se confundir com string vazia. */
function valor(demanda: string, coluna: string): string {
  const saida = sql(
    `select coalesce(${coluna}::text, '<nulo>') from public.demandas where id = '${demanda}';`,
  );
  const linha = saida.split("\n").at(-1)?.trim() ?? "";
  if (!linha) throw new Error(`INSTRUMENTO: nada voltou para ${coluna} de ${demanda}: ${saida}`);
  return linha;
}

/**
 * Transição de status do caso, contando as linhas — uma troca que não casa
 * nenhuma linha derruba o teste aqui, com a razão escrita, em vez de aparecer
 * depois como "o gatilho não agiu" (quando o que não aconteceu foi a troca).
 */
function trocarStatus(caso: string, de: string, para: string): void {
  const saida = sql(`
    with w as (
      update public.agent_cases set status = '${para}'
       where id = '${caso}' and status = '${de}'
      returning 1
    )
    select count(*) from w;`);
  const total = Number(saida.split("\n").at(-1)?.trim());
  if (total !== 1) {
    throw new Error(`INSTRUMENTO: troca de status ${de} → ${para} em ${caso} afetou ${total} linhas`);
  }
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0505-a', 'Invariante 0505 A', 'Invariante 0505 A'),
      ('${ORG_B}', 'inv-0505-b', 'Invariante 0505 B', 'Invariante 0505 B')
      on conflict do nothing;

    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE,
    -- que ON CONFLICT sem arbiter rejeita.
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'inv-0505-a', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;
    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'inv-0505-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Invariante 0505 Contato A'),
      ('${CONTATO_B}', '${ORG_B}', 'Invariante 0505 Contato B')
      on conflict do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open')
      on conflict do nothing;

    -- Cinco casos ABERTOS na org A, como o motor os cria (handoff por escalada).
    insert into public.agent_cases
        (id, organization_id, conversation_id, status, source, title, summary, blocker)
      values
        ('${CASO_RESOLVIDO}',     '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Invariante 0505 resolved',  'resumo', 'bloqueio'),
        ('${CASO_CANCELADO}',     '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Invariante 0505 cancelled',  'resumo', 'bloqueio'),
        ('${CASO_SEGUNDA_TROCA}', '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Invariante 0505 segunda',    'resumo', 'bloqueio'),
        ('${CASO_ESCALADO}',      '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Invariante 0505 escalated',  'resumo', 'bloqueio'),
        ('${CASO_DE_VIZINHA}',    '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Invariante 0505 vizinhanca', 'resumo', 'bloqueio')
      on conflict do nothing;

    -- As demandas que cada caso abriu: origem handoff, estado em_atendimento,
    -- proximo_passo e fechada_em vazios — exatamente o estado que a issue #2035
    -- mediu no self-host 1.68.0.
    insert into public.demandas
        (id, organization_id, contact_id, agent_case_id, origem, estado, assunto, proximo_passo, fechada_em)
      values
        ('${DEM_RESOLVIDA}', '${ORG_A}', '${CONTATO_A}', '${CASO_RESOLVIDO}',     'handoff', 'em_atendimento', 'Caso resolved',  null, null),
        ('${DEM_CANCELADA}', '${ORG_A}', '${CONTATO_A}', '${CASO_CANCELADO}',     'handoff', 'em_atendimento', 'Caso cancelled',  null, null),
        ('${DEM_SEGUNDA}',   '${ORG_A}', '${CONTATO_A}', '${CASO_SEGUNDA_TROCA}', 'handoff', 'em_atendimento', 'Segunda troca',   null, null),
        ('${DEM_ESCALADA}',  '${ORG_A}', '${CONTATO_A}', '${CASO_ESCALADO}',      'handoff', 'em_atendimento', 'Caso escalated',  null, null),
        ('${DEM_DA_ORG_A}',  '${ORG_A}', '${CONTATO_A}', '${CASO_DE_VIZINHA}',    'handoff', 'em_atendimento', 'Org A do caso',   null, null)
      on conflict do nothing;

    -- A ARMADEILHA do ponto 4: uma demanda de OUTRA organização apontando para
    -- o MESMO agent_case_id. Sem o filtro organization_id = new.organization_id
    -- o update do gatilho casaria as duas linhas e escreveria na da vizinha.
    insert into public.demandas
        (id, organization_id, contact_id, agent_case_id, origem, estado, assunto, proximo_passo, fechada_em)
      values
        ('${DEM_DA_ORG_B}', '${ORG_B}', '${CONTATO_B}', '${CASO_DE_VIZINHA}', 'handoff', 'em_atendimento', 'Org B do mesmo caso', null, null)
      on conflict do nothing;
  `);
});

describe("0505 — o gatilho do caso encerrado, medido no Postgres real", () => {
  it("0. o seed nasceu como a issue descreve: caso aberto, demanda sem passo e sem fecho", () => {
    expect(valor(DEM_RESOLVIDA, "proximo_passo")).toBe("<nulo>");
    expect(valor(DEM_RESOLVIDA, "estado")).toBe("em_atendimento");
    expect(valor(DEM_RESOLVIDA, "fechada_em")).toBe("<nulo>");
    expect(valor(DEM_DA_ORG_B, "agent_case_id")).toBe(CASO_DE_VIZINHA);
  });

  it("1a. resolved preenche o proximo_passo da demanda que o caso abriu, sem decidir o desfecho", () => {
    trocarStatus(CASO_RESOLVIDO, "awaiting_human", "resolved");

    expect(valor(DEM_RESOLVIDA, "proximo_passo")).toBe(FRASE_DO_GATILHO);
    // A metade que a doutrina proíbe: o sistema só garante o passo, nunca o fim.
    expect(valor(DEM_RESOLVIDA, "estado")).toBe("em_atendimento");
    expect(valor(DEM_RESOLVIDA, "desfecho")).toBe("<nulo>");
    expect(valor(DEM_RESOLVIDA, "fechada_em")).toBe("<nulo>");
  });

  it("1b. cancelled também preenche — são os DOIS terminais do WHEN, não só um", () => {
    trocarStatus(CASO_CANCELADO, "awaiting_human", "cancelled");

    expect(valor(DEM_CANCELADA, "proximo_passo")).toBe(FRASE_DO_GATILHO);
    expect(valor(DEM_CANCELADA, "desfecho")).toBe("<nulo>");
    expect(valor(DEM_CANCELADA, "fechada_em")).toBe("<nulo>");
  });

  it("2. a SEGUNDA mudança de status não reescreve um proximo_passo já preenchido", () => {
    trocarStatus(CASO_SEGUNDA_TROCA, "awaiting_human", "resolved");
    expect(valor(DEM_SEGUNDA, "proximo_passo")).toBe(FRASE_DO_GATILHO);

    // Uma pessoa assume o passo — é o estado do produto depois de "Marcar
    // próximo passo" no painel da conversa.
    sql(`update public.demandas set proximo_passo = '${PASSO_DE_PESSOA}' where id = '${DEM_SEGUNDA}';`);
    const revisionAntes = valor(DEM_SEGUNDA, "revision");
    expect(revisionAntes).not.toBe("<nulo>");

    // A troca de resolved → cancelled É mudança de status (o WHEN casa): o que
    // segura é a guarda `proximo_passo is null`, e só ela.
    trocarStatus(CASO_SEGUNDA_TROCA, "resolved", "cancelled");

    expect(valor(DEM_SEGUNDA, "proximo_passo")).toBe(PASSO_DE_PESSOA);
    // Zero linhas casadas = nem o bump de revision do trg_demanda_revision:
    // a revisão da demanda não sobe à toa quando ninguém tem o que corrigir.
    expect(valor(DEM_SEGUNDA, "revision")).toBe(revisionAntes);
    expect(valor(DEM_SEGUNDA, "fechada_em")).toBe("<nulo>");
  });

  it("3. escalated (status não terminal) não tem efeito algum na demanda", () => {
    trocarStatus(CASO_ESCALADO, "awaiting_human", "escalated");

    expect(valor(DEM_ESCALADA, "proximo_passo")).toBe("<nulo>");
    expect(valor(DEM_ESCALADA, "estado")).toBe("em_atendimento");
    expect(valor(DEM_ESCALADA, "fechada_em")).toBe("<nulo>");
  });

  it("4. demanda de OUTRA organização com o mesmo agent_case_id não é tocada", () => {
    trocarStatus(CASO_DE_VIZINHA, "awaiting_human", "resolved");

    // Controle positivo: a demanda DO CASO, na organização do caso, foi preenchida.
    expect(valor(DEM_DA_ORG_A, "proximo_passo")).toBe(FRASE_DO_GATILHO);
    // E a da vizinha — mesmo agent_case_id, outra organização — ficou intocada.
    expect(valor(DEM_DA_ORG_B, "proximo_passo")).toBe("<nulo>");
    expect(valor(DEM_DA_ORG_B, "estado")).toBe("em_atendimento");
    expect(valor(DEM_DA_ORG_B, "fechada_em")).toBe("<nulo>");
  });
});
