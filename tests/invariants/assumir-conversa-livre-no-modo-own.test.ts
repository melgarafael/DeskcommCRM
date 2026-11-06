import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * #3479 — no modo "Só os seus", o Atendente que cadastra um contato novo não
 * consegue iniciar a conversa.
 *
 * ═══ O defeito, como a instalação o viu ═══
 *
 * Com `visibility_mode = 'own'`, o Atendente cadastra o contato com telefone, a
 * tela chama "Iniciar conversa" e ouve **"A conversa neste número está com
 * outro atendente"** — sobre uma conversa que não tem dono nenhum. O Inbox não
 * a mostra, e o contorno é um gerente transferi-la à mão.
 *
 * ═══ A causa, e onde ela mora ═══
 *
 * Três peças verdadeiras que juntas produzem a mentira:
 *
 *   1. `fn_service_begin` (o INSERT que nasce do cadastro do contato e de
 *      `open-with-contact`) cria a conversa com `assigned_to_user_id` NULO;
 *   2. em `own`, `fn_can_view_conversation(org, null)` responde "não vejo" — é
 *      o que mantém a fila sem dono fora do Inbox de quem só quer os seus
 *      (decisão da 0035), e está certo;
 *   3. a guarda da 0685 no WHERE de `fn_conversation_assign` faz conversa fora
 *      da visibilidade de quem chama responder como INEXISTENTE (zero linhas) —
 *      e o `claim` é exatamente a operação que daria dono à conversa.
 *
 * A dependência circular: a conversa só fica visível depois de assumida, e só
 * era assumível se visível. A rota `claim` traduz as zero linhas em 409, e a
 * tela traduz o 409 em "está com outro atendente".
 *
 * ═══ O que este arquivo vigia ═══
 *
 * O caso 1 é o vermelho da issue: assumir conversa SEM dono no modo `own`. Os
 * casos 2 a 6 são os CONTROLES — a exceção da 0776 tem de ser estreita, e cada
 * um deles é uma porta que ela NÃO pode abrir: conversa de colega, transferência
 * para terceiro, release, organização alheia e o caminho do service role.
 *
 * Sem o caso 1 este arquivo fica verde sobre o produto quebrado; sem os
 * controles, ele fica verde sobre um produto que entrega conversa de colega a
 * quem não a enxerga. Os dois lados são o teste.
 */

const ORG = "b3479000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b3479000-0000-4000-8000-000000000002";
const AGENTE_A = "b3479000-1111-4000-8000-000000000001";
const AGENTE_B = "b3479000-1111-4000-8000-000000000002";
const GESTOR = "b3479000-1111-4000-8000-000000000003";
const SESSAO = "b3479000-2222-4000-8000-000000000001";
const SESSAO_OUTRA = "b3479000-2222-4000-8000-000000000002";
/** Um contato por conversa: `uniq_conversations_1to1_per_contact_session` (0027). */
const CONTATO_LIVRE = "b3479000-3333-4000-8000-000000000001";
const CONTATO_DO_COLEGA = "b3479000-3333-4000-8000-000000000002";
const CONTATO_DE_OUTRA_ORG = "b3479000-3333-4000-8000-000000000003";
/** Conversa livre que nenhum caso assume: palco dos controles NEGATIVOS. */
const CONTATO_DE_CONTROLE = "b3479000-3333-4000-8000-000000000004";

/** Conversa que nasceu do cadastro do contato: criada por `fn_service_begin`. */
let CONVERSA_LIVRE = "";
let CONVERSA_DO_COLEGA = "";
let CONVERSA_OUTRA_ORG = "";
let CONVERSA_DE_CONTROLE = "";

function idDe(scriptDoServiceBegin: string): string {
  const saida = sql(`
    set role service_role;
    ${scriptDoServiceBegin};
  `);
  return (JSON.parse(lastLine(saida)) as { conversation_id: string }).conversation_id;
}

/** `fn_conversation_assign` como o usuário, com os claims que a rota usa. */
function assignComo(userId: string, args: string, conversaId: string): number {
  return countAs(
    userId,
    `select count(*) from public.fn_conversation_assign(
       '${ORG}'::uuid, '${conversaId}'::uuid, ${args})`,
  );
}

function donoDe(conversaId: string): string {
  return sql(
    `select coalesce(assigned_to_user_id::text, 'NULL') from public.conversations where id = '${conversaId}';`,
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE_A}', 'assumir3479-a@invariant.test'),
      ('${AGENTE_B}', 'assumir3479-b@invariant.test'),
      ('${GESTOR}', 'assumir3479-g@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'assumir-3479', 'Assumir 3479', 'Assumir 3479',
              jsonb_build_object('visibility_mode', 'own')),
             ('${OUTRA_ORG}', 'assumir-3479-b', 'Assumir 3479 B', 'Assumir 3479 B',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${AGENTE_A}', '${ORG}', 'agent', now()),
             ('${AGENTE_B}', '${ORG}', 'agent', now()),
             ('${GESTOR}', '${ORG}', 'manager', now()),
             ('${AGENTE_A}', '${OUTRA_ORG}', 'agent', now())
      on conflict do nothing;

    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'assumir-3479', '\\x00'::bytea),
               ('${SESSAO_OUTRA}', '${OUTRA_ORG}', 'assumir-3479-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;

    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO_LIVRE}', '${ORG}', 'Contato Novo 3479', '+5511999993471'),
             ('${CONTATO_DO_COLEGA}', '${ORG}', 'Contato do Colega 3479', '+5511999993472'),
             ('${CONTATO_DE_OUTRA_ORG}', '${OUTRA_ORG}', 'Contato Outra Org 3479', '+5511999993473'),
             ('${CONTATO_DE_CONTROLE}', '${ORG}', 'Contato de Controle 3479', '+5511999993474')
      on conflict do nothing;
  `);

  // O caminho REAL do defeito: a conversa nasce do `fn_service_begin`, que é o
  // INSERT de `contacts.create` e de `open-with-contact`. Escrever a conversa
  // com um `insert` daqui deixaria de fora a peça 1 da causa — e um teste que
  // fabrica o dado com o valor que ele quer medir não mede nada.
  CONVERSA_LIVRE = idDe(
    `select public.fn_service_begin('${ORG}'::uuid, '${CONTATO_LIVRE}'::uuid, '${SESSAO}'::uuid)`,
  );
  CONVERSA_DO_COLEGA = idDe(
    `select public.fn_service_begin('${ORG}'::uuid, '${CONTATO_DO_COLEGA}'::uuid, '${SESSAO}'::uuid)`,
  );
  CONVERSA_OUTRA_ORG = idDe(
    `select public.fn_service_begin('${OUTRA_ORG}'::uuid, '${CONTATO_DE_OUTRA_ORG}'::uuid, '${SESSAO_OUTRA}'::uuid)`,
  );
  CONVERSA_DE_CONTROLE = idDe(
    `select public.fn_service_begin('${ORG}'::uuid, '${CONTATO_DE_CONTROLE}'::uuid, '${SESSAO}'::uuid)`,
  );

  // O colega é dono da conversa dele (o caso que a 0685 protege).
  sql(`update public.conversations
          set assigned_to_user_id = '${AGENTE_B}', assignee_kind = 'user',
              status = 'claimed', assigned_at = now()
        where id = '${CONVERSA_DO_COLEGA}';`);
});

describe("#3479 — assumir conversa sem dono no modo \"Só os seus\"", () => {
  it("controle: a conversa do cadastro nasce SEM dono (a peça 1 da causa)", () => {
    expect(donoDe(CONVERSA_LIVRE)).toBe("NULL");
    expect(donoDe(CONVERSA_OUTRA_ORG)).toBe("NULL");
  });

  it("controle: o modo 'Só os seus' continua escondendo a conversa sem dono do Atendente", () => {
    // O escopo da LEITURA não muda nesta issue — só a assinatura. Se este caso
    // ficar vermelho, alguém abriu a fila sem dono no Inbox de quem só quer os
    // seus, que é o contrato do modo (0035) e não o que a #3479 pede.
    expect(countAs(AGENTE_A, `select count(*) from public.conversations where id = '${CONVERSA_LIVRE}'`)).toBe(0);
  });

  it("⭐ o Atendente ASSUME a conversa sem dono, e passa a vê-la (o vermelho da issue)", () => {
    expect(assignComo(AGENTE_A, `'${AGENTE_A}'::uuid, 'claim', null, true`, CONVERSA_LIVRE)).toBe(1);
    expect(donoDe(CONVERSA_LIVRE)).toBe(AGENTE_A);
    // A assinatura é o que faz a tela abrir: a mesma leitura que respondia 0
    // agora devolve a linha.
    expect(countAs(AGENTE_A, `select count(*) from public.conversations where id = '${CONVERSA_LIVRE}'`)).toBe(1);
  });

  it("o Atendente NÃO assume a conversa do colega (a guarda da 0685 segue de pé)", () => {
    expect(assignComo(AGENTE_A, `'${AGENTE_A}'::uuid, 'claim', null, true`, CONVERSA_DO_COLEGA)).toBe(0);
    expect(donoDe(CONVERSA_DO_COLEGA)).toBe(AGENTE_B);
    expect(countAs(AGENTE_A, `select count(*) from public.conversations where id = '${CONVERSA_DO_COLEGA}'`)).toBe(0);
  });

  it("a exceção não vira TRANSFERÊNCIA: dono novo de terceiro continua zero linhas", () => {
    // A conversa de controle está SEM dono. O que a 0776 permite é assumi-la
    // PARA SI; dar a mesma conversa a outra pessoa continua sendo operação de
    // quem enxerga a conversa (e o Atendente em `own` não a enxerga).
    expect(donoDe(CONVERSA_DE_CONTROLE)).toBe("NULL");
    expect(assignComo(AGENTE_A, `'${AGENTE_B}'::uuid, 'transfer'`, CONVERSA_DE_CONTROLE)).toBe(0);
    expect(donoDe(CONVERSA_DE_CONTROLE)).toBe("NULL");
  });

  it("a exceção não vira RELEASE: soltar continua exigindo enxergar a conversa", () => {
    expect(assignComo(AGENTE_A, `null, 'release'`, CONVERSA_DE_CONTROLE)).toBe(0);
    expect(assignComo(AGENTE_A, `null, 'release'`, CONVERSA_DO_COLEGA)).toBe(0);
    expect(donoDe(CONVERSA_DO_COLEGA)).toBe(AGENTE_B);
  });

  it("organização alheia continua fora: o filtro de organization_id não afrouxou", () => {
    expect(assignComo(AGENTE_A, `'${AGENTE_A}'::uuid, 'claim', null, true`, CONVERSA_OUTRA_ORG)).toBe(0);
    expect(donoDe(CONVERSA_OUTRA_ORG)).toBe("NULL");
  });

  it("controle: o service role (worker, roteamento) assume conversa livre como antes", () => {
    // Independente do caso ⭐: a conversa é DEIXADA sem dono aqui, de propósito.
    // Um controle que herdasse o dono do caso anterior mediria aquele caso de
    // novo — e, com o fix revertido, ficaria vermelho pelo motivo errado.
    const livre = idDe(
      `select public.fn_service_begin('${ORG}'::uuid, '${CONTATO_LIVRE}'::uuid, '${SESSAO}'::uuid)`,
    );
    sql(`update public.conversations set assigned_to_user_id = null, assignee_kind = null,
                assigned_at = null, status = 'open' where id = '${livre}';`);
    expect(donoDe(livre)).toBe("NULL");
    const linhas = sql(
      `select count(*) from public.fn_conversation_assign(
         '${ORG}'::uuid, '${livre}'::uuid, '${GESTOR}'::uuid, 'claim', null, true);`,
    );
    expect(linhas).toBe("1");
    expect(donoDe(livre)).toBe(GESTOR);
  });

  it("o gestor assume a mesma conversa livre (papel amplo não regrediu)", () => {
    const livre = idDe(
      `select public.fn_service_begin('${ORG}'::uuid, '${CONTATO_LIVRE}'::uuid, '${SESSAO}'::uuid)`,
    );
    sql(`update public.conversations set assigned_to_user_id = null, assignee_kind = null,
                assigned_at = null, status = 'open' where id = '${livre}';`);
    expect(assignComo(GESTOR, `'${GESTOR}'::uuid, 'claim', null, true`, livre)).toBe(1);
    expect(donoDe(livre)).toBe(GESTOR);
  });
});
