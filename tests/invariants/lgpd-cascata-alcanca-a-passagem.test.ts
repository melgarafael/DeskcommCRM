/**
 * ANONIMIZAR UM CONTATO APAGA O BRIEFING DA PASSAGEM DELE — migration 0291.
 *
 * ## Prova de COMPORTAMENTO, não de símbolo
 *
 * Três gates já cobram esta tabela, e nenhum mede o que este arquivo mede:
 *
 *   · `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` a alcança SOZINHO (ela
 *     tem FK para `contacts` e as colunas `title`/`body`/`notes`/`content`) —
 *     mas mede que o passo EXISTE;
 *   · `cascata-lgpd-nao-encolhe.test.ts` guarda o NOME dela na lista;
 *   · `lgpd-exporta-o-que-redige.test.ts` cobra o bloco pareado no export.
 *
 * Um `update` com o predicado errado casa zero linhas, a função devolve SUCESSO,
 * a contagem por tabela fecha em zero e o SLA de D+15 é marcado como cumprido —
 * com o texto legível. Os três gates acima ficam verdes nesse cenário. Aqui a
 * cascata REAL roda contra uma semente REAL, e o que se mede é o depois.
 *
 * ## Por que `body` recebe o RÓTULO e não `null`
 *
 * `body` é `not null`: anulá-lo aborta o cascade INTEIRO, e cascade abortado não
 * anonimiza NADA. É a lição que `contacts.email_normalized` já custou uma vez
 * neste repo, e o molde é o de `voice_calls.peer_phone`.
 *
 * ## Por que existe um VIZINHO na semente
 *
 * Um passo com o predicado largo demais (sem `contact_id`, ou sem
 * `organization_id`) apagaria o briefing sobre OUTRAS pessoas e ficaria verde em
 * todos os casos de "o texto do titular sumiu". O vizinho é o que distingue
 * "apagou o certo" de "apagou".
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

// Namespace próprio, distinto do de `passagem-isolamento-e-visibilidade.test.ts`:
// aquele arquivo AFIRMA que a linha dele é legível, e este anonimiza a sua.
// Compartilhar contato faria um derrubar o outro conforme a ordem da suíte.
const ORG = "02910001-0000-4000-8000-000000000001";
const SESSAO = "02910001-2222-4000-8000-000000000001";
const ALVO = "02910001-3333-4000-8000-000000000001";
const VIZINHO = "02910001-3333-4000-8000-000000000002";
const CONVERSA_ALVO = "02910001-4444-4000-8000-000000000001";
const CONVERSA_VIZINHO = "02910001-4444-4000-8000-000000000002";
const PASSAGEM_ALVO = "02910001-7777-4000-8000-000000000001";
const PASSAGEM_VIZINHO = "02910001-7777-4000-8000-000000000002";

const TITULO = "Fulano de Tal quer cancelar o plano";
const CORPO = "Por que a IA passou: O cliente pediu para falar com uma pessoa. Fulano ja tinha ligado.";
const CITACAO = "quero falar com um humano agora, ja pedi isso pro Fulano ontem";
const ESCRITO = "o Fulano ficou bravo comigo";

/** A última linha da saída do psql, que é o valor da última consulta. */
function valor(consulta: string): string {
  return sql(consulta).trim().split("\n").at(-1) ?? "";
}

function campo(passagemId: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.passagens_de_atendimento
      where organization_id = '${ORG}' and id = '${passagemId}';`,
  );
}

let antes: { title: string; body: string; notes: string; vizinho: string };
let retorno: string;
let rotulo: string;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'passagem-0291-lgpd', 'Passagem 0291 LGPD', 'Passagem 0291 LGPD')
      on conflict do nothing;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'passagem-0291-lgpd', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${ALVO}',    '${ORG}', 'Fulano de Tal'),
      ('${VIZINHO}', '${ORG}', 'Beltrano Vizinho')
      on conflict do nothing;
    -- Um contato por conversa: uniq_conversations_1to1_per_contact_session
    -- admite UMA conversa 1:1 por (org, contato, sessão).
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_ALVO}',    '${ORG}', '${ALVO}',    '${SESSAO}', 'open'),
      ('${CONVERSA_VIZINHO}', '${ORG}', '${VIZINHO}', '${SESSAO}', 'open')
      on conflict do nothing;
    -- last_handoff_reason preenchido de propósito: ele é o motivo CRU que
    -- sobrevivia na conversa depois da anonimização, e o passo 2 da cascata
    -- passa a zerá-lo (migration 0291).
    -- (sem crase nesta prosa: o bloco inteiro é um template literal de JS.)
    update public.conversations set last_handoff_reason = 'requested_human'
      where organization_id = '${ORG}' and id in ('${CONVERSA_ALVO}', '${CONVERSA_VIZINHO}');

    insert into public.passagens_de_atendimento
        (id, organization_id, contact_id, conversation_id, motor, origem, motivo_codigo,
         title, body, notes, content, tentativas, cliente_avisado, aviso_motivo_codigo)
      select * from (values
        ('${PASSAGEM_ALVO}'::uuid, '${ORG}'::uuid, '${ALVO}'::uuid, '${CONVERSA_ALVO}'::uuid,
         'engine', 'ferramenta_do_modelo', 'requested_human',
         '${TITULO}', '${CORPO}', '${CITACAO}', '${ESCRITO}',
         '[{"o_que":"expliquei a cobranca do Fulano"}]'::jsonb, false, 'falhou_no_envio'),
        ('${PASSAGEM_VIZINHO}'::uuid, '${ORG}'::uuid, '${VIZINHO}'::uuid, '${CONVERSA_VIZINHO}'::uuid,
         'crm', 'sentimento', 'low_sentiment',
         'O briefing do vizinho continua legivel', 'O briefing do vizinho continua legivel',
         'palavras do vizinho', 'escrito sobre o vizinho',
         '[{"o_que":"tentei com o vizinho"}]'::jsonb, true, null)
      ) as s(id, organization_id, contact_id, conversation_id, motor, origem, motivo_codigo,
             title, body, notes, content, tentativas, cliente_avisado, aviso_motivo_codigo)
       where not exists (select 1 from public.passagens_de_atendimento
                          where organization_id = '${ORG}' and id = '${PASSAGEM_ALVO}');
  `);

  // GUARDA DE BANCO SUJO. Numa segunda rodada contra o MESMO container, o
  // retrato "antes" já sai anonimizado e todo caso de "o texto estava legível"
  // falharia com uma mensagem que não fala de defeito nenhum.
  const jaAnonimo = valor(`select is_anonymized from public.contacts where id = '${ALVO}';`);
  if (jaAnonimo !== "f") {
    throw new Error(
      `o contato da semente já está anonimizado (is_anonymized=${jaAnonimo}) — este arquivo ` +
        "precisa de um banco recém-aplicado. Rode `pnpm test:db`, que sobe container novo.",
    );
  }

  antes = {
    title: campo(PASSAGEM_ALVO, "title"),
    body: campo(PASSAGEM_ALVO, "body"),
    notes: campo(PASSAGEM_ALVO, "notes"),
    vizinho: campo(PASSAGEM_VIZINHO, "body"),
  };

  // A FUNÇÃO REAL, não um `update is_anonymized` à mão: o atalho seria barrado
  // pela constraint `contacts_anonymized_locked` e, pior, provaria um caminho
  // que a produção nunca percorre.
  retorno = valor(
    `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`,
  );
  // O rótulo NÃO é mais `substring(id, 1, 8)` (#2342): a cascata gera um sufixo
  // OPACO e grava no contato no passo 1 — só se sabe o valor lendo a linha. O
  // teste captura o que o banco guardou; a prova de que o defeito foi embora
  // está no teste de `body`, logo abaixo.
  rotulo = valor(`select name from public.contacts where id = '${ALVO}';`);
});

describe("0291 — a cascata de LGPD alcança a passagem para humano", () => {
  it("CONTROLE DE VACUIDADE: o texto estava legível ANTES", () => {
    // Sem isto, uma semente que não entrou faria "o corpo virou o rótulo" passar
    // sobre uma linha inexistente — verde por não haver o que apagar.
    expect(antes.title).toBe(TITULO);
    expect(antes.body).toBe(CORPO);
    expect(antes.notes).toBe(CITACAO);
    expect(antes.vizinho).toContain("vizinho continua legivel");
  });

  it("a cascata CONTOU a tabela no `counts` que vai para a auditoria", () => {
    // Passo que não existe não aparece no `counts`: a chave ausente é a prova de
    // que o passo sumiu, e esse jsonb é o que entra no metadata de
    // `lgpd.redact_executed` — a linha que responde ao titular.
    const contagens = JSON.parse(retorno) as {
      already_anonymized: boolean;
      counts: Record<string, number>;
    };
    expect(contagens.already_anonymized).toBe(false);
    expect(
      contagens.counts.passagens_de_atendimento,
      "a cascata não contou `passagens_de_atendimento` — o passo saiu da função",
    ).toBe(1);
  });

  it("`body` recebe o RÓTULO — nunca `null`, porque a coluna é obrigatória", () => {
    // Anular uma coluna `not null` aborta o cascade inteiro, e um cascade
    // abortado não anonimiza NADA: o modo de falha é a rota devolver erro e o
    // dado continuar legível em todas as tabelas, não só nesta.
    expect(campo(PASSAGEM_ALVO, "body")).toBe(rotulo);
    // O rótulo tem o MESMO formato de antes (é ele que `lib/escalacao/texto-do-aviso.ts`
    // reconhece), mas NÃO leva mais nenhum pedaço do id — com o sufixo no id,
    // quem tem o banco casava o rótulo com a linha `contacts` e reidentificava
    // o titular olhando (issue #2342; RGPD considerando 26, LGPD art. 12).
    expect(rotulo).toMatch(/^Cliente Anonimizado #[0-9a-f]{8}$/);
    expect(rotulo, "o rótulo ainda deriva do id do contato").not.toBe(
      `Cliente Anonimizado #${ALVO.slice(0, 8)}`,
    );
  });

  it("`title`, `notes` e `content` viram null, e `tentativas` esvazia", () => {
    expect(campo(PASSAGEM_ALVO, "title")).toBe("<null>");
    expect(campo(PASSAGEM_ALVO, "notes"), "a citação literal do cliente sobreviveu").toBe("<null>");
    expect(campo(PASSAGEM_ALVO, "content")).toBe("<null>");
    expect(campo(PASSAGEM_ALVO, "tentativas")).toBe("[]");
  });

  it("a OPERAÇÃO fica de pé — o que se apaga é o texto", () => {
    // Apagar a linha ficaria verde nos casos acima e tiraria da organização a
    // resposta a "quantos atendimentos a IA devolveu em março, e quanto tempo as
    // pessoas esperaram". Motor, origem, motivo e o par do aviso são operação.
    expect(campo(PASSAGEM_ALVO, "motor")).toBe("engine");
    expect(campo(PASSAGEM_ALVO, "origem")).toBe("ferramenta_do_modelo");
    expect(campo(PASSAGEM_ALVO, "motivo_codigo")).toBe("requested_human");
    // `campo()` concatena com texto, e a concatenação converte booleano por
    // TEXT: sai `false`, não o `f` de uma coluna booleana impressa pelo psql.
    expect(campo(PASSAGEM_ALVO, "cliente_avisado")).toBe("false");
    expect(campo(PASSAGEM_ALVO, "aviso_motivo_codigo")).toBe("falhou_no_envio");
    expect(campo(PASSAGEM_ALVO, "criado_em")).not.toBe("<null>");
  });

  it("o motivo CRU na conversa também é zerado (`last_handoff_reason`)", () => {
    // Ele é código de vocabulário, não texto livre — mas diz que ESTA pessoa foi
    // escalada por irritação, por assunto jurídico ou por suspeita de opt-out. O
    // passo entra no `update conversations` que já existia, com o mesmo
    // predicado: mesmas linhas, metade das varreduras.
    expect(
      valor(`select coalesce(last_handoff_reason, '<null>') from public.conversations
              where organization_id = '${ORG}' and id = '${CONVERSA_ALVO}';`),
    ).toBe("<null>");
    // E a do vizinho NÃO: o predicado recorta pelo titular.
    expect(
      valor(`select coalesce(last_handoff_reason, '<null>') from public.conversations
              where organization_id = '${ORG}' and id = '${CONVERSA_VIZINHO}';`),
    ).toBe("requested_human");
  });

  it("o VIZINHO não é tocado — o predicado recorta pelo titular", () => {
    expect(campo(PASSAGEM_VIZINHO, "body")).toContain("vizinho continua legivel");
    expect(campo(PASSAGEM_VIZINHO, "notes")).toBe("palavras do vizinho");
    expect(campo(PASSAGEM_VIZINHO, "tentativas")).toContain("tentei com o vizinho");
  });

  it("rodar de novo é NO-OP: o texto continua apagado e nada estoura", () => {
    // O cron diário chama a função outra vez para contato já anonimizado
    // (`varrerRedacoesIncompletas`). Um passo que dependesse do valor anterior —
    // ou que anulasse `body` — quebraria só na SEGUNDA rodada, que é a que
    // ninguém testa à mão.
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    expect(campo(PASSAGEM_ALVO, "body")).toBe(rotulo);
    expect(campo(PASSAGEM_ALVO, "title")).toBe("<null>");
  });
});
