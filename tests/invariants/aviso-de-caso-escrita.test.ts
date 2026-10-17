/**
 * QUEM CONFIGURA O AVISO DE CASO, E QUEM LÊ O QUE — migration 0292.
 *
 * ## Por que este arquivo existe
 *
 * As duas tabelas ficam FORA de `rls-isolation.test.ts` (que semeia um usuário
 * `agent` e provaria o eixo errado: a policy de `config_aviso_de_caso` exige
 * `admin`, e a de `entregas_de_aviso_de_caso` exige `manager` — o controle
 * positivo falharia por ACERTO). Elas entram em `PROVA_PROPRIA` da varredura de
 * completude citando ESTE arquivo, e é ele que precisa provar os três eixos:
 *
 *   · TENANT — a organização A não lê a linha da B;
 *   · PAPEL  — dentro da MESMA organização, `agent` e `viewer` não leem a
 *     configuração; `viewer` não lê o histórico;
 *   · ESCRITA — `authenticated` não escreve em NENHUMA das duas, em papel
 *     nenhum. A única porta é `fn_definir_aviso_de_caso`.
 *
 * ## O que a configuração guarda, e por que o papel é `admin`
 *
 * O telefone de um funcionário e o vínculo com uma conexão de WhatsApp. Quem
 * troca esse número redireciona TODO aviso de atendimento da empresa — e, pior,
 * faz o número novo virar INTERNO: a partir daí tudo o que vier dele deixa de
 * virar contato, conversa e atendimento. Um `agent` que pudesse escrever ali
 * calaria um cliente com um UPDATE.
 *
 * O HISTÓRICO é `manager` porque a pergunta que ele responde — "o aviso está
 * saindo?" — é de quem opera o atendimento, e a linha não guarda texto nenhum
 * (só um resumo criptográfico) nem expõe o número para a tela.
 *
 * ## B4 — apagar a conexão NÃO pode falhar
 *
 * O caso mais fácil de errar deste schema, e o mais caro: um
 * `check (ligado = false or channel_session_id is not null)` seria a expressão
 * natural de "ligado sem canal nunca dispara", e ABORTARIA o DELETE da conexão —
 * `on delete set null` é um UPDATE, o CHECK é reavaliado na linha resultante e
 * viola. A rota de exclusão de canal devolveria 500 com mensagem de constraint,
 * sem nenhuma pista de que a causa está em outra tela. Aqui se mede o desfecho
 * certo: o DELETE passa, e a configuração fica desligada sozinha.
 *
 * ## Sabotagens previstas (§4.11 do plano)
 *
 *   · `grant insert on public.config_aviso_de_caso to authenticated` → só os
 *     casos de ESCRITA ficam vermelhos; os de leitura seguem verdes, e é essa
 *     separação que prova que os eixos são medidos por casos diferentes;
 *   · trocar `fn_role_at_least(organization_id,'admin')` por `'agent'` na policy
 *     da configuração → vermelho SÓ no caso do `agent`; o do vizinho e o do
 *     `viewer` do histórico seguem verdes;
 *   · acrescentar `check (ligado = false or channel_session_id is not null)` →
 *     vermelho SÓ no caso B4, com `23514` no DELETE da conexão.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (02920000-), como nos invariantes das ondas anteriores.
const ORG_A = "02920000-0000-4000-8000-000000000001";
const ORG_B = "02920000-0000-4000-8000-000000000002";
const ADMIN_A = "02920000-1111-4000-8000-000000000001";
const GESTOR_A = "02920000-1111-4000-8000-000000000002";
const ATENDENTE_A = "02920000-1111-4000-8000-000000000003";
const LEITOR_A = "02920000-1111-4000-8000-000000000004";
const ADMIN_B = "02920000-1111-4000-8000-000000000005";
const SESSAO_A = "02920000-2222-4000-8000-000000000001";
const SESSAO_B = "02920000-2222-4000-8000-000000000002";
/** Canal descartável: é ele que o caso B4 apaga. */
const SESSAO_DESCARTAVEL = "02920000-2222-4000-8000-000000000003";
const CONTATO_A = "02920000-3333-4000-8000-000000000001";
const CONVERSA_A = "02920000-4444-4000-8000-000000000001";
const CASO_A = "02920000-5555-4000-8000-000000000001";

/** Papel `authenticated` + `request.jwt.claims` — o caminho exato do PostgREST. */
function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function contaComoMembro(userId: string, consulta: string): number {
  const saida = sql(`${comoMembro(userId)}\n${consulta};`).trim();
  const ultima = saida.split("\n").at(-1) ?? "";
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${saida}`);
  return Number(ultima);
}

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

/**
 * O booleano do psql, normalizado — e a normalização não é preguiça.
 *
 * `psql -tA` imprime `t`/`f` numa coluna `boolean` e `true`/`false` quando a
 * expressão já virou texto (`::text`, ou o retorno de `has_function_privilege`
 * pelo caminho que o `-tA` usa). Comparar contra UMA das duas formas faz o teste
 * reprovar por FORMA e não por conteúdo — foi exatamente o que esta versão fez
 * na primeira corrida contra o Postgres real: as cinco falhas eram
 * `expected 'false' to be 'f'`, com a propriedade de segurança CORRETA.
 */
function booleano(consulta: string): boolean {
  const cru = valor(consulta);
  if (cru === "t" || cru === "true") return true;
  if (cru === "f" || cru === "false") return false;
  throw new Error(`INSTRUMENTO: o psql não devolveu um booleano: ${JSON.stringify(cru)}`);
}

const CONFIGS_VISIVEIS = "select count(*) from public.config_aviso_de_caso";
const ENTREGAS_VISIVEIS = "select count(*) from public.entregas_de_aviso_de_caso";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',     'aviso-0292-admin-a@invariant.test'),
      ('${GESTOR_A}',    'aviso-0292-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'aviso-0292-agent-a@invariant.test'),
      ('${LEITOR_A}',    'aviso-0292-viewer-a@invariant.test'),
      ('${ADMIN_B}',     'aviso-0292-admin-b@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aviso-0292-a', 'Aviso 0292 A', 'Aviso 0292 A'),
      ('${ORG_B}', 'aviso-0292-b', 'Aviso 0292 B', 'Aviso 0292 B')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',     '${ORG_A}', 'admin',   now()),
      ('${GESTOR_A}',    '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent',   now()),
      ('${LEITOR_A}',    '${ORG_A}', 'viewer',  now()),
      ('${ADMIN_B}',     '${ORG_B}', 'admin',   now())
      on conflict do nothing;

    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'aviso-0292-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'aviso-0292-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${ORG_A}', 'Aviso 0292 Contato') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open')
      on conflict do nothing;
    insert into public.agent_cases (id, organization_id, conversation_id, status, source, title, summary, blocker)
      values ('${CASO_A}', '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Aviso 0292 Caso', 'resumo do caso', 'o que travou')
      on conflict do nothing;

    -- Uma linha de configuração e uma de entrega em CADA organização: sem a do
    -- vizinho, "o vizinho lê zero" seria satisfeito por tabela vazia.
    insert into public.config_aviso_de_caso
        (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_A}', '${SESSAO_A}', '+5531998966398', true)
      on conflict (organization_id) do update
        set channel_session_id = excluded.channel_session_id, ligado = excluded.ligado;
    insert into public.config_aviso_de_caso
        (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_B}', '${SESSAO_B}', '+5511988887777', true)
      on conflict (organization_id) do update
        set channel_session_id = excluded.channel_session_id, ligado = excluded.ligado;

    insert into public.entregas_de_aviso_de_caso
        (organization_id, case_id, destino, channel_session_id, status)
      values ('${ORG_A}', '${CASO_A}', '+5531998966398', '${SESSAO_A}', 'enviado')
      on conflict do nothing;
  `);
});

describe("0292 — a configuração do aviso é lida por quem administra", () => {
  it("CONTROLE POSITIVO: o admin da organização lê a própria configuração", () => {
    // Sem esta ponta, "ninguém lê" seria satisfeito por uma policy que nega a
    // todos — e a tela de configuração nasceria vazia para o dono.
    expect(contaComoMembro(ADMIN_A, CONFIGS_VISIVEIS)).toBe(1);
  });

  it("o admin do VIZINHO não lê a configuração de A", () => {
    // Ele lê a DELE (1), nunca a de A. Contar 1 e não 0 é o que distingue
    // isolamento de tabela vazia.
    expect(contaComoMembro(ADMIN_B, CONFIGS_VISIVEIS)).toBe(1);
    expect(
      contaComoMembro(
        ADMIN_B,
        `${CONFIGS_VISIVEIS} where organization_id = '${ORG_A}'`,
      ),
      "o admin do vizinho leu o número de aviso de outra empresa",
    ).toBe(0);
  });

  it("`agent` e `viewer` da MESMA organização não leem a configuração", () => {
    // O número de aviso é um telefone de funcionário, e trocá-lo redireciona
    // todo aviso da empresa. Quem não administra não precisa nem vê-lo.
    expect(contaComoMembro(ATENDENTE_A, CONFIGS_VISIVEIS)).toBe(0);
    expect(contaComoMembro(LEITOR_A, CONFIGS_VISIVEIS)).toBe(0);
  });
});

describe("0292 — o histórico de entregas é lido por quem opera", () => {
  it("CONTROLE POSITIVO: o gestor lê o histórico da própria organização", () => {
    expect(contaComoMembro(GESTOR_A, ENTREGAS_VISIVEIS)).toBe(1);
  });

  it("`viewer` não lê o histórico; o vizinho também não", () => {
    expect(contaComoMembro(LEITOR_A, ENTREGAS_VISIVEIS)).toBe(0);
    expect(contaComoMembro(ADMIN_B, ENTREGAS_VISIVEIS)).toBe(0);
  });
});

describe("0292 — `authenticated` não escreve em nenhuma das duas", () => {
  const escritas: Array<[string, string]> = [
    [
      "insert na configuração",
      `insert into public.config_aviso_de_caso (organization_id, telefone_destino) values ('${ORG_A}', '+5531900000000')`,
    ],
    [
      "update na configuração",
      `update public.config_aviso_de_caso set telefone_destino = '+5531900000000' where organization_id = '${ORG_A}'`,
    ],
    [
      "delete na configuração",
      `delete from public.config_aviso_de_caso where organization_id = '${ORG_A}'`,
    ],
    [
      "insert na entrega",
      `insert into public.entregas_de_aviso_de_caso (organization_id, case_id, destino) values ('${ORG_A}', '${CASO_A}', '+5531900000000')`,
    ],
    [
      "update na entrega",
      `update public.entregas_de_aviso_de_caso set status = 'enviado' where organization_id = '${ORG_A}'`,
    ],
    [
      "delete na entrega",
      `delete from public.entregas_de_aviso_de_caso where organization_id = '${ORG_A}'`,
    ],
  ];

  for (const [nome, comando] of escritas) {
    it(`${nome} é recusado até para o admin`, () => {
      // O papel mais alto do tenant, na PRÓPRIA organização: se ele não escreve,
      // ninguém logado escreve. A única porta é a RPC.
      let erro = "";
      try {
        sql(`${comoMembro(ADMIN_A)}\n${comando};`);
      } catch (e) {
        erro = motivoDoErro(e);
      }
      expect(erro, `${nome} passou — a tabela ganhou uma porta de escrita`).not.toBe("");
      expect(erro).toMatch(/permission denied|row-level security|violates/i);
    });
  }
});

describe("0292 — fn_definir_aviso_de_caso é a única porta, e ela confere o papel", () => {
  it("`agent` é recusado com 42501", () => {
    let erro = "";
    try {
      sql(
        `${comoMembro(ATENDENTE_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531977776666', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_forbidden|permission denied/i);
  });

  it("`viewer` é recusado", () => {
    let erro = "";
    try {
      sql(
        `${comoMembro(LEITOR_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531977776666', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_forbidden|permission denied/i);
  });

  it("CONTROLE POSITIVO: o admin da organização é aceito", () => {
    // Sem esta ponta, uma função que recusasse TODO MUNDO passaria nos dois
    // casos acima — verde pelo motivo errado, e a tela nunca salvaria nada.
    const saida = sql(
      `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531977776666', 'Plantão', true, false);`,
    );
    expect(saida).toContain("trocou_numero");
  });

  it("o admin de OUTRA organização é recusado", () => {
    let erro = "";
    try {
      sql(
        `${comoMembro(ADMIN_B)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531977775555', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_forbidden/i);
  });

  it("canal do VIZINHO é recusado — a FK simples sozinha deixaria passar", () => {
    // A tabela tem FK simples para `channel_sessions` (a composta do padrão 0228
    // anularia `organization_id` no `on delete set null`, e ele é a chave
    // primária). Quem garante que o canal é da organização é esta checagem.
    let erro = "";
    try {
      sql(
        `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_B}', '+5531977774444', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_canal_invalido/i);
  });

  it("número da PRÓPRIA organização é recusado — é o laço robô-com-robô", () => {
    sql(`update public.channel_sessions set phone_number = '+5531955554444' where id = '${SESSAO_A}';`);
    let erro = "";
    try {
      sql(
        `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531955554444', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_numero_da_propria_org/i);
    sql(`update public.channel_sessions set phone_number = null where id = '${SESSAO_A}';`);
  });

  it("conexão ARQUIVADA não conta — o número dela volta a ser um destino válido", () => {
    // A conexão ATIVA com aquele número continua recusada: é o laço
    // robô-com-robô que a checagem evita, e é o controle positivo deste caso.
    // Sem ele, "a arquivada passou" também seria satisfeito por uma checagem
    // que tivesse sido simplesmente apagada.
    sql(`update public.channel_sessions set phone_number = '+5531966665555' where id = '${SESSAO_A}';`);
    let ativa = "";
    try {
      sql(
        `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', null, '+5531966665555', null, true, false);`,
      );
    } catch (e) {
      ativa = motivoDoErro(e);
    }
    expect(ativa, "a conexão ATIVA deixou de bloquear — o laço voltou a ser possível").toMatch(
      /aviso_de_caso_numero_da_propria_org/i,
    );

    // A MESMA linha, ARQUIVADA. Ela não envia nem recebe, então o laço não
    // acontece por causa dela — e contá-la bloqueava o número PARA SEMPRE,
    // porque a conexão que já teve agente publicado não pode ser apagada.
    sql(`update public.channel_sessions set archived_at = now() where id = '${SESSAO_A}';`);
    const arquivada = sql(
      `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', null, '+5531966665555', null, true, false);`,
    );
    expect(
      arquivada,
      "a conexão arquivada continuou contando como número da própria organização",
    ).toContain("trocou_numero");

    sql(
      `update public.channel_sessions set archived_at = null, phone_number = null where id = '${SESSAO_A}';`,
    );
  });

  it("número que JÁ É CLIENTE exige confirmação — e passa com ela", () => {
    // Configurar o número de um cliente como interno faz as mensagens DELE
    // pararem de chegar ao CRM. É recusa por padrão, e a tela pergunta antes de
    // reenviar com a confirmação.
    sql(`update public.contacts set phone_number = '+5531944443333' where id = '${CONTATO_A}';`);
    let erro = "";
    try {
      sql(
        `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531944443333', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro).toMatch(/aviso_de_caso_numero_de_cliente/i);

    const comConfirmacao = sql(
      `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531944443333', null, true, true);`,
    );
    expect(comConfirmacao).toContain("trocou_numero");
    sql(`update public.contacts set phone_number = null where id = '${CONTATO_A}';`);
  });

  it("as duas grafias do nono dígito são a MESMA pessoa para a checagem de cliente", () => {
    // O suporte cadastrado com 9 e registrado sem (ou o contrário) é a causa
    // número um de "achei que tinha configurado e as mensagens sumiram".
    sql(`update public.contacts set phone_number = '+553193333222' where id = '${CONTATO_A}';`);
    let erro = "";
    try {
      sql(
        `${comoMembro(ADMIN_A)}\nselect public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531993333222', null, true, false);`,
      );
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(
      erro,
      "a checagem comparou a string crua — o contato com a outra grafia do nono dígito passou batido",
    ).toMatch(/aviso_de_caso_numero_de_cliente/i);
    sql(`update public.contacts set phone_number = null where id = '${CONTATO_A}';`);
  });

  it("anon não tem EXECUTE na função", () => {
    expect(
      booleano(
        `select has_function_privilege('anon', 'public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean)', 'EXECUTE')::text`,
      ),
      "a função nasceu exposta à anon key, que vai para o browser",
    ).toBe(false);
  });
});

describe("0292 — B4: apagar a conexão apontada NÃO pode falhar", () => {
  it("o DELETE da conexão passa, e a configuração fica desligada sozinha", () => {
    sql(`
      do $seed$ begin
        insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
          values ('${SESSAO_DESCARTAVEL}', '${ORG_A}', 'aviso-0292-descartavel', '\\x00'::bytea);
      exception when unique_violation then null; end $seed$;
      update public.config_aviso_de_caso
         set channel_session_id = '${SESSAO_DESCARTAVEL}', ligado = true
       where organization_id = '${ORG_A}';
    `);
    expect(
      booleano(`select ligado::text from public.config_aviso_de_caso where organization_id = '${ORG_A}'`),
      "a semente não ficou ligada — o caso mediria o estado errado",
    ).toBe(true);

    // ⚠️ É AQUI que um `check (ligado = false or channel_session_id is not null)`
    // estouraria: `on delete set null` é um UPDATE, o CHECK é reavaliado e viola
    // com `ligado = true`, abortando o DELETE INTEIRO da conexão.
    let erro = "";
    try {
      sql(`delete from public.channel_sessions where id = '${SESSAO_DESCARTAVEL}';`);
    } catch (e) {
      erro = motivoDoErro(e);
    }
    expect(erro, "apagar a conexão falhou por causa da configuração de aviso").toBe("");

    expect(
      booleano(`select channel_session_id is null from public.config_aviso_de_caso where organization_id = '${ORG_A}'`),
    ).toBe(true);
    expect(
      booleano(`select ligado::text from public.config_aviso_de_caso where organization_id = '${ORG_A}'`),
      "o aviso ficou LIGADO sem canal — uma configuração que a tela mostra ativa e que nunca dispara",
    ).toBe(false);
  });
});

describe("0292 — as duas funções do servidor não são alcançáveis por quem loga", () => {
  for (const assinatura of [
    "public.fn_registrar_jid_do_aviso(uuid,text)",
    "public.fn_contar_mensagem_ignorada(uuid)",
    "public.fn_expurgar_avisos_de_caso_vencidos(int,int)",
  ]) {
    it(`${assinatura} é fechada para anon e authenticated`, () => {
      // As DUAS origens de EXECUTE: o grant a `anon` do ALTER DEFAULT PRIVILEGES
      // do baseline (que `revoke from public` não remove) e o grant implícito a
      // PUBLIC que o Postgres dá ao criar a função (que `revoke from anon` não
      // remove). Fechar uma só deixa a função exposta com o gate verde.
      expect(booleano(`select has_function_privilege('anon', '${assinatura}', 'EXECUTE')::text`)).toBe(
        false,
      );
      expect(
        booleano(`select has_function_privilege('authenticated', '${assinatura}', 'EXECUTE')::text`),
      ).toBe(false);
    });
  }
});
