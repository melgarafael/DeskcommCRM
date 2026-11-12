/**
 * #4312 — A TRANSFERÊNCIA LEVA O QUE ANDA JUNTO: O NEGÓCIO, O NÚMERO E O FIO.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * Três defeitos na MESMA operação, com `visibility_mode = own` e dois números
 * com política de responsáveis (#3642):
 *
 *   1. o NEGÓCIO aberto não acompanhava quando quem transfere é `agent` dono do
 *      card: o portão da 9208 exige `fn_can_view_lead` sobre o responsável
 *      ATUAL e sobre o NOVO, e em `own` o destino não é visível a quem
 *      transfere. A escrita era pulada em silêncio e o card ficava com quem
 *      saiu — sem aviso nenhum na tela;
 *   2. a conversa DEVOLVIDA não voltava ao número de origem: `fn_numero_da_
 *      transferencia` devolvia nulo quando o destino já responde pelo número
 *      atual, e a conversa ficava no número do colega enquanto o cliente
 *      continuava escrevendo no número de origem;
 *   3. o diálogo de Transferir não sabia (nem mostrava) as outras conversas do
 *      mesmo contato.
 *
 * ─── O que este arquivo prova (Postgres real, `pnpm test:db`) ───────────────
 *
 * O caminho do dono: o card vai junto. O caminho de quem NÃO é dono: o card
 * fica com a outra pessoa E a prévia que o diálogo consome diz isso, com o nome
 * de quem fica — nunca os dois silêncios. A devolução volta ao número da última
 * entrada do cliente, e os dois lados opostos que a regra não pode quebrar: a
 * última entrada no número ATUAL não move a conversa, e a transferência comum
 * continua escolhendo o número do destino pela regra da 9039.
 *
 * O item 3 (a lista no diálogo) não tem prova aqui: é tela, e o gate dele é
 * `tests/unit/transferir-lista-de-conversas-do-contato.test.tsx`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "eeeeeeee-0000-4000-8000-000000000001";

const A = "eeeeeeee-1111-4000-8000-000000000001"; // atendente dono do card
const B = "eeeeeeee-1111-4000-8000-000000000002"; // atendente que recebe
const ADMIN = "eeeeeeee-1111-4000-8000-000000000003"; // responde por X e por Y
const L = "eeeeeeee-1111-4000-8000-000000000004"; // responde só por Y

/** Os números. X é o de origem; Y é o do colega; Z é o número próprio de B. */
const S_X = "eeeeeeee-2222-4000-8000-000000000001";
const S_Y = "eeeeeeee-2222-4000-8000-000000000002";
const S_Z = "eeeeeeee-2222-4000-8000-000000000003";
const P_X = "eeeeeeee-7777-4000-8000-000000000001";
const P_Y = "eeeeeeee-7777-4000-8000-000000000002";

const PIPELINE = "eeeeeeee-5555-4000-8000-000000000001";
const ETAPA = "eeeeeeee-5555-4000-8000-000000000002";

/** Um contato por caso: um caso não contamina o outro (1 conversa por par). */
const CT = {
  dono: "eeeeeeee-3333-4000-8000-000000000001",
  naoDono: "eeeeeeee-3333-4000-8000-000000000002",
  devolucao: "eeeeeeee-3333-4000-8000-000000000003",
  entradaAtual: "eeeeeeee-3333-4000-8000-000000000004",
  primeiroNumero: "eeeeeeee-3333-4000-8000-000000000005",
  semNegocio: "eeeeeeee-3333-4000-8000-000000000006",
} as const;

const CONV = {
  dono: "eeeeeeee-4444-4000-8000-000000000001",
  naoDono: "eeeeeeee-4444-4000-8000-000000000002",
  devolucao: "eeeeeeee-4444-4000-8000-000000000003",
  entradaAtual: "eeeeeeee-4444-4000-8000-000000000004",
  primeiroNumero: "eeeeeeee-4444-4000-8000-000000000005",
  semNegocio: "eeeeeeee-4444-4000-8000-000000000006",
} as const;

const NEG = {
  dono: "eeeeeeee-6666-4000-8000-000000000001",
  doAdmin: "eeeeeeee-6666-4000-8000-000000000002",
} as const;

function donoDaConversa(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'SEM_DONO') from public.conversations where id = '${conversa}';`),
  );
}

function numeroDaConversa(conversa: string): string {
  return lastLine(sql(`select channel_session_id::text from public.conversations where id = '${conversa}';`));
}

function donoDoNegocio(negocio: string): string {
  return lastLine(
    sql(`select coalesce(owner_user_id::text, 'SEM_DONO') from public.crm_leads where id = '${negocio}';`),
  );
}

/**
 * O número que a transferência ESCOLHE, pela mesma função que a rota consulta.
 *
 * Como a ROTA faz: `fn_numero_da_transferencia` é chamada pelo ADMIN client
 * (`app/api/v1/conversations/[id]/transfer/route.ts`), e o EXECUTE dela é só do
 * `service_role` desde a 9039 — a sessão de pessoa não a alcança. Medir por
 * `authenticated` provaria uma permissão que o produto não usa e esconderia o
 * veredito atrás de `permission denied`.
 */
function numeroDaTransferencia(conversa: string, para: string): string {
  return lastLine(
    sql(`set role service_role;
      select coalesce(public.fn_numero_da_transferencia('${ORG}', '${conversa}', '${para}')::text, 'FICA');`),
  );
}

/**
 * A prévia que o diálogo de Transferir consome: `tem_negocio|leva|dono`.
 *
 * Chamada como a ROTA faz — sessão de pessoa (o `auth.uid()` decide a
 * permissão), e não service role: a prévia existe justamente para dizer, a quem
 * NÃO é dono, que o negócio fica com outra pessoa.
 */
function previaDoNegocio(como: string | null, conversa: string, para: string): string {
  const sessao =
    como === null
      ? "set role service_role;"
      : `set role authenticated;\n select set_config('request.jwt.claims', '{"sub":"${como}"}', false);`;
  return lastLine(
    sql(`${sessao}
      select coalesce(tem_negocio::text, 'SEM_LINHA') || '|' || coalesce(leva::text, '-') || '|'
             || coalesce(dono_user_id::text, 'SEM_DONO')
        from public.fn_previa_do_negocio_na_transferencia('${ORG}', '${conversa}', '${para}');`),
  );
}

/** A chamada da rota de transferência (sessão de pessoa), com a assinatura de 6. */
function atribui(p: { como: string | null; conversa: string; para: string }): void {
  const sessao =
    p.como === null
      ? "set role service_role;"
      : `set role authenticated;\n select set_config('request.jwt.claims', '{"sub":"${p.como}"}', false);`;
  sql(`${sessao}
    select public.fn_conversation_assign('${ORG}', '${p.conversa}', '${p.para}', 'transfer', null, false);`);
}

function conversaNova(id: string, contato: string, dono: string | null, sessao: string): void {
  sql(`
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
    values ('${id}', '${ORG}', '${contato}', '${sessao}', '${dono ? "claimed" : "open"}',
            ${dono ? `'${dono}'` : "null"}, ${dono ? "now()" : "null"});
  `);
}

function mensagem(p: {
  id: string;
  conversa: string;
  contato: string;
  sessao: string;
  direcao: "inbound" | "outbound";
  quando: string;
}): void {
  sql(`
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body,
       sent_at, created_at)
    values ('${p.id}', '${ORG}', '${p.conversa}', '${p.sessao}', '${p.contato}', 'text', '${p.direcao}',
            'probe #4312', ${p.quando}, ${p.quando});
  `);
}

function negocioNovo(id: string, contato: string, dono: string | null): void {
  sql(`
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, contact_id, status, owner_user_id, owner_kind)
    values ('${id}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'Negócio do caso #4312', '${contato}', 'open',
            ${dono ? `'${dono}'` : "null"}, ${dono ? "'user'" : "null"});
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${A}', 'transferencia-a@invariant.test'),
      ('${B}', 'transferencia-b@invariant.test'),
      ('${ADMIN}', 'transferencia-admin@invariant.test'),
      ('${L}', 'transferencia-l@invariant.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG}', 'transferencia-leva-inv', 'Transferencia Leva Inv', 'Transferencia Leva',
       '{"visibility_mode":"own"}'::jsonb)
    on conflict (id) do nothing;

    update public.organizations
       set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"own"}'::jsonb
     where id = '${ORG}';

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${A}', '${ORG}', 'agent', now()),
      ('${B}', '${ORG}', 'agent', now()),
      ('${ADMIN}', '${ORG}', 'admin', now()),
      ('${L}', '${ORG}', 'agent', now())
    on conflict (user_id, organization_id) do update
      set role = excluded.role, revoked_at = null, accepted_at = now();

    insert into public.channel_sessions
      (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status,
       phone_number, display_name)
    values
      ('${S_X}', '${ORG}', 'waha', 'transferencia-numero-x', '\\x00'::bytea, 'WORKING', '+5511900000001', 'Numero X'),
      ('${S_Y}', '${ORG}', 'waha', 'transferencia-numero-y', '\\x00'::bytea, 'WORKING', '+5511900000002', 'Numero Y'),
      ('${S_Z}', '${ORG}', 'waha', 'transferencia-numero-z', '\\x00'::bytea, 'WORKING', '+5511900000003', 'Numero Z')
    on conflict (id) do update
      set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

    insert into public.channel_routing_policies (id, organization_id, channel_session_id) values
      ('${P_X}', '${ORG}', '${S_X}'),
      ('${P_Y}', '${ORG}', '${S_Y}')
    on conflict (id) do nothing;

    -- X: o admin e a atendente A. Y: a atendente L e TAMBÉM o admin — é o que
    -- faz a devolução ser um caso de número compartilhado.
    insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
      ('${ORG}', '${P_X}', '${ADMIN}'),
      ('${ORG}', '${P_X}', '${A}'),
      ('${ORG}', '${P_Y}', '${L}'),
      ('${ORG}', '${P_Y}', '${ADMIN}')
    on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG}', 'Transferencia Leva Inv', 'transferencia-leva-inv')
    on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Novo', 'novo-transferencia-leva', 1000)
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CT.dono}', '${ORG}', 'Contato Dono', '+5511911110001'),
      ('${CT.naoDono}', '${ORG}', 'Contato Nao Dono', '+5511911110002'),
      ('${CT.devolucao}', '${ORG}', 'Contato Devolucao', '+5511911110003'),
      ('${CT.entradaAtual}', '${ORG}', 'Contato Entrada Atual', '+5511911110004'),
      ('${CT.primeiroNumero}', '${ORG}', 'Contato Primeiro Numero', '+5511911110005'),
      ('${CT.semNegocio}', '${ORG}', 'Contato Sem Negocio', '+5511911110006')
    on conflict (id) do nothing;
  `);

  // Caso 1 — A é dona da conversa E do card; transfere para B em `own`.
  conversaNova(CONV.dono, CT.dono, A, S_X);
  negocioNovo(NEG.dono, CT.dono, A);

  // Caso 2 — A transfere, mas o card é do ADMIN: a regra de permissão continua
  // valendo, e a prévia é quem conta isso ao diálogo.
  conversaNova(CONV.naoDono, CT.naoDono, A, S_X);
  negocioNovo(NEG.doAdmin, CT.naoDono, ADMIN);

  // Caso 3 — a devolução: a conversa NASCEU em X (o cliente falou por último
  // ali) e depois foi transferida para Y, o número da atendente L. A mensagem é
  // gravada antes da mudança porque o gatilho de serviço exige a sessão de
  // origem coerente com a conversa — é o histórico que a transferência deixa.
  conversaNova(CONV.devolucao, CT.devolucao, null, S_X);
  mensagem({
    id: "eeeeeeee-8888-4000-8000-000000000001",
    conversa: CONV.devolucao,
    contato: CT.devolucao,
    sessao: S_X,
    direcao: "inbound",
    quando: "now() - interval '2 hours'",
  });
  sql(`
    update public.conversations
       set channel_session_id = '${S_Y}', assigned_to_user_id = '${L}', assigned_at = now(),
           status = 'claimed'
     where id = '${CONV.devolucao}';
  `);
  mensagem({
    id: "eeeeeeee-8888-4000-8000-000000000002",
    conversa: CONV.devolucao,
    contato: CT.devolucao,
    sessao: S_Y,
    direcao: "outbound",
    quando: "now() - interval '1 hour'",
  });

  // Caso 4 (lado oposto) — a última entrada do cliente é no número ATUAL.
  conversaNova(CONV.entradaAtual, CT.entradaAtual, L, S_Y);
  mensagem({
    id: "eeeeeeee-8888-4000-8000-000000000003",
    conversa: CONV.entradaAtual,
    contato: CT.entradaAtual,
    sessao: S_Y,
    direcao: "inbound",
    quando: "now() - interval '30 minutes'",
  });

  // Caso 5 (lado oposto) — transferência comum: o destino tem número próprio,
  // e a última entrada do cliente é num número de que ele não é responsável.
  conversaNova(CONV.primeiroNumero, CT.primeiroNumero, A, S_X);
  mensagem({
    id: "eeeeeeee-8888-4000-8000-000000000004",
    conversa: CONV.primeiroNumero,
    contato: CT.primeiroNumero,
    sessao: S_X,
    direcao: "inbound",
    quando: "now() - interval '10 minutes'",
  });
  sql(`
    insert into public.channel_routing_policies (id, organization_id, channel_session_id)
    values ('eeeeeeee-7777-4000-8000-000000000003', '${ORG}', '${S_Z}')
    on conflict (id) do nothing;
    insert into public.channel_routing_responsibles (organization_id, policy_id, user_id)
    values ('${ORG}', 'eeeeeeee-7777-4000-8000-000000000003', '${B}')
    on conflict do nothing;
  `);

  // Caso 6 (lado oposto) — contato SEM negócio aberto: a prévia não inventa card.
  conversaNova(CONV.semNegocio, CT.semNegocio, A, S_X);
});

afterAll(() => {
  sql(`
    delete from public.event_log where organization_id = '${ORG}';
    delete from public.conversation_assignment_events where organization_id = '${ORG}';
    delete from public.messages where organization_id = '${ORG}';
    delete from public.conversations where organization_id = '${ORG}';
    delete from public.crm_leads where organization_id = '${ORG}';
    delete from public.channel_routing_responsibles where organization_id = '${ORG}';
    delete from public.channel_routing_policies where organization_id = '${ORG}';
    delete from public.channel_sessions where organization_id = '${ORG}';
    delete from public.crm_stages where organization_id = '${ORG}';
    delete from public.crm_pipelines where organization_id = '${ORG}';
    delete from public.contacts where organization_id = '${ORG}';
    delete from public.user_organizations where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    delete from auth.users where id in ('${A}', '${B}', '${ADMIN}', '${L}');
  `);
});

describe("#4312 — a transferência leva o que anda junto", () => {
  it("defeito 1, o caminho escolhido: o DONO do card transfere em `own` e o negócio vai junto", () => {
    expect(donoDaConversa(CONV.dono)).toBe(A);
    expect(donoDoNegocio(NEG.dono)).toBe(A);
    // A prévia do diálogo, ANTES da troca: o negócio acompanha.
    expect(previaDoNegocio(A, CONV.dono, B)).toBe(`true|true|${A}`);

    atribui({ como: A, conversa: CONV.dono, para: B });

    const evento = lastLine(
      sql(`select from_user_id::text || '>' || to_user_id::text
             from public.conversation_assignment_events
            where conversation_id = '${CONV.dono}' and reason = 'transfer'
            order by created_at desc limit 1;`),
    );
    expect(evento).toBe(`${A}>${B}`);
    expect(donoDaConversa(CONV.dono)).toBe(B);
    // O defeito da issue: aqui o card ficava com A.
    expect(donoDoNegocio(NEG.dono)).toBe(B);
  });

  it("defeito 1, o outro caminho: quem NÃO é dono não leva o card — e a prévia diz com quem ele fica", () => {
    expect(donoDoNegocio(NEG.doAdmin)).toBe(ADMIN);
    // `leva = false` e o dono NOMEADO: é o que o diálogo usa para avisar que o
    // negócio continua com outra pessoa (nunca o silêncio).
    expect(previaDoNegocio(A, CONV.naoDono, B)).toBe(`true|false|${ADMIN}`);

    atribui({ como: A, conversa: CONV.naoDono, para: B });

    expect(donoDaConversa(CONV.naoDono)).toBe(B);
    expect(donoDoNegocio(NEG.doAdmin)).toBe(ADMIN);
  });

  it("defeito 2: devolver a conversa escolhe o número da última entrada do cliente, não o do colega", () => {
    expect(numeroDaConversa(CONV.devolucao)).toBe(S_Y);
    expect(numeroDaTransferencia(CONV.devolucao, ADMIN)).toBe(S_X);

    atribui({ como: L, conversa: CONV.devolucao, para: ADMIN });

    expect(donoDaConversa(CONV.devolucao)).toBe(ADMIN);
    // O cliente falou por último em X: a conversa volta para X.
    expect(numeroDaConversa(CONV.devolucao)).toBe(S_X);
  });

  it("lado oposto: com a última entrada no número ATUAL, a conversa não muda de número", () => {
    expect(numeroDaTransferencia(CONV.entradaAtual, ADMIN)).toBe("FICA");

    atribui({ como: L, conversa: CONV.entradaAtual, para: ADMIN });

    expect(donoDaConversa(CONV.entradaAtual)).toBe(ADMIN);
    expect(numeroDaConversa(CONV.entradaAtual)).toBe(S_Y);
  });

  it("lado oposto: a transferência comum continua escolhendo o número do destino (regra da 9039)", () => {
    expect(numeroDaTransferencia(CONV.primeiroNumero, B)).toBe(S_Z);

    atribui({ como: A, conversa: CONV.primeiroNumero, para: B });

    expect(donoDaConversa(CONV.primeiroNumero)).toBe(B);
    expect(numeroDaConversa(CONV.primeiroNumero)).toBe(S_Z);
  });

  it("a prévia não inventa negócio para contato sem card aberto", () => {
    expect(previaDoNegocio(A, CONV.semNegocio, B)).toBe("false|false|SEM_DONO");
  });
});
