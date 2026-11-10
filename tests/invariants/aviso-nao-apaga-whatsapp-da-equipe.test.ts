/**
 * A TELA QUE NÃO MOSTROU NÃO PODE APAGAR O WHATSAPP DA EQUIPE (#3935).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * `config_aviso_de_caso` tem uma linha por organização, e o `PUT` da tela
 * reescreve os números da equipe na MESMA transação. Quando não existia
 * configuração salva, o rascunho da tela voltava com o mapa de números vazio
 * (`AvisoNoWhatsApp.tsx`, ramo `!estado.config`), os campos apareciam em branco
 * e o corpo mandava a lista COMPLETA da equipe com `whatsapp: null` para todo
 * mundo. A função lia `v_item ->> 'whatsapp'`, que devolve SQL NULL tanto para
 * "a chave não existe" quanto para "a chave vale null", e gravava
 * `whatsapp_e164 = null` nos dois casos.
 *
 * Sequência da issue, sem nada de laboratório: configurar o aviso, remover a
 * configuração (`DELETE`), abrir a tela de novo e salvar. Quem tinha cadastrado
 * o próprio WhatsApp precisava cadastrar outra vez, e ninguém era avisado.
 *
 * ─── A régua que este arquivo fixa ─────────────────────────────────────────
 *
 * · chave `whatsapp` AUSENTE no elemento = a tela não falou deste membro →
 *   NÃO MEXE. É o que torna o salvamento seguro quando a tela não exibiu a
 *   pessoa (leitura da equipe que falhou, rascunho antigo, lista parcial);
 * · `whatsapp: null` = AFIRMAÇÃO de vazio → APAGA. O gesto de limpar o número
 *   que a pessoa viu continua funcionando — a correção não pode transformar
 *   "não dá para limpar" em regra;
 * · `p_responsaveis` nulo (o corpo nem trouxe a equipe) → não mexe;
 * · lista VAZIA → não mexe. De propósito NÃO é "apaga todos": a leitura da
 *   equipe é falha ABERTA em `lib/escalacao/tela-do-aviso.ts` (quando o
 *   `select` erra, a tela recebe a equipe vazia e `equipe_indisponivel`), e
 *   uma lista vazia que apagasse transformaria um erro de leitura em perda
 *   de dado da equipe inteira.
 *
 * ─── Sabotagem ─────────────────────────────────────────────────────────────
 *
 * · trocar `if not (v_item ? 'whatsapp')` por um `coalesce` no valor → o
 *   primeiro caso cai (chave ausente volta a apagar);
 * · aceitar `p_responsaveis = '[]'` como "apaga todos" → o quarto caso cai;
 * · só gravar quando o número não é nulo → o caso do número novo cai.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG = "7f000000-0000-4000-8000-000000003935";
const ADMIN = "7f000000-0000-4000-8000-000000003951";
const ATENDENTE = "7f000000-0000-4000-8000-000000003952";
const SESSAO = "7f000000-0000-4000-8000-000000003953";

/** O celular pessoal da atendente, já gravado em `user_organizations`. */
const NUMERO_DA_EQUIPE = "+5531988883935";
/** O número que recebe os avisos (o da empresa / do plantão). */
const NUMERO_DO_AVISO = "+5531977773935";
/** Um segundo número, para provar que trocar número continua trocando. */
const NUMERO_NOVO = "+5531966663935";

function comoAdmin(): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${ADMIN}"}', false);`;
}

/**
 * A chamada da tela, com os dez parâmetros. `responsaveis` entra como texto
 * jsonb, e um `string` cru é aceito para os casos que precisam de `null` ou de
 * uma lista vazia explícita.
 */
function define(responsaveis: string): string {
  return sql(
    `${comoAdmin()}
     select public.fn_definir_aviso_de_caso(
       '${ORG}', '${SESSAO}', '${NUMERO_DO_AVISO}', null, true, false, false, 'responsavel',
       ${responsaveis}
     );`,
  ).trim();
}

/** O que está GRAVADO no vínculo da atendente agora. */
function numeroGravado(): string {
  return sql(
    `select coalesce(whatsapp_e164, '<null>')
       from public.user_organizations
      where organization_id = '${ORG}' and user_id = '${ATENDENTE}';`,
  );
}

/** Devolve o vínculo ao estado de partida: a atendente com o número gravado. */
function comONumeroGravado(): void {
  sql(`update public.user_organizations
          set whatsapp_e164 = '${NUMERO_DA_EQUIPE}'
        where organization_id = '${ORG}' and user_id = '${ATENDENTE}';`);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN}',     'aviso-3935-admin@invariant.test'),
      ('${ATENDENTE}', 'aviso-3935-atendente@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'aviso-3935', 'Aviso 3935', 'Aviso 3935')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at, whatsapp_e164) values
      ('${ADMIN}',     '${ORG}', 'admin', now(), null),
      ('${ATENDENTE}', '${ORG}', 'agent', now(), '${NUMERO_DA_EQUIPE}')
      on conflict do nothing;

    -- DO + exception e não ON CONFLICT: channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'aviso-3935', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
  `);
});

describe("3935 — o WhatsApp da equipe sobrevive ao salvamento que não o mostrou", () => {
  it("RED do defeito: configurar, remover a configuração e salvar de novo sem os números", () => {
    comONumeroGravado();

    // 1. a instalação configura o aviso — a atendente já tem WhatsApp gravado;
    define(`'[{"user_id":"${ATENDENTE}","whatsapp":"${NUMERO_DA_EQUIPE}"}]'::jsonb`);
    expect(numeroGravado()).toBe(NUMERO_DA_EQUIPE);

    // 2. a pessoa REMOVE a configuração (o `DELETE` da tela #3338);
    sql(`delete from public.config_aviso_de_caso where organization_id = '${ORG}';`);

    // 3. abre a tela de novo e salva SEM os números (rascunho que não carregou
    //    a equipe não manda a chave `whatsapp`). Antes desta entrega o corpo
    //    mandava `null` para todos e o número virava nulo aqui.
    define(`'[{"user_id":"${ATENDENTE}"}]'::jsonb`);

    expect(
      numeroGravado(),
      "o salvamento apagou o WhatsApp de quem a tela não mostrou",
    ).toBe(NUMERO_DA_EQUIPE);
  });

  it("o lado oposto: apagar de propósito (`whatsapp: null`) AINDA apaga", () => {
    comONumeroGravado();
    expect(numeroGravado()).toBe(NUMERO_DA_EQUIPE);

    // A pessoa viu o número e limpou o campo: a tela manda `null` e o banco
    // apaga. A correção do #3935 não pode tornar impossível limpar.
    define(`'[{"user_id":"${ATENDENTE}","whatsapp":null}]'::jsonb`);

    expect(numeroGravado()).toBe("<null>");
  });

  it("lista vazia e lista ausente não mexem em ninguém", () => {
    comONumeroGravado();

    // `p_responsaveis` nulo: o corpo nem trouxe a equipe.
    define("null");
    expect(numeroGravado()).toBe(NUMERO_DA_EQUIPE);

    // Lista vazia explícita: nenhum membro mencionado. NÃO é "apaga todos" — é
    // o que a tela manda quando a leitura da equipe falhou (falha aberta).
    define("'[]'::jsonb");
    expect(numeroGravado()).toBe(NUMERO_DA_EQUIPE);
  });

  it("trocar o número continua gravando o número novo", () => {
    comONumeroGravado();

    define(`'[{"user_id":"${ATENDENTE}","whatsapp":"${NUMERO_NOVO}"}]'::jsonb`);

    expect(numeroGravado()).toBe(NUMERO_NOVO);
  });
});
