/**
 * #4012 (parte 2) — O COMANDO DA CONVERSA PERGUNTA PELO NÚMERO.
 *
 * O defeito medido: `comando_da_conversa(c)` respondia só pelo estado da
 * CONVERSA (dono, status, silêncio, trava). Toda conversa sem dono e sem trava
 * saía `automatico` — mesmo quando nenhum agente podia respondê-la:
 *
 *   * a organização tem agente, mas publicado em OUTRO número (o caso medido em
 *     produção: Direct do Instagram de um número sem IA);
 *   * o canal está em pré-go-live e o contato está fora da lista de teste
 *     (todo canal novo nasce assim, `metadataInicialDoCanal`);
 *   * o agente está pausado — `paused_at` grava a pausa e a versão segue
 *     publicada, mas o turno sai antes de rodar (`inbound-turn.ts`).
 *
 * A consequência: a Fila (que pede `aguardando`) não mostrava a conversa, a
 * troca de carteira a pulava (`fn_definir_carteira_do_cliente` filtra
 * `comando_da_conversa(c) <> 'automatico'`) e o dreno descartava o turno.
 *
 * A régua é a MESMA do dreno (`haQuemAtendaASessao`,
 * `lib/ai/agents/quem-atende-a-sessao.ts`) mais o portão de pré-go-live
 * (`numeroPodeTestar`, `lib/ai/elegibilidade/pre-go-live.ts`). Este arquivo
 * prova:
 *
 *   A. o wrapper do banco responde `aguardando` nos três casos e `automatico`
 *      onde há quem atenda — sem mexer nos estados que já estavam certos
 *      (`humano`, `encerrada`, `aguardando` por silêncio/trava, grupo);
 *   B. o campo calculado `automatico_da_conversa(c)` entrega o FATO, e o
 *      TypeScript (`comandoDaConversa`) responde o MESMO que o banco quando o
 *      recebe — o espelho que impede as duas réguas de divergirem;
 *   C. a carteira leva a conversa que o banco rebaixou e deixa quieta a que tem
 *      a IA (Doc 237, 3-B), que é o efeito que a issue nomeia.
 *
 * Organização própria (namespace `40124012-`) para não encostar em GOV_ORG nem
 * nas outras organizações dos invariantes que rodam em paralelo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { comandoDaConversa, type FatosDoComando } from "@/lib/inbox/comando-da-conversa";

import { lastLine, sql } from "./gov-helpers";

const P = "40124012";
const ORG = `${P}-0000-4000-8000-000000000001`;
const DONO = `${P}-1111-4000-8000-000000000001`; // vendedor: papel `agent`
const AGENTE = `${P}-aaaa-4000-8000-000000000001`;
const AGENTE_PAUSADO = `${P}-aaaa-4000-8000-000000000002`;
const AGENTE_PRE = `${P}-aaaa-4000-8000-000000000003`;
const VERSAO = `${P}-bbbb-4000-8000-000000000001`;
const VERSAO_PAUSADO = `${P}-bbbb-4000-8000-000000000002`;
const VERSAO_PRE = `${P}-bbbb-4000-8000-000000000003`;
const ROTEADOR = `${P}-cccc-4000-8000-000000000001`;

// Um número por caso: a 0027 permite UMA conversa por (contato, número).
const SESSAO_COM_AGENTE = `${P}-2222-4000-8000-000000000001`;
const SESSAO_SEM_AGENTE = `${P}-2222-4000-8000-000000000002`;
const SESSAO_PRE_GO_LIVE = `${P}-2222-4000-8000-000000000003`;
const SESSAO_PAUSADO = `${P}-2222-4000-8000-000000000004`;
const SESSAO_ROTEADOR = `${P}-2222-4000-8000-000000000005`;

const CONTATO_IA = `${P}-3333-4000-8000-000000000001`;
const CONTATO_SEM_AGENTE = `${P}-3333-4000-8000-000000000002`;
const CONTATO_PRE_GO_LIVE = `${P}-3333-4000-8000-000000000003`;
const CONTATO_NA_LISTA = `${P}-3333-4000-8000-000000000004`;
const CONTATO_PAUSADO = `${P}-3333-4000-8000-000000000005`;
const CONTATO_ROTEADOR = `${P}-3333-4000-8000-000000000006`;
const CONTATO_COM_DONO = `${P}-3333-4000-8000-000000000007`;
const CONTATO_CALADO = `${P}-3333-4000-8000-000000000008`;

const CONVERSA_IA = `${P}-4444-4000-8000-000000000001`;
const CONVERSA_SEM_AGENTE = `${P}-4444-4000-8000-000000000002`;
const CONVERSA_PRE_GO_LIVE = `${P}-4444-4000-8000-000000000003`;
const CONVERSA_NA_LISTA = `${P}-4444-4000-8000-000000000004`;
const CONVERSA_PAUSADO = `${P}-4444-4000-8000-000000000005`;
const CONVERSA_ROTEADOR = `${P}-4444-4000-8000-000000000006`;
const CONVERSA_COM_DONO = `${P}-4444-4000-8000-000000000007`;
const CONVERSA_CALADA = `${P}-4444-4000-8000-000000000008`;

/**
 * O telefone do CONTATO_NA_LISTA está gravado SEM o nono dígito, e a lista de
 * teste tem a forma canônica COM ele. É o caso do corpus da issue: se a
 * comparação não passar por `fn_telefone_variantes`, este botão fica apagado
 * para um cliente que está, sim, na lista.
 */
const TELEFONE_COM_NONO = "+5511987654321";
const TELEFONE_SEM_NONO = "+551187654321";

const PRÉ_GO_LIVE_VAZIO =
  '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}';
const PRÉ_GO_LIVE_COM_LISTA = `{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":["${TELEFONE_COM_NONO}"]}`;
const GATE_ABERTO = '{"ai_gate":"open"}';

function comandoDaConversaNoBanco(conversa: string): string {
  return lastLine(
    sql(
      `select public.comando_da_conversa(c) from public.conversations c where c.id = '${conversa}';`,
    ),
  );
}

function fatoDoBanco(conversa: string): string {
  return lastLine(
    sql(
      `select public.automatico_da_conversa(c)::text from public.conversations c where c.id = '${conversa}';`,
    ),
  );
}

/** O espelho: o TS recebe o fato do banco e tem de responder o mesmo comando. */
function comandoDoTs(conversa: string, fato: string): string {
  const linha = lastLine(
    sql(`select status || '|' || coalesce(assigned_to_user_id::text, '') || '|' || coalesce(bot_silenced_until::text, '')
           from public.conversations where id = '${conversa}';`),
  );
  const [status, dono, silencio] = linha.split("|");
  const fatos: FatosDoComando = {
    status: status!,
    assigned_to_user_id: dono === "" ? null : dono!,
    bot_silenced_until: silencio === "" ? null : silencio!,
    is_group: false,
    automaticoDaConversa: fato === "true",
  };
  return comandoDaConversa(fatos, new Date()).comando.quem;
}

function donoDaConversa(conversa: string): string {
  return lastLine(
    sql(
      `select coalesce(assigned_to_user_id::text, 'NULL') from public.conversations where id = '${conversa}';`,
    ),
  );
}

function moveCarteira(contato: string): void {
  sql(`
    set role service_role;
    select public.fn_definir_carteira_do_cliente('${ORG}', null, '${contato}', '${DONO}', 'automacao');
  `);
}

describe("comando da conversa pergunta pelo NÚMERO (#4012)", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${DONO}', 'comando-numero-dono@invariant.test')
      on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name) values
        ('${ORG}', 'comando-numero-inv', 'Comando Numero Inv Org', 'Comando Numero')
      on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${DONO}', '${ORG}', 'agent', now())
      on conflict (user_id, organization_id) do nothing;
      update public.user_organizations
         set role = 'agent', revoked_at = null
       where organization_id = '${ORG}' and user_id = '${DONO}';

      insert into public.channel_sessions
        (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status, display_name, metadata)
      values
        ('${SESSAO_COM_AGENTE}', '${ORG}', 'waha', 'comando-numero-1', '\\x00'::bytea, 'WORKING', 'Com agente', '${GATE_ABERTO}'::jsonb),
        ('${SESSAO_SEM_AGENTE}', '${ORG}', 'waha', 'comando-numero-2', '\\x00'::bytea, 'WORKING', 'Sem agente', '${GATE_ABERTO}'::jsonb),
        ('${SESSAO_PRE_GO_LIVE}', '${ORG}', 'waha', 'comando-numero-3', '\\x00'::bytea, 'WORKING', 'Pre go live', '${PRÉ_GO_LIVE_VAZIO}'::jsonb),
        ('${SESSAO_PAUSADO}', '${ORG}', 'waha', 'comando-numero-4', '\\x00'::bytea, 'WORKING', 'Agente pausado', '${GATE_ABERTO}'::jsonb),
        ('${SESSAO_ROTEADOR}', '${ORG}', 'waha', 'comando-numero-5', '\\x00'::bytea, 'WORKING', 'Roteador', '${GATE_ABERTO}'::jsonb)
      on conflict (id) do nothing;

      insert into public.contacts (id, organization_id, display_name, phone_number) values
        ('${CONTATO_IA}', '${ORG}', 'Contato IA', '+5511911110001'),
        ('${CONTATO_SEM_AGENTE}', '${ORG}', 'Contato outro numero', '+5511911110002'),
        ('${CONTATO_PRE_GO_LIVE}', '${ORG}', 'Contato pre go live', '+5511911110003'),
        ('${CONTATO_NA_LISTA}', '${ORG}', 'Contato na lista', '${TELEFONE_SEM_NONO}'),
        ('${CONTATO_PAUSADO}', '${ORG}', 'Contato pausado', '+5511911110005'),
        ('${CONTATO_ROTEADOR}', '${ORG}', 'Contato roteador', '+5511911110006'),
        ('${CONTATO_COM_DONO}', '${ORG}', 'Contato com dono', '+5511911110007'),
        ('${CONTATO_CALADO}', '${ORG}', 'Contato calado', '+5511911110008')
      on conflict (id) do nothing;

      insert into public.ai_agents (id, organization_id, name, system_prompt) values
        ('${AGENTE}', '${ORG}', 'Agente do numero 1', 'x'),
        ('${AGENTE_PAUSADO}', '${ORG}', 'Agente do numero 4', 'x'),
        ('${AGENTE_PRE}', '${ORG}', 'Agente do pre go live', 'x')
      on conflict (id) do nothing;
      insert into public.ai_agent_versions
        (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values
        ('${VERSAO}', '${ORG}', '${AGENTE}', 1, 'x', 'anthropic', 'm', '${SESSAO_COM_AGENTE}', 'published'),
        ('${VERSAO_PAUSADO}', '${ORG}', '${AGENTE_PAUSADO}', 1, 'x', 'anthropic', 'm', '${SESSAO_PAUSADO}', 'published'),
        ('${VERSAO_PRE}', '${ORG}', '${AGENTE_PRE}', 1, 'x', 'anthropic', 'm', '${SESSAO_PRE_GO_LIVE}', 'published')
      on conflict (id) do nothing;
      update public.ai_agents set published_version_id = '${VERSAO}' where id = '${AGENTE}';
      update public.ai_agents set published_version_id = '${VERSAO_PRE}' where id = '${AGENTE_PRE}';
      update public.ai_agents set published_version_id = '${VERSAO_PAUSADO}', paused_at = now() where id = '${AGENTE_PAUSADO}';

      -- O roteador do número 5 não tem agente publicado NA sessão: quem atende
      -- é o membro publicado, e é essa a régua que o dreno aplica.
      insert into public.ai_routers (id, organization_id, channel_session_id, name, is_active)
      values ('${ROTEADOR}', '${ORG}', '${SESSAO_ROTEADOR}', 'Roteador do numero 5', true)
      on conflict (id) do nothing;
      insert into public.ai_router_members (router_id, agent_id, organization_id, intent_name, intent_description)
      values ('${ROTEADOR}', '${AGENTE}', '${ORG}', 'vendas', 'Cliente quer comprar')
      on conflict do nothing;

      delete from public.conversations where organization_id = '${ORG}';
      insert into public.conversations
        (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, bot_silenced_until)
      values
        ('${CONVERSA_IA}',          '${ORG}', '${CONTATO_IA}',          '${SESSAO_COM_AGENTE}',   'open', null,    null),
        ('${CONVERSA_SEM_AGENTE}',  '${ORG}', '${CONTATO_SEM_AGENTE}',  '${SESSAO_SEM_AGENTE}',   'open', null,    null),
        ('${CONVERSA_PRE_GO_LIVE}', '${ORG}', '${CONTATO_PRE_GO_LIVE}', '${SESSAO_PRE_GO_LIVE}',  'open', null,    null),
        ('${CONVERSA_NA_LISTA}',    '${ORG}', '${CONTATO_NA_LISTA}',    '${SESSAO_PRE_GO_LIVE}',  'open', null,    null),
        ('${CONVERSA_PAUSADO}',     '${ORG}', '${CONTATO_PAUSADO}',     '${SESSAO_PAUSADO}',      'open', null,    null),
        ('${CONVERSA_ROTEADOR}',    '${ORG}', '${CONTATO_ROTEADOR}',    '${SESSAO_ROTEADOR}',     'open', null,    null),
        ('${CONVERSA_COM_DONO}',    '${ORG}', '${CONTATO_COM_DONO}',    '${SESSAO_COM_AGENTE}',   'open', '${DONO}', null),
        ('${CONVERSA_CALADA}',      '${ORG}', '${CONTATO_CALADO}',      '${SESSAO_COM_AGENTE}',   'open', null,    'infinity');
    `);

    // A lista de teste do canal 3 muda entre os casos (vazia para um, com o
    // número para o outro): cada teste ajusta a metadata antes de medir.
  });

  afterAll(() => {
    sql(`
      delete from public.conversations where organization_id = '${ORG}';
      delete from public.ai_router_members where organization_id = '${ORG}';
      delete from public.ai_routers where organization_id = '${ORG}';
      update public.ai_agents set published_version_id = null where organization_id = '${ORG}';
      delete from public.ai_agent_versions where organization_id = '${ORG}';
      delete from public.ai_agents where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.channel_sessions where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id = '${DONO}';
    `);
  });

  it("agente publicado no número: continua 'automatico', e o fato é true", () => {
    expect(comandoDaConversaNoBanco(CONVERSA_IA)).toBe("automatico");
    expect(fatoDoBanco(CONVERSA_IA)).toBe("true");
  });

  it("⭐ agente publicado em OUTRO número: 'aguardando' — a Fila mostra e a carteira leva", () => {
    expect(comandoDaConversaNoBanco(CONVERSA_SEM_AGENTE)).toBe("aguardando");
    expect(fatoDoBanco(CONVERSA_SEM_AGENTE)).toBe("false");
  });

  it("⭐ canal em pré-go-live com lista vazia: 'aguardando'", () => {
    expect(comandoDaConversaNoBanco(CONVERSA_PRE_GO_LIVE)).toBe("aguardando");
    expect(fatoDoBanco(CONVERSA_PRE_GO_LIVE)).toBe("false");
  });

  it("⭐ pré-go-live, contato na lista pelo NONO DÍGITO (grafias trocadas): 'automatico'", () => {
    sql(
      `update public.channel_sessions set metadata = '${PRÉ_GO_LIVE_COM_LISTA}'::jsonb where id = '${SESSAO_PRE_GO_LIVE}';`,
    );
    try {
      expect(comandoDaConversaNoBanco(CONVERSA_NA_LISTA)).toBe("automatico");
      expect(fatoDoBanco(CONVERSA_NA_LISTA)).toBe("true");
      // E o contato FORA da lista no mesmo canal continua na fila.
      expect(comandoDaConversaNoBanco(CONVERSA_PRE_GO_LIVE)).toBe("aguardando");
    } finally {
      sql(
        `update public.channel_sessions set metadata = '${PRÉ_GO_LIVE_VAZIO}'::jsonb where id = '${SESSAO_PRE_GO_LIVE}';`,
      );
    }
  });

  it("⭐ agente pausado pela tela: 'aguardando' — pausado não responde", () => {
    expect(comandoDaConversaNoBanco(CONVERSA_PAUSADO)).toBe("aguardando");
    expect(fatoDoBanco(CONVERSA_PAUSADO)).toBe("false");
  });

  it("roteador ativo com membro publicado no número: 'automatico'", () => {
    // O agente do caso 1 também é membro do roteador do número 5 — é o membro
    // publicado que abre o portão, não a versão ligada à sessão.
    expect(comandoDaConversaNoBanco(CONVERSA_ROTEADOR)).toBe("automatico");
    expect(fatoDoBanco(CONVERSA_ROTEADOR)).toBe("true");
  });

  it("os estados que já estavam certos não mudam: dono e silêncio", () => {
    expect(comandoDaConversaNoBanco(CONVERSA_COM_DONO)).toBe("humano");
    expect(comandoDaConversaNoBanco(CONVERSA_CALADA)).toBe("aguardando");
    // E o fato segue true: o número TEM quem atenda; o silêncio é outra pergunta.
    expect(fatoDoBanco(CONVERSA_CALADA)).toBe("true");
  });

  it("⭐ o TypeScript responde o MESMO que o banco em todos os casos", () => {
    const casos = [
      CONVERSA_IA,
      CONVERSA_SEM_AGENTE,
      CONVERSA_PRE_GO_LIVE,
      CONVERSA_PAUSADO,
      CONVERSA_ROTEADOR,
      CONVERSA_COM_DONO,
      CONVERSA_CALADA,
    ];
    const matriz = casos.map((conversa) => {
      const fato = fatoDoBanco(conversa);
      const banco = comandoDaConversaNoBanco(conversa);
      const ts = comandoDoTs(conversa, fato);
      return `${conversa.slice(-3)} banco=${banco} ts=${ts} fato=${fato}`;
    });
    console.log(`[4012] espelho banco×TS: ${JSON.stringify(matriz)}`);
    for (const conversa of casos) {
      const fato = fatoDoBanco(conversa);
      expect(comandoDoTs(conversa, fato)).toBe(comandoDaConversaNoBanco(conversa));
    }
  });

  it("⭐ a carteira leva a conversa rebaixada e deixa a que tem a IA (Doc 237, 3-B)", () => {
    moveCarteira(CONTATO_SEM_AGENTE);
    expect(donoDaConversa(CONVERSA_SEM_AGENTE)).toBe(DONO);

    moveCarteira(CONTATO_IA);
    expect(donoDaConversa(CONVERSA_IA)).toBe("NULL");
  });
});
