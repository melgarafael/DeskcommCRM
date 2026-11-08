/**
 * O COMANDO DA CONVERSA SABE SE HÁ AGENTE NO AR — issue #4012, migration 9252.
 *
 * ## O defeito
 *
 * `fn_comando_da_conversa` devolvia `automatico` para TODA conversa sem dono e
 * sem trava, sem perguntar se a organização tinha agente publicado. Quem decide
 * pelo banco filtra `comando_da_conversa(c) <> 'automatico'` antes de passar a
 * conversa adiante (`fn_definir_carteira_do_cliente`, #3642;
 * `fn_conversation_assign`, #3732). Numa instalação sem IA no ar, passar o
 * cliente para um vendedor não levava NENHUMA conversa — a regra "a conversa da
 * IA fica com a IA" (Doc 237) aplicada onde não há IA.
 *
 * O TypeScript já respondia certo (`comandoDaConversa` com
 * `automaticoDaOrg === false` → `ninguem`, lib/inbox/comando-da-conversa.ts).
 *
 * ## O que este arquivo mede, e por que cada bloco existe
 *
 * - **A** a régua: sem agente publicado é `ninguem`; com agente é `automatico`.
 * - **B** o WRAPPER (`comando_da_conversa(c)`) — é ele que os consumidores do
 *   banco chamam e é ele que precisa passar a organização; A sozinho não veria
 *   um wrapper que esquecesse o oitavo argumento.
 * - **C** as três formas de "não está no ar" (`agenteAtende`, no-ar.ts: pausado,
 *   arquivado, sem versão publicada). Um EXISTS que aceitasse qualquer linha de
 *   `ai_agents` passaria em A e B e mentiria em produção.
 * - **D** o fio: a troca de carteira LEVA a conversa na org sem agente (o
 *   defeito da issue) e continua deixando com a IA a conversa que ela atende.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/** Organização sem nenhum agente. */
const SEM = "aaaa0728-0000-4000-8000-00000000a001";
/** Organização com um agente publicado. */
const COM = "aaaa0728-0000-4000-8000-00000000a002";
/** Organização com agentes que NÃO estão no ar (pausado, arquivado, rascunho). */
const FORA = "aaaa0728-0000-4000-8000-00000000a003";

const GERENTE = "bbbb0728-0000-4000-8000-00000000b001";
const VENDEDOR = "bbbb0728-0000-4000-8000-00000000b002";

/** Contato livre da org sem agente — a conversa dele é a do caso 1 da issue. */
const CONTATO_SEM = "cccc0728-0000-4000-8000-00000000c001";
/** Contato livre da org com agente. */
const CONTATO_COM = "cccc0728-0000-4000-8000-00000000c002";
/** Contato travado (force_human) da org com agente. */
const CONTATO_TRAVADO = "cccc0728-0000-4000-8000-00000000c003";
/** Contato cuja conversa já tem dono (o gerente). */
const CONTATO_COM_DONO = "cccc0728-0000-4000-8000-00000000c004";

const CONVERSA_SEM = "dddd0728-0000-4000-8000-00000000d001";
const CONVERSA_COM = "dddd0728-0000-4000-8000-00000000d002";
const CONVERSA_TRAVADA = "dddd0728-0000-4000-8000-00000000d003";
const CONVERSA_COM_DONO = "dddd0728-0000-4000-8000-00000000d004";

/** Um valor só: última linha do psql (`-tA`). */
function valor(script: string): string {
  const linhas = sql(script).split("\n");
  return (linhas[linhas.length - 1] ?? "").trim();
}

/** A regra direto, passando a organização (a assinatura de oito da 9252). */
function comandoDireto(status: string, dono: string | null, org: string | null): string {
  return valor(
    `select public.fn_comando_da_conversa(
       '${status}', ${dono ? `'${dono}'` : "null"}, null, false, false, now(), false,
       ${org ? `'${org}'` : "null"})`,
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE}', 'gerente-728@deskcomm.test'),
      ('${VENDEDOR}', 'vendedor-728@deskcomm.test')
      on conflict (id) do nothing;

    insert into organizations (id, slug, legal_name, display_name) values
      ('${SEM}', 'comando-sem-agente', 'Sem Agente LTDA', 'Sem Agente'),
      ('${COM}', 'comando-com-agente', 'Com Agente LTDA', 'Com Agente'),
      ('${FORA}', 'comando-agente-fora', 'Agente Fora LTDA', 'Agente Fora');

    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name) values
      ('${SEM}', '${SEM}', '\\x00', 'sess-728-sem'),
      ('${COM}', '${COM}', '\\x00', 'sess-728-com'),
      ('${FORA}', '${FORA}', '\\x00', 'sess-728-fora');

    -- O gerente é quem mexe na carteira; o vendedor é o dono novo.
    insert into user_organizations (organization_id, user_id, role, accepted_at) values
      ('${SEM}', '${GERENTE}', 'manager', now()),
      ('${COM}', '${GERENTE}', 'manager', now()),
      ('${SEM}', '${VENDEDOR}', 'agent', now()),
      ('${COM}', '${VENDEDOR}', 'agent', now());

    insert into contacts (id, organization_id, force_human) values
      ('${CONTATO_SEM}', '${SEM}', false),
      ('${CONTATO_COM}', '${COM}', false),
      ('${CONTATO_TRAVADO}', '${COM}', true),
      ('${CONTATO_COM_DONO}', '${COM}', false);

    insert into conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_SEM}', '${SEM}', '${CONTATO_SEM}', '${SEM}', 'open'),
      ('${CONVERSA_COM}', '${COM}', '${CONTATO_COM}', '${COM}', 'open'),
      ('${CONVERSA_TRAVADA}', '${COM}', '${CONTATO_TRAVADO}', '${COM}', 'open'),
      ('${CONVERSA_COM_DONO}', '${COM}', '${CONTATO_COM_DONO}', '${COM}', 'open');
    update conversations set assigned_to_user_id = '${GERENTE}' where id = '${CONVERSA_COM_DONO}';

    -- O agente NO AR da org COM: versão publicada e ponteiro preenchido.
    insert into ai_agents (id, organization_id, name, system_prompt)
      values ('eeee0728-0000-4000-8000-00000000e001', '${COM}', 'Agente no ar', 'system');
    insert into ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values ('ffff0728-0000-4000-8000-00000000f001', '${COM}',
              'eeee0728-0000-4000-8000-00000000e001', 1, 'system', 'anthropic',
              'claude-sonnet-4-6', '${COM}', 'published');
    update ai_agents set published_version_id = 'ffff0728-0000-4000-8000-00000000f001'
     where id = 'eeee0728-0000-4000-8000-00000000e001';

    -- As três formas de NÃO estar no ar (a régua de agenteAtende(), no-ar.ts).
    insert into ai_agents (id, organization_id, name, system_prompt, paused_at)
      values ('eeee0728-0000-4000-8000-00000000e002', '${FORA}', 'Pausado', 'system', now());
    insert into ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values ('ffff0728-0000-4000-8000-00000000f002', '${FORA}',
              'eeee0728-0000-4000-8000-00000000e002', 1, 'system', 'anthropic',
              'claude-sonnet-4-6', '${FORA}', 'published');
    update ai_agents set published_version_id = 'ffff0728-0000-4000-8000-00000000f002'
     where id = 'eeee0728-0000-4000-8000-00000000e002';

    insert into ai_agents (id, organization_id, name, system_prompt, archived_at)
      values ('eeee0728-0000-4000-8000-00000000e003', '${FORA}', 'Arquivado', 'system', now());
    insert into ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values ('ffff0728-0000-4000-8000-00000000f003', '${FORA}',
              'eeee0728-0000-4000-8000-00000000e003', 1, 'system', 'anthropic',
              'claude-sonnet-4-6', '${FORA}', 'published');
    update ai_agents set published_version_id = 'ffff0728-0000-4000-8000-00000000f003'
     where id = 'eeee0728-0000-4000-8000-00000000e003';

    -- Rascunho: existe, está ativo, mas nunca foi publicado.
    insert into ai_agents (id, organization_id, name, system_prompt)
      values ('eeee0728-0000-4000-8000-00000000e004', '${FORA}', 'Rascunho', 'system');
  `);
});

describe("A — a régua é a organização ter agente publicado", () => {
  it("organização SEM agente: sem dono e sem trava é 'ninguem', não 'automatico'", () => {
    expect(comandoDireto("open", null, SEM)).toBe("ninguem");
  });

  it("organização COM agente publicado: sem dono e sem trava continua 'automatico'", () => {
    expect(comandoDireto("open", null, COM)).toBe("automatico");
  });

  it("pausado, arquivado e rascunho NÃO são 'no ar'", () => {
    expect(comandoDireto("open", null, FORA)).toBe("ninguem");
  });

  it("dono continua 'humano' nas duas organizações", () => {
    expect(comandoDireto("open", GERENTE, SEM)).toBe("humano");
    expect(comandoDireto("open", GERENTE, COM)).toBe("humano");
  });

  it("trava vence o fato da organização: 'aguardando' mesmo sem agente", () => {
    const aguardando = valor(
      `select public.fn_comando_da_conversa('open', null, null, true, false, now(), false, '${SEM}')`,
    );
    expect(aguardando).toBe("aguardando");
  });

  it("chamador antigo (sem organização) preserva 'automatico' — assinatura de sete", () => {
    const antigo = valor(
      `select public.fn_comando_da_conversa('open', null, null, false, false, now(), false)`,
    );
    expect(antigo).toBe("automatico");
  });
});

describe("B — o wrapper passa a organização (é ele que o banco consome)", () => {
  it("a conversa da org sem agente é 'ninguem' pelo campo calculado", () => {
    expect(valor(`select public.comando_da_conversa(c) from conversations c where c.id = '${CONVERSA_SEM}'`)).toBe(
      "ninguem",
    );
  });

  it("a conversa da org com agente é 'automatico' pelo campo calculado", () => {
    expect(valor(`select public.comando_da_conversa(c) from conversations c where c.id = '${CONVERSA_COM}'`)).toBe(
      "automatico",
    );
  });

  it("conversa com dono continua 'humano' pelo campo calculado", () => {
    expect(
      valor(`select public.comando_da_conversa(c) from conversations c where c.id = '${CONVERSA_COM_DONO}'`),
    ).toBe("humano");
  });
});

describe("D — o fio: a troca de carteira leva a conversa", () => {
  it("org SEM agente: o cliente que muda de carteira leva a conversa junto (#4012)", () => {
    const dono = valor(
      `select public.fn_definir_carteira_do_cliente('${SEM}', '${GERENTE}', '${CONTATO_SEM}', '${VENDEDOR}', 'manual')`,
    );
    expect(dono).toBe(VENDEDOR);
    expect(
      valor(`select coalesce(assigned_to_user_id::text, 'null') from conversations where id = '${CONVERSA_SEM}'`),
    ).toBe(VENDEDOR);
  });

  it("org COM agente: a conversa travada é levada e a que a IA atende fica com a IA", () => {
    valor(
      `select public.fn_definir_carteira_do_cliente('${COM}', '${GERENTE}', '${CONTATO_TRAVADO}', '${VENDEDOR}', 'manual')`,
    );
    expect(
      valor(`select coalesce(assigned_to_user_id::text, 'null') from conversations where id = '${CONVERSA_TRAVADA}'`),
    ).toBe(VENDEDOR);

    valor(
      `select public.fn_definir_carteira_do_cliente('${COM}', '${GERENTE}', '${CONTATO_COM}', '${VENDEDOR}', 'manual')`,
    );
    expect(
      valor(`select coalesce(assigned_to_user_id::text, 'null') from conversations where id = '${CONVERSA_COM}'`),
      "a conversa que a IA atende não é tomada pela carteira (Doc 237)",
    ).toBe("null");
  });
});
