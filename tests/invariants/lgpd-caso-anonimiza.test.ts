/**
 * ANONIMIZAR UM CONTATO ALCANÇA O CASO QUE A IA ABRIU SOBRE ELE — migration 0280.
 *
 * ## O defeito
 *
 * Quando o atendimento automático trava, o motor abre um caso e escreve nele o
 * que entendeu do problema: `title`, `summary`, `blocker` e o recorte da
 * conversa que foi ao modelo (`context_snapshot`). A linha do tempo do caso
 * (`agent_case_events.body`) guarda o que a pessoa da equipe respondeu, a
 * demanda guarda o `assunto` do pedido, e a Central recebe um aviso cujo CORPO
 * embute o título do caso.
 *
 * `fn_lgpd_cascade_redact_contact` percorre uma lista escrita à mão, e nenhuma
 * dessas quatro tabelas estava nela. O modo de falha é o pior que existe para
 * obrigação legal: a rota devolve SUCESSO, a contagem por tabela fecha, o SLA de
 * D+15 é marcado como cumprido, e o relato sobre quem pediu para ser esquecido
 * continua legível. Nada erra, nada loga.
 *
 * ## As duas metades, e por que nenhuma basta sozinha
 *
 * Um teste que só provasse que o texto sumiu ficaria VERDE com um passo que
 * apagasse a linha inteira — e aí a organização perderia a resposta a "quantos
 * atendimentos pararam em março", que é registro de operação, não dado da
 * pessoa. Por isso cada caso de "o texto sumiu" anda colado de um caso de "e a
 * operação ficou de pé".
 *
 * ## O caso que nenhum outro pega: `updated_at`
 *
 * `agent_cases.updated_at` fica FORA do `set`. O cobrador de caso parado
 * (`app/api/v1/cron/case-stale-watcher/route.ts`) o lê como "alguém da equipe
 * encostou neste caso". Escrever ali faria a anonimização ADIAR a cobrança de um
 * caso que continua parado — e o efeito apareceria só como um cliente esperando
 * mais tempo. Nenhuma outra asserção deste arquivo pega isso.
 *
 * ## O vínculo do aviso tem TRÊS braços, e é medido, não suposto
 *
 * `agent_inbox_items` não tem FK: a referência é polimórfica. Medido nos
 * produtores, `handoff` nasce com `ref_kind='contact'`
 * (`lib/ai/handoff/orchestrator.ts`) E com `ref_kind='conversation'`
 * (`lib/agent-engine/agent/inbound-turn.ts`); `case_stale` nasce SEMPRE com
 * `ref_kind='agent_case'` (`app/api/v1/cron/case-stale-watcher/route.ts`, e a
 * política em `lib/ai/inbox-destino.ts`). Um predicado com dois braços casa ZERO
 * avisos de caso parado — e casar zero linha não é erro: é sucesso com o texto
 * intacto. Os três avisos semeados aqui cobrem um braço cada.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

// Namespace próprio (02800000-), pelo mesmo motivo de `caso-so-nasce-do-motor`:
// a semente é idempotente E não colide com a de outro arquivo rodando em
// paralelo no mesmo banco.
const ORG = "02800000-0000-4000-8000-000000000001";
const SESSAO = "02800000-1111-4000-8000-000000000001";
const ALVO = "02800000-2222-4000-8000-000000000001";
const VIZINHO = "02800000-2222-4000-8000-000000000002";
const CONVERSA_ALVO = "02800000-3333-4000-8000-000000000001";
const CONVERSA_VIZINHO = "02800000-3333-4000-8000-000000000002";
const CASO_ALVO = "02800000-4444-4000-8000-000000000001";
const CASO_VIZINHO = "02800000-4444-4000-8000-000000000002";
const EVENTO_ALVO = "02800000-5555-4000-8000-000000000001";
const EVENTO_VIZINHO = "02800000-5555-4000-8000-000000000002";
const DEMANDA_ALVO = "02800000-6666-4000-8000-000000000001";
const DEMANDA_VIZINHO = "02800000-6666-4000-8000-000000000002";
/** Um aviso por BRAÇO do predicado polimórfico. */
const AVISO_CONTATO = "02800000-7777-4000-8000-000000000001";
const AVISO_CONVERSA = "02800000-7777-4000-8000-000000000002";
const AVISO_CASO = "02800000-7777-4000-8000-000000000003";
const AVISO_VIZINHO = "02800000-7777-4000-8000-000000000004";

/** O nome que tem de sumir de toda parte. */
const NOME = "Marina Boaventura";
/**
 * O rótulo NÃO deriva mais do id (#2342): a cascata gera um sufixo OPACO no
 * passo 1 e o grava no contato, e cada passo seguinte reusa este MESMO valor —
 * é o que faz o rótulo servir de ponteiro de uma ponta a outra da cascata.
 * O teste lê o que o banco guardou, e a prova de que o defeito foi embora está
 * no teste do título: rótulo igual ao do contato, sem nenhum pedaço do id.
 */
function rotuloDoContato(): string {
  return valor(`select name from public.contacts where id = '${ALVO}';`);
}

/** Um valor escalar do psql (`-tA`), com nulo visível em vez de linha vazia. */
function valor(consulta: string): string {
  const saida = sql(consulta).trim();
  return saida.split("\n").at(-1) ?? "";
}

function campoDoCaso(caso: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.agent_cases where id = '${caso}';`,
  );
}

function campoDoEvento(evento: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.agent_case_events where id = '${evento}';`,
  );
}

function campoDaDemanda(demanda: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.demandas where id = '${demanda}';`,
  );
}

function campoDoAviso(aviso: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.agent_inbox_items where id = '${aviso}';`,
  );
}

/** Retrato do que estava legível ANTES da cascata. Lido uma vez, no `beforeAll`. */
interface Antes {
  titulo: string;
  resumo: string;
  bloqueio: string;
  snapshot: string;
  updatedAt: string;
  corpoDoEvento: string;
  metadataDoEvento: string;
  assunto: string;
  corpoDoAvisoDoCaso: string;
}
let antes: Antes;
/** O jsonb que a cascata devolveu — `{already_anonymized, counts, media_paths}`. */
let retorno: string;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-caso-0280', 'LGPD Caso 0280', 'LGPD Caso 0280')
      on conflict do nothing;
    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita, e o arbiter (id) não
    -- cobre a corrida no unique de waha_session_name entre arquivos paralelos.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'lgpd-caso-0280', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    insert into public.contacts (id, organization_id, name, display_name) values
      ('${ALVO}',    '${ORG}', '${NOME}', '${NOME}'),
      ('${VIZINHO}', '${ORG}', 'Joao Pereira', 'Joao Pereira')
      on conflict do nothing;
    -- Um contato por conversa: uniq_conversations_1to1_per_contact_session
    -- (migration 0027) admite UMA conversa 1:1 por (org, contato, sessão).
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_ALVO}',    '${ORG}', '${ALVO}',    '${SESSAO}', 'open'),
      ('${CONVERSA_VIZINHO}', '${ORG}', '${VIZINHO}', '${SESSAO}', 'open')
      on conflict do nothing;
    insert into public.agent_cases
        (id, organization_id, conversation_id, title, summary, blocker, context_snapshot, status)
      values
      ('${CASO_ALVO}', '${ORG}', '${CONVERSA_ALVO}',
       'Cobranca duplicada de ${NOME}',
       '${NOME} diz que o boleto de marco foi pago duas vezes e quer estorno.',
       'Falta o comprovante que ${NOME} prometeu enviar.',
       '{"ultima_mensagem":"aqui e a ${NOME}, paguei duas vezes"}'::jsonb, 'awaiting_human'),
      ('${CASO_VIZINHO}', '${ORG}', '${CONVERSA_VIZINHO}',
       'Troca de tamanho do Joao', 'Joao quer trocar o tamanho.', 'Falta o numero do pedido.',
       '{"ultima_mensagem":"aqui e o Joao"}'::jsonb, 'awaiting_human')
      on conflict do nothing;
    insert into public.agent_case_events
        (id, organization_id, case_id, kind, actor_kind, human_action, body, metadata)
      values
      ('${EVENTO_ALVO}', '${ORG}', '${CASO_ALVO}', 'human_replied', 'human', 'need_lead_info',
       'Liguei para ${NOME} no numero dela e pedi o comprovante.',
       '{"trecho":"${NOME} respondeu que envia amanha"}'::jsonb),
      ('${EVENTO_VIZINHO}', '${ORG}', '${CASO_VIZINHO}', 'human_replied', 'human', 'need_lead_info',
       'Pedi o numero do pedido ao Joao.', '{"trecho":"Joao respondeu"}'::jsonb)
      on conflict do nothing;
    insert into public.demandas (id, organization_id, contact_id, agent_case_id, origem, assunto, estado)
      values
      ('${DEMANDA_ALVO}', '${ORG}', '${ALVO}', '${CASO_ALVO}', 'handoff',
       'Estorno da cobranca duplicada de ${NOME}', 'em_atendimento'),
      ('${DEMANDA_VIZINHO}', '${ORG}', '${VIZINHO}', '${CASO_VIZINHO}', 'handoff',
       'Troca de tamanho do Joao', 'em_atendimento')
      on conflict do nothing;
    -- UM AVISO POR BRAÇO do predicado polimórfico — os três braços são medidos
    -- nos produtores, não supostos (ver o cabeçalho deste arquivo).
    insert into public.agent_inbox_items
        (id, organization_id, kind, severity, title, body, ref_kind, ref_id, status)
      values
      ('${AVISO_CONTATO}', '${ORG}', 'handoff', 'critical',
       'Atendimento automatico parou — assumir a conversa',
       'Motivo: ${NOME} pediu falar com uma pessoa.', 'contact', '${ALVO}', 'open'),
      ('${AVISO_CONVERSA}', '${ORG}', 'handoff', 'critical',
       'Lead com sinal de urgencia represado pelo cap de envio do numero',
       'Mensagem de ${NOME} parece relatar risco.', 'conversation', '${CONVERSA_ALVO}', 'open'),
      ('${AVISO_CASO}', '${ORG}', 'case_stale', 'warn',
       'Um atendimento espera decisao ha mais de um dia',
       '"Cobranca duplicada de ${NOME}" esta aguardando alguem da equipe.',
       'agent_case', '${CASO_ALVO}', 'open'),
      ('${AVISO_VIZINHO}', '${ORG}', 'case_stale', 'warn',
       'Um atendimento espera decisao ha mais de um dia',
       '"Troca de tamanho do Joao" esta aguardando alguem da equipe.',
       'agent_case', '${CASO_VIZINHO}', 'open')
      on conflict do nothing;
  `);

  // BANCO SUJO É ESCOPO IMPLÍCITO: numa segunda rodada contra o MESMO container,
  // o contato já está anonimizado, a cascata devolve `already_anonymized` e o
  // retrato "antes" sai anonimizado — todo caso de "o texto estava legível"
  // falharia com uma mensagem que não fala de defeito nenhum. A guarda diz o que
  // houve, em vez de deixar o leitor adivinhar.
  const jaAnonimo = valor(`select is_anonymized from public.contacts where id = '${ALVO}';`);
  if (jaAnonimo !== "f") {
    throw new Error(
      `o contato da semente já está anonimizado (is_anonymized=${jaAnonimo}) — este arquivo ` +
        "precisa de um banco recém-aplicado. Rode `pnpm test:db`, que sobe container novo.",
    );
  }

  antes = {
    titulo: campoDoCaso(CASO_ALVO, "title"),
    resumo: campoDoCaso(CASO_ALVO, "summary"),
    bloqueio: campoDoCaso(CASO_ALVO, "blocker"),
    snapshot: campoDoCaso(CASO_ALVO, "context_snapshot"),
    updatedAt: campoDoCaso(CASO_ALVO, "updated_at"),
    corpoDoEvento: campoDoEvento(EVENTO_ALVO, "body"),
    metadataDoEvento: campoDoEvento(EVENTO_ALVO, "metadata"),
    assunto: campoDaDemanda(DEMANDA_ALVO, "assunto"),
    corpoDoAvisoDoCaso: campoDoAviso(AVISO_CASO, "body"),
  };

  // A FUNÇÃO REAL, não um `update is_anonymized` à mão: o atalho seria barrado
  // pela constraint `contacts_anonymized_locked` e, pior, provaria um caminho
  // que a produção nunca percorre.
  retorno = valor(
    `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`,
  );
});

describe("0280 — a cascata de LGPD alcança o caso que a IA abriu", () => {
  it("CONTROLE: antes da cascata, o nome estava legível nas quatro tabelas", () => {
    // Sem este caso, uma semente que não entrou faria todo `is null` abaixo
    // passar sobre tabela vazia — verde por vacuidade, que é o modo de falha que
    // este repo já pagou várias vezes.
    expect(antes.titulo).toContain(NOME);
    expect(antes.resumo).toContain(NOME);
    expect(antes.bloqueio).toContain(NOME);
    expect(antes.snapshot).toContain(NOME);
    expect(antes.corpoDoEvento).toContain(NOME);
    expect(antes.metadataDoEvento).toContain(NOME);
    expect(antes.assunto).toContain(NOME);
    expect(antes.corpoDoAvisoDoCaso).toContain(NOME);
  });

  it("a cascata CONTOU as quatro tabelas novas — e não devolveu `already_anonymized`", () => {
    // A contagem por tabela é o que a rota audita em `lgpd.redact_executed`.
    // Passo que não existe não aparece no `counts`: a chave ausente é a prova de
    // que o passo saiu, independente do que as tabelas mostrem.
    expect(retorno, "a cascata devolveu vazio — a sonda não leu o retorno").not.toBe("");
    const contagens = JSON.parse(retorno) as {
      already_anonymized: boolean;
      counts: Record<string, number>;
    };
    expect(contagens.already_anonymized).toBe(false);
    for (const tabela of ["agent_cases", "agent_case_events", "demandas", "agent_inbox_items"]) {
      expect(contagens.counts[tabela], `a cascata não contou \`${tabela}\``).toBeGreaterThan(0);
    }
  });

  it("o título do caso vira o rótulo do titular", () => {
    expect(campoDoCaso(CASO_ALVO, "title")).toBe(rotuloDoContato());
  });

  it("o resumo e o bloqueio viram os textos fixos", () => {
    // `summary` e `blocker` são NOT NULL: recebem texto fixo, nunca `null`.
    expect(campoDoCaso(CASO_ALVO, "summary")).toBe("[resumo anonimizado]");
    expect(campoDoCaso(CASO_ALVO, "blocker")).toBe("[bloqueio anonimizado]");
  });

  it("o contexto que foi ao modelo vira `{}`", () => {
    // O snapshot guarda o recorte da conversa E o `service_boundary` que o
    // trigger de borda anexa no INSERT — e aquele carrega o `contact_id`.
    expect(campoDoCaso(CASO_ALVO, "context_snapshot")).toBe("{}");
  });

  it("o `updated_at` do caso NÃO é tocado — a cascata não é alguém encostando", () => {
    // NENHUMA outra asserção deste arquivo pega isto. O cobrador de caso parado
    // lê `updated_at` como toque humano: escrevê-lo aqui faria a anonimização
    // adiar a cobrança de um caso que continua parado.
    expect(campoDoCaso(CASO_ALVO, "updated_at")).toBe(antes.updatedAt);
  });

  it("o corpo e o metadata do evento do caso somem", () => {
    expect(campoDoEvento(EVENTO_ALVO, "body")).toBe("<null>");
    expect(campoDoEvento(EVENTO_ALVO, "metadata")).toBe("{}");
  });

  it("...e o que é OPERAÇÃO fica de pé: estado, abertura, conversa e quem tocou", () => {
    // Um passo que apagasse a linha inteira deixaria os casos acima verdes e
    // tiraria da organização a resposta a "quantos atendimentos pararam em
    // março" — e a métrica de toque humano sai daqui.
    expect(campoDoCaso(CASO_ALVO, "status")).toBe("awaiting_human");
    expect(campoDoCaso(CASO_ALVO, "conversation_id")).toBe(CONVERSA_ALVO);
    expect(campoDoCaso(CASO_ALVO, "opened_at")).not.toBe("<null>");
    expect(campoDoEvento(EVENTO_ALVO, "kind")).toBe("human_replied");
    expect(campoDoEvento(EVENTO_ALVO, "actor_kind")).toBe("human");
    expect(campoDoEvento(EVENTO_ALVO, "human_action")).toBe("need_lead_info");
    expect(campoDoEvento(EVENTO_ALVO, "created_at")).not.toBe("<null>");
  });

  it("o assunto da demanda é apagado, e a operação dela fica", () => {
    expect(campoDaDemanda(DEMANDA_ALVO, "assunto")).toBe("<null>");
    expect(campoDaDemanda(DEMANDA_ALVO, "estado")).toBe("em_atendimento");
    expect(campoDaDemanda(DEMANDA_ALVO, "origem")).toBe("handoff");
    expect(campoDaDemanda(DEMANDA_ALVO, "agent_case_id")).toBe(CASO_ALVO);
  });

  it.each([
    ["contact", AVISO_CONTATO],
    ["conversation", AVISO_CONVERSA],
    ["agent_case", AVISO_CASO],
  ])(
    "o aviso ligado por `ref_kind=%s` é resolvido, com corpo fixo e sem referência",
    (braco, aviso) => {
      expect(campoDoAviso(aviso, "status"), `o aviso de \`${braco}\` seguiu aberto`).toBe(
        "resolved",
      );
      expect(campoDoAviso(aviso, "body")).toBe("Contato anonimizado.");
      expect(campoDoAviso(aviso, "ref_id")).toBe("<null>");
      expect(campoDoAviso(aviso, "resolved_at")).not.toBe("<null>");
    },
  );

  it("o caso, o evento e a demanda do VIZINHO não são tocados", () => {
    // Controle negativo: uma cascata sem o filtro de conversa/contato apagaria o
    // banco inteiro e deixaria todos os casos acima verdes.
    expect(campoDoCaso(CASO_VIZINHO, "title")).toContain("Joao");
    expect(campoDoEvento(EVENTO_VIZINHO, "body")).toContain("Joao");
    expect(campoDaDemanda(DEMANDA_VIZINHO, "assunto")).toContain("Joao");
  });

  it("o aviso do VIZINHO segue aberto e com a referência de pé", () => {
    expect(campoDoAviso(AVISO_VIZINHO, "status")).toBe("open");
    expect(campoDoAviso(AVISO_VIZINHO, "ref_id")).toBe(CASO_VIZINHO);
  });

  it("rodar de novo é no-op — `already_anonymized` e nada muda", () => {
    const segunda = valor(
      `select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`,
    );
    expect((JSON.parse(segunda) as { already_anonymized: boolean }).already_anonymized).toBe(true);
    // `resolved_at = now()` no passo dos avisos só é idempotente por causa do
    // retorno antecipado — se alguém tirar o `if v_already`, este caso reprova.
    expect(campoDoCaso(CASO_ALVO, "title")).toBe(rotuloDoContato());
    expect(campoDoCaso(CASO_ALVO, "updated_at")).toBe(antes.updatedAt);
  });
});
