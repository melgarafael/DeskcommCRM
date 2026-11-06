/**
 * O AVISO PODE CHEGAR A UM MEMBRO DA EQUIPE QUE TAMBÉM É CLIENTE (#3900).
 *
 * ─── O caso que este arquivo mede ──────────────────────────────────────────
 *
 * Agência de viagens: a equipe viaja pela própria agência, então o WhatsApp
 * pessoal de cada atendente é TAMBÉM um contato. No modo `responsavel` o aviso
 * sai para esse número — e a guarda de `numero_de_cliente` perguntava, porque o
 * número VIRA interno e as mensagens da pessoa deixariam de chegar ao CRM. Quem
 * confirmava via a atendente desaparecer do CRM quando ela mesma viajava e
 * escrevia como cliente.
 *
 * ─── A decisão, medida no banco ────────────────────────────────────────────
 *
 * Em `responsavel`, destino que é o WhatsApp de um membro ATIVO não vira
 * interno — o corte da ingestão lerá `whatsapp_e164` e deixará a mensagem
 * entrar (`tests/unit/aviso-de-caso-membro-da-equipe.test.ts` prova essa
 * ponta). Logo não há consequência a confirmar, e a função não pergunta:
 * devolve `destino_e_de_membro` para a rota registrar QUAL regra autorizou.
 *
 * O que NÃO pode escorregar junto, e está medido abaixo:
 *   · cliente comum que é destino do aviso continua exigindo confirmação;
 *   · `fixo` não muda em nada — ali o número vira interno de verdade;
 *   · membro REVOGADO não abre exceção (ele não recebe aviso nenhum);
 *   · primeiro salvamento, com `whatsapp_e164` ainda nulo e o número chegando
 *     em `p_responsaveis`, também é reconhecido — é a ordem real da tela.
 *
 * ─── Sabotagem ─────────────────────────────────────────────────────────────
 *
 * · `and v_modo = 'responsavel'` → o caso do `fixo` cai (o plantão deixaria de
 *   ser interno e passaria a entrar como cliente);
 * · `uo.revoked_at is null` → o caso do membro revogado cai;
 * · a exceção valendo para qualquer número → o caso do cliente comum cai;
 * · o `select` só pela coluna gravada → o caso do primeiro salvamento cai.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "7f000000-0000-4000-8000-000000003900";
const ADMIN = "7f000000-0000-4000-8000-000000003901";
const ATENDENTE = "7f000000-0000-4000-8000-000000003902";
const REVOGADA = "7f000000-0000-4000-8000-000000003903";
const SESSAO = "7f000000-0000-4000-8000-000000003904";
const CONTATO = "7f000000-0000-4000-8000-000000003905";
const CONTATO_CLIENTE = "7f000000-0000-4000-8000-000000003906";

/** O celular pessoal da atendente — ela viaja pela própria agência. */
const NUMERO_DA_MEMBRO = "+5531998887777";
const NUMERO_DA_MEMBRO_SEM_NOVE = "+553198887777";
/** Um cliente comum, que não é de ninguém da equipe. */
const NUMERO_DE_CLIENTE = "+5531977776666";

function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

/**
 * A chamada da tela, com os dez parâmetros. `responsaveis` entra como jsonb —
 * é o mesmo corpo que `app/api/v1/ai/cases/alerta/route.ts` manda.
 */
function define(opcoes: {
  destino: string | null;
  modo: "fixo" | "responsavel";
  confirma?: boolean;
  responsaveis?: Array<{ user_id: string; whatsapp: string }>;
}): string {
  const responsaveis = opcoes.responsaveis
    ? `'${JSON.stringify(opcoes.responsaveis)}'::jsonb`
    : "null";
  const destino = opcoes.destino === null ? "null" : `'${opcoes.destino}'`;
  return sql(
    `${comoMembro(ADMIN)}
     select public.fn_definir_aviso_de_caso(
       '${ORG}', '${SESSAO}', ${destino}, null, true,
       ${opcoes.confirma ? "true" : "false"}, false, '${opcoes.modo}', ${responsaveis}
     );`,
  ).trim();
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN}',     'aviso-3900-admin@invariant.test'),
      ('${ATENDENTE}', 'aviso-3900-atendente@invariant.test'),
      ('${REVOGADA}',  'aviso-3900-revogada@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'aviso-3900', 'Aviso 3900', 'Aviso 3900')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at, whatsapp_e164) values
      ('${ADMIN}',     '${ORG}', 'admin', now(), null),
      ('${ATENDENTE}', '${ORG}', 'agent', now(), '${NUMERO_DA_MEMBRO}'),
      ('${REVOGADA}',  '${ORG}', 'agent', now(), '${NUMERO_DE_CLIENTE}')
      on conflict do nothing;
    update public.user_organizations set revoked_at = now()
      where user_id = '${REVOGADA}' and organization_id = '${ORG}';

    -- DO + exception e não ON CONFLICT: channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'aviso-3900', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    -- O número da atendente é um CONTATO desta organização: é isso que a
    -- guarda de numero_de_cliente enxerga, e é isso que faz dela "cliente".
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Atendente que viaja', '${NUMERO_DA_MEMBRO}')
      on conflict (id) do update set phone_number = excluded.phone_number;
    -- E um cliente que NÃO é da equipe: sem ele, a guarda de cliente comum não
    -- teria sobre o que disparar, e o caso que devia recusar passaria vazio.
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO_CLIENTE}', '${ORG}', 'Cliente comum', '${NUMERO_DE_CLIENTE}')
      on conflict (id) do update set phone_number = excluded.phone_number;
  `);
});

describe("3900 — em `responsavel`, o membro da equipe que também é cliente", () => {
  it("RED do defeito: o destino é contato, é membro, e o aviso PASSA sem confirmação", () => {
    // Antes desta entrega esta chamada levantava
    // `aviso_de_caso_numero_de_cliente` — e quem confirmava perdia a atendente
    // do CRM. O número dela está em `contacts` de propósito.
    const saida = define({ destino: NUMERO_DA_MEMBRO, modo: "responsavel" });
    expect(saida).toContain("trocou_numero");
    // A ROTA precisa saber qual regra autorizou (#3900).
    expect(saida, "a função não disse que o destino é de membro").toMatch(
      /destino_e_de_membro.*t/,
    );
  });

  it("o número NÃO vira interno: a gravação convive com o contato de mesmo telefone", () => {
    define({ destino: NUMERO_DA_MEMBRO, modo: "responsavel" });
    const gravado = sql(
      `select coalesce(telefone_destino, 'nulo') || ' | ' || coalesce(destino_modo, 'nulo')
         from public.config_aviso_de_caso where organization_id = '${ORG}';`,
    ).trim();
    expect(gravado).toContain(NUMERO_DA_MEMBRO);
    expect(gravado).toContain("responsavel");
    // E o contato continua sendo um contato — nada aqui reescreve o telefone
    // dele para outro campo, nem o marca como interno.
    const contato = sql(
      `select coalesce(phone_number, 'nulo') from public.contacts where id = '${CONTATO}';`,
    ).trim();
    expect(contato).toBe(NUMERO_DA_MEMBRO);
  });

  it("a OUTRA grafia do nono dígito também é reconhecida como o membro", () => {
    // A atendente cadastrada com 9 e o destino sem (ou o contrário) é o
    // cadastro mais comum — e é o erro número um de "configurei e sumiu".
    const saida = define({ destino: NUMERO_DA_MEMBRO_SEM_NOVE, modo: "responsavel" });
    expect(saida).toMatch(/destino_e_de_membro.*t/);
  });

  it("primeiro salvamento: o número ainda está em `p_responsaveis`, não na coluna", () => {
    // A tela manda o WhatsApp na MESMA chamada que o grava, e a guarda roda
    // antes do laço que escreve `whatsapp_e164`. Olhar só a coluna deixaria o
    // primeiro salvamento pedindo confirmação — justamente o caso da issue.
    sql(
      `update public.user_organizations set whatsapp_e164 = null
        where user_id = '${ATENDENTE}' and organization_id = '${ORG}';`,
    );
    try {
      const saida = define({
        destino: NUMERO_DA_MEMBRO,
        modo: "responsavel",
        responsaveis: [{ user_id: ATENDENTE, whatsapp: NUMERO_DA_MEMBRO }],
      });
      expect(saida).toMatch(/destino_e_de_membro.*t/);
      // E a coluna foi gravada — a exceção não impediu o efeito normal.
      const depois = sql(
        `select coalesce(whatsapp_e164, 'nulo') from public.user_organizations
          where user_id = '${ATENDENTE}' and organization_id = '${ORG}';`,
      ).trim();
      expect(depois).toBe(NUMERO_DA_MEMBRO);
    } finally {
      sql(
        `update public.user_organizations set whatsapp_e164 = '${NUMERO_DA_MEMBRO}'
          where user_id = '${ATENDENTE}' and organization_id = '${ORG}';`,
      );
    }
  });

  it("membro REVOGADO não abre exceção — o número dele não recebe aviso", () => {
    const erro = erroDe(() => define({ destino: NUMERO_DE_CLIENTE, modo: "responsavel" }));
    expect(erro, "a exceção valeu para quem saiu da equipe").toMatch(
      /aviso_de_caso_numero_de_cliente/i,
    );
  });
});

describe("3900 — o que NÃO pode mudar", () => {
  it("cliente comum continua exigindo confirmação, e a recusa não grava nada", () => {
    const erro = erroDe(() =>
      define({ destino: NUMERO_DE_CLIENTE, modo: "responsavel" }),
    );
    expect(erro).toMatch(/aviso_de_caso_numero_de_cliente/i);

    // Passa com a confirmação explícita — e é por isso que a tela continua
    // perguntando para ele.
    const comConfirmacao = define({
      destino: NUMERO_DE_CLIENTE,
      modo: "responsavel",
      confirma: true,
    });
    expect(comConfirmacao).toMatch(/destino_e_de_membro.*f/);
    sql(
      `update public.config_aviso_de_caso set telefone_destino = '${NUMERO_DA_MEMBRO}'
        where organization_id = '${ORG}';`,
    );
  });

  it("`fixo` não muda: número que é contato continua exigindo confirmação", () => {
    // Em `fixo` o destino é o número da empresa e ele VIRA interno — a
    // consequência que a pergunta protege continua existindo.
    const erro = erroDe(() => define({ destino: NUMERO_DA_MEMBRO, modo: "fixo" }));
    expect(erro).toMatch(/aviso_de_caso_numero_de_cliente/i);
    sql(
      `update public.config_aviso_de_caso set telefone_destino = '${NUMERO_DA_MEMBRO}'
        where organization_id = '${ORG}';`,
    );
  });
});
