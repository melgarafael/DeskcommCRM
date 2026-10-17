/**
 * O RÓTULO DE ANONIMIZADO DEIXA DE DERIVAR DO ID, E O `external_id` DO TITULAR SAI DAS
 * MENSAGENS QUE FICAM — issue #2342.
 *
 * ─── O que a triagem mediu ─────────────────────────────────────────────────────────────────
 *
 * O passo 1 da cascata gravava o rótulo assim:
 *
 *   v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);
 *
 * Os oito primeiros caracteres do UUID do contato. O contato continua com o MESMO id depois da
 * anonimização, então qualquer pessoa com o banco fazia `select id, name from contacts` e via a
 * parelinha: o rótulo ERA o id, encurtado. Não é anonimização, é pseudonimização — e dado
 * pseudonimizado continua sendo dado pessoal (RGPD considerando 26; LGPD art. 12 e art. 13 §4).
 *
 * O passo 3 redigia corpo, mídia e metadata de `messages`, mas deixava `external_id` de pé — e
 * a coluna guarda o TELEFONE do titular. A linha que SOBRA da anonimização era, portanto, a
 * última PII viva do pedido de exclusão: sem nome, sem fala, sem mídia… e com o número de quem
 * pediu para ser esquecido.
 *
 * ─── Por que o sufixo é aleatório e não hash-com-sal ────────────────────────────────────────
 *
 * Hash com sal parece o remédio e não é: quem tem o banco tem também o sal, e aí basta
 * recalcular o hash de cada `contacts.id` para reencontrar a linha. O sufixo tem de NÃO SER
 * FUNÇÃO do id — 32 bits de aleatoriedade, gerados uma vez. Nada no banco permite ir do rótulo
 * de volta ao titular.
 *
 * ─── O que este arquivo mede no banco (não no texto) ────────────────────────────────────────
 *
 *   1. o rótulo guardado NÃO é o id encurtado, e mantém o formato antigo (`…#[0-9a-f]{8}`),
 *      que é o prefixo que `lib/escalacao/texto-do-aviso.ts` usa para não cortar o rótulo;
 *   2. o MESMO rótulo aparece no contato e no caso da IA — a igualdade é o que faz o rótulo
 *      servir de ponteiro, e ela só sobrevive se o gatilho de seções reusar o valor gravado
 *      no passo 1 em vez de gerar outro. `messages` fica fora: o passo 3 redige o corpo para
 *      texto fixo (item 3), e a mensagem que sobra não leva rótulo nenhum;
 *   3. `messages.external_id` fica NULO, e a linha RESTA — `status` e `conversation_id`
 *      intactos, corpo virando texto fixo. Zerar a coluna não pode custar a linha.
 *   4. o contato de OUTRA organização com o MESMO telefone não é alcançado — o braço que casa
 *      por telefone é por organização, e zerar `external_id` não mudou isso;
 *   5. rodar de novo é no-op E o rótulo não muda (o valor reusado é o do contato).
 *
 * A semente é idempotente e usa o namespace `06570000-`, que não é de nenhum outro arquivo —
 * eles rodam em paralelo no mesmo banco.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG = "06570000-0000-4000-8000-000000000001";
const SESSAO = "06570000-1111-4000-8000-000000000001";
const ALVO = "06570000-2222-4000-8000-000000000001";
const VIZINHO = "06570000-2222-4000-8000-000000000002";
const CONVERSA_ALVO = "06570000-3333-4000-8000-000000000001";
const CONVERSA_VIZINHO = "06570000-3333-4000-8000-000000000002";
const CASO_ALVO = "06570000-4444-4000-8000-000000000001";
const MENSAGEM_ALVO = "06570000-5555-4000-8000-000000000001";
const MENSAGEM_VIZINHO = "06570000-5555-4000-8000-000000000002";
/** Outra organização, com o MESMO telefone do titular: o braço do telefone é por organização. */
const ORG_DE_FORA = "06570000-9999-4000-8000-000000000001";
const SESSAO_DE_FORA = "06570000-9999-4000-8000-000000000002";
const CONTATO_DE_FORA = "06570000-9999-4000-8000-000000000003";
const CONVERSA_DE_FORA = "06570000-9999-4000-8000-000000000004";
const MENSAGEM_DE_FORA = "06570000-9999-4000-8000-000000000005";

const NOME = "Beatriz Camargo";
const TEL = "+5511988887777";
/** O rótulo QUE O DEFEITO PRODUZIA — é ele que o teste prova ausente. */
const ROTULO_QUE_DERIVA_DO_ID = `Cliente Anonimizado #${ALVO.slice(0, 8)}`;

/** Um valor escalar do psql (`-tA`), com nulo visível em vez de linha vazia. */
function valor(consulta: string): string {
  const saida = sql(consulta).trim();
  return saida.split("\n").at(-1) ?? "";
}

function campo(consulta: string): string {
  return valor(`select coalesce((${consulta})::text, '<null>')`);
}

function rotulo(): string {
  return valor(`select name from public.contacts where id = '${ALVO}';`);
}

/** Retrato do que estava legível ANTES da cascata. Lido uma vez, no `beforeAll`. */
interface Antes {
  rotuloDoContato: string;
  corpoDaMensagem: string;
  externalIdDaMensagem: string;
  tituloDoCaso: string;
}
let antes: Antes;
/** O jsonb que a cascata devolveu — `{already_anonymized, counts, media_paths}`. */
let retorno: string;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values
        ('${ORG}', 'lgpd-0657', 'LGPD 0657', 'LGPD 0657'),
        ('${ORG_DE_FORA}', 'lgpd-0657-fora', 'LGPD 0657 Fora', 'LGPD 0657 Fora')
      on conflict do nothing;
    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values
          ('${SESSAO}', '${ORG}', 'lgpd-0657', '\\x00'::bytea),
          ('${SESSAO_DE_FORA}', '${ORG_DE_FORA}', 'lgpd-0657-fora', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    insert into public.contacts (id, organization_id, name, display_name, email, phone_number) values
      ('${ALVO}',          '${ORG}',         '${NOME}', '${NOME}', 'bea@exemplo.test', '${TEL}'),
      ('${VIZINHO}',       '${ORG}',         'Joao Pereira', 'Joao Pereira', null, '+5511911112222'),
      ('${CONTATO_DE_FORA}','${ORG_DE_FORA}', '${NOME}', '${NOME}', null, '${TEL}')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_ALVO}',    '${ORG}',         '${ALVO}',          '${SESSAO}',       'open'),
      ('${CONVERSA_VIZINHO}', '${ORG}',         '${VIZINHO}',       '${SESSAO}',       'open'),
      ('${CONVERSA_DE_FORA}', '${ORG_DE_FORA}', '${CONTATO_DE_FORA}','${SESSAO_DE_FORA}','open')
      on conflict do nothing;
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker, status)
      values
        ('${CASO_ALVO}', '${ORG}', '${CONVERSA_ALVO}',
         'Cobranca duplicada de ${NOME}',
         '${NOME} diz que o boleto foi pago duas vezes.',
         'pagamento em duplicidade pedido revisao humana', 'awaiting_human')
      on conflict do nothing;
    -- \`external_id\` é o TELEFONE no inbound e o id do provider no outbound. Os dois
    -- braços entram: a medição é da coluna, não de um lado dela.
    insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, body, external_id, sent_at)
      values
        ('${MENSAGEM_ALVO}', '${ORG}', '${CONVERSA_ALVO}', '${SESSAO}', '${ALVO}',
         'text', 'inbound', 'received', 'ai', 'oi, eu sou a ${NOME}', '${TEL}', '2026-09-01T10:00:00Z'),
        ('${MENSAGEM_VIZINHO}', '${ORG}', '${CONVERSA_VIZINHO}', '${SESSAO}', '${VIZINHO}',
         'text', 'inbound', 'received', 'ai', 'vizinho continua legivel', '+5511911112222', '2026-09-01T11:00:00Z'),
        ('${MENSAGEM_DE_FORA}', '${ORG_DE_FORA}', '${CONVERSA_DE_FORA}', '${SESSAO_DE_FORA}', '${CONTATO_DE_FORA}',
         'text', 'inbound', 'received', 'ai', 'a ${NOME} de outra org', '${TEL}', '2026-09-01T12:00:00Z')
      on conflict (id) do nothing;
  `);

  antes = {
    rotuloDoContato: valor(`select name from public.contacts where id = '${ALVO}';`),
    corpoDaMensagem: campo(
      `select body from public.messages where id = '${MENSAGEM_ALVO}'`,
    ),
    externalIdDaMensagem: campo(
      `select external_id from public.messages where id = '${MENSAGEM_ALVO}'`,
    ),
    tituloDoCaso: campo(`select title from public.agent_cases where id = '${CASO_ALVO}'`),
  };

  retorno = valor(
    `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`,
  );
});

describe("o rótulo de anonimizado é opaco e o external_id sai das mensagens (#2342)", () => {
  it("CONTROLE DE VACUIDADE: antes da cascata, o contato, o caso e o external_id estavam legíveis", () => {
    expect(antes.rotuloDoContato).toBe(NOME);
    expect(antes.corpoDaMensagem).toContain(NOME);
    expect(antes.externalIdDaMensagem).toBe(TEL);
    expect(antes.tituloDoCaso).toContain(NOME);
    expect(retorno, "a cascata devolveu vazio — a sonda não leu o retorno").not.toBe("");
  });

  it("o rótulo tem o formato antigo, e NENHUM pedaço do id", () => {
    // O formato é contrato de tela: `lib/escalacao/texto-do-aviso.ts` reconhece o prefixo
    // para não cortar o rótulo no primeiro token, e o regex de 8 hex casava com o sufixo
    // novo também. MUDAR O FORMATO seria mudar a tela; mudar a ORIGEM é o conserto.
    expect(rotulo()).toMatch(/^Cliente Anonimizado #[0-9a-f]{8}$/);
    expect(rotulo(), "o rótulo ainda é o id do contato encurtado").not.toBe(ROTULO_QUE_DERIVA_DO_ID);
  });

  it("o mesmo rótulo está no contato e no caso da IA — o ponteiro continua fechado", () => {
    // `messages` fica FORA da comparação de propósito: o passo 3 redige o corpo para texto
    // fixo (`[mensagem anonimizada]` é o item seguinte), e as tabelas que reusam o rótulo
    // são as que escrevem DEPOIS do passo 1 — aqui o caso da IA é a segunda face do ponteiro.
    expect(campo(`select title from public.agent_cases where id = '${CASO_ALVO}'`)).toBe(rotulo());
  });

  it("`messages.external_id` saiu, e a linha RESTA com status e conversação intactos", () => {
    // Zerar a coluna não pode custar a linha: o pedido de exclusão manda o que SOBRA ficar
    // como registro de operação. `status` e `conversation_id` são os dois campos que
    // qualquer tela de conversa usa para reagrupar as mensagens que sobraram.
    expect(campo(`select external_id from public.messages where id = '${MENSAGEM_ALVO}'`)).toBe(
      "<null>",
    );
    expect(campo(`select body from public.messages where id = '${MENSAGEM_ALVO}'`)).toBe(
      "[mensagem anonimizada]",
    );
    expect(campo(`select status from public.messages where id = '${MENSAGEM_ALVO}'`)).toBe(
      "received",
    );
    expect(campo(`select conversation_id from public.messages where id = '${MENSAGEM_ALVO}'`)).toBe(
      CONVERSA_ALVO,
    );
    expect(campo(`select direction from public.messages where id = '${MENSAGEM_ALVO}'`)).toBe(
      "inbound",
    );
  });

  it("o contato de OUTRA organização com o MESMO telefone não foi alcançado", () => {
    // O braço que casa por telefone é por organização (0119, passo 1): zerar
    // `external_id` não mudou o alcance. Uma cross-org aqui seria vazamento no
    // outro sentido — anonimizar quem não pediu nada.
    expect(campo(`select name from public.contacts where id = '${CONTATO_DE_FORA}'`)).toBe(NOME);
    expect(campo(`select external_id from public.messages where id = '${MENSAGEM_DE_FORA}'`)).toBe(
      TEL,
    );
    expect(campo(`select body from public.messages where id = '${MENSAGEM_DE_FORA}'`)).toContain(
      NOME,
    );
  });

  it("o vizinho da mesma organização continua de pé", () => {
    expect(campo(`select name from public.contacts where id = '${VIZINHO}'`)).toBe("Joao Pereira");
    expect(campo(`select external_id from public.messages where id = '${MENSAGEM_VIZINHO}'`)).toBe(
      "+5511911112222",
    );
    expect(campo(`select body from public.messages where id = '${MENSAGEM_VIZINHO}'`)).toBe(
      "vizinho continua legivel",
    );
  });

  it("rodar de novo é no-op — e o rótulo NÃO muda", () => {
    const rotuloAntes = rotulo();
    const segunda = valor(
      `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`,
    );
    expect((JSON.parse(segunda) as { already_anonymized: boolean }).already_anonymized).toBe(true);
    // Se cada escritor gerasse um token novo, a segunda rodada trocaria o rótulo do contato
    // e o ponteiro (contato ↔ caso ↔ mensagem) quebraria no meio do caminho.
    expect(rotulo()).toBe(rotuloAntes);
    expect(campo(`select title from public.agent_cases where id = '${CASO_ALVO}'`)).toBe(rotuloAntes);
  });

  it("dois contatos anonimizados não dividem rótulo", () => {
    // A aleatoriedade é por anonimização, não por contato fixo: se o sufixo fosse uma
    // constante (ou um hash de algo compartilhado), dois titulares diferentes sairiam com
    // o MESMO rótulo e a tela voltaria a ser um campo que não distingue ninguém.
    sql(`
      insert into public.contacts (id, organization_id, name, display_name)
        values ('06570000-2222-4000-8000-000000000009', '${ORG}', 'Outro Titular', 'Outro Titular')
        on conflict do nothing;
      select public.fn_lgpd_cascade_redact_contact(
        '${ORG}', '06570000-2222-4000-8000-000000000009', gen_random_uuid());
    `);
    const segundo = valor(
      `select name from public.contacts where id = '06570000-2222-4000-8000-000000000009';`,
    );
    expect(segundo).toMatch(/^Cliente Anonimizado #[0-9a-f]{8}$/);
    expect(segundo, "dois titulares diferentes saíram com o mesmo rótulo").not.toBe(rotulo());
  });
});
