import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_VIEWER, GOV_CONV_UNASSIGNED, seedGov, sql } from "./gov-helpers";

/**
 * O SELETOR DE ETIQUETA TEM DE OFERECER AS ETIQUETAS QUE EXISTEM.
 *
 * ─── O defeito, medido na tela de uma instalação real ────────────────────────
 * `GET /api/v1/conversation-tags` lia apenas
 * `organizations.settings.canonical_conversation_tags` — uma lista curada à mão.
 * O seletor oferecia 8 etiquetas de semente, NENHUMA conversa tinha etiqueta,
 * filtrar por qualquer uma devolvia zero, e a etiqueta que a lista de conversas
 * EXIBIA não estava entre as 8.
 *
 * ─── ⛔ Por que este arquivo tem caso de isolamento, e ele é o mais importante ─
 * A primeira versão desta função nasceu `security definer` recebendo a
 * organização por ARGUMENTO e concedida a `authenticated`. Essa combinação é
 * leitura cross-tenant: qualquer pessoa logada chamaria o RPC com o uuid de outro
 * cliente. O próprio código do projeto já tinha escrito o aviso, no comentário de
 * `fn_gasto_de_ia_do_mes`.
 *
 * A função virou `security invoker` — e aí quem isola é a RLS de `conversations`.
 * Só que ISSO TROCA O GUARDIÃO: `hardening-definer-varredura` só varre funções
 * `definer`, e `definer-valida-membership` cobre uma lista FIXA de duas funções.
 * Nenhum dos dois alcança esta. Os casos 3 e 4 abaixo são o único gate dela.
 *
 * Vendemos tenants: uma organização ver dado de outra não é severidade alta, é o
 * fim do produto.
 */

const VIZINHA_ORG = "eeeeeeee-0000-4000-8000-000000000001";
const VIZINHA_CONTACT = "eeeeeeee-3333-4000-8000-000000000001";
const VIZINHA_SESSION = "eeeeeeee-2222-4000-8000-000000000001";
const VIZINHA_CONV = "eeeeeeee-4444-4000-8000-000000000001";

const TAG_DA_CASA = "etiqueta-em-uso-so-na-casa";
const TAG_DA_VIZINHA = "etiqueta-secreta-da-vizinha";
const TAG_QUE_NINGUEM_APLICOU = "etiqueta-que-ninguem-aplicou";

/**
 * Chama a função como um usuário autenticado de verdade, com JWT simulado.
 *
 * ⚠️ As linhas vêm MARCADAS. Sem a marca, o `psql -tA` devolve também a saída dos
 * comandos anteriores — `set role` imprime "SET" e `set_config` imprime as
 * claims — e esse ruído entra na lista como se fosse etiqueta. Medido: o caso de
 * isolamento reprovou por isso, e NÃO por vazamento. Os casos que usam
 * `toContain` toleram o ruído e passavam; só a comparação estrita o denunciou.
 */
function chamarComo(userId: string, org: string): string[] {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select 'TAG:' || tag from public.fn_tags_de_conversa_em_uso('${org}');
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("TAG:"))
    .map((l) => l.slice("TAG:".length));
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${VIZINHA_ORG}', 'viz-tags', 'Vizinha Tags Org', 'Vizinha Tags')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${VIZINHA_CONTACT}', '${VIZINHA_ORG}', 'Contato Vizinho')
      on conflict do nothing;
    -- Mesmas colunas que gov-helpers usa: webhook_secret_encrypted e NOT NULL.
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${VIZINHA_SESSION}', '${VIZINHA_ORG}', 'viz-tags-inv', '\\x00'::bytea)
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, tags)
      values ('${VIZINHA_CONV}', '${VIZINHA_ORG}', '${VIZINHA_CONTACT}', '${VIZINHA_SESSION}', 'open',
              array['${TAG_DA_VIZINHA}']::text[])
      on conflict (id) do update set tags = excluded.tags;

    update public.conversations
       set tags = array['${TAG_DA_CASA}']::text[]
     where id = '${GOV_CONV_UNASSIGNED}';
  `);
});

describe("fn_tags_de_conversa_em_uso — as etiquetas em uso, e só as da própria organização", () => {
  it("⭐ etiqueta aplicada a uma conversa aparece, mesmo fora do vocabulário canônico", () => {
    expect(chamarComo(GOV_VIEWER, GOV_ORG)).toContain(TAG_DA_CASA);
  });

  it("GUARDA DE VACUIDADE: etiqueta que ninguém aplicou NÃO aparece", () => {
    // Sem este caso, uma função que devolvesse o vocabulário inteiro (ou qualquer
    // lista fixa) passaria no de cima sem consultar conversa nenhuma.
    expect(chamarComo(GOV_VIEWER, GOV_ORG)).not.toContain(TAG_QUE_NINGUEM_APLICOU);
  });

  it("⛔ ISOLAMENTO: membro da organização A pede as etiquetas de B e recebe ZERO", () => {
    // Este é o caso que a versão `security definer` teria falhado — e ela passaria
    // em todos os outros. É o único gate desta função para vazamento entre clientes.
    const vazamento = chamarComo(GOV_VIEWER, VIZINHA_ORG);
    expect(vazamento).toEqual([]);
    expect(vazamento).not.toContain(TAG_DA_VIZINHA);
  });

  it("⛔ `anon` NÃO tem EXECUTE na função — perguntado ao catálogo", () => {
    // ⚠️ ESTE CASO JÁ PASSOU VERDE COM A FUNÇÃO EXPOSTA, duas vezes, por medir o
    // SINTOMA em vez do ESTADO:
    //
    //   1ª versão — "deu erro?": função inexistente também lança. Passava sem a
    //      função existir.
    //   2ª versão — "permission denied"? e depois "permission denied for
    //      function"? Removendo o `revoke` do baseline, os 4 continuavam verdes.
    //
    // Mensagem de erro depende de QUAL barreira o banco topa primeiro, e há mais
    // de uma. O catálogo não depende: ele diz se o privilégio existe.
    //
    // Isto importa porque a anon key vai para o browser, e porque a proteção da
    // TABELA não substitui a da FUNÇÃO — bastaria uma definer futura para a
    // barreira de tabela deixar de valer.
    const tem = sql(`
      select has_function_privilege(
        'anon', 'public.fn_tags_de_conversa_em_uso(uuid)', 'EXECUTE'
      );
    `).trim();
    expect(tem, "anon TEM execute na função — o `revoke` sumiu").toBe("f");
  });

  it("CONTROLE: `authenticated` TEM EXECUTE — o revoke não pode levar o legítimo junto", () => {
    // Sem este par, um `revoke ... from public, anon, authenticated` passaria no
    // caso de cima e quebraria o recurso para todo mundo.
    const tem = sql(`
      select has_function_privilege(
        'authenticated', 'public.fn_tags_de_conversa_em_uso(uuid)', 'EXECUTE'
      );
    `).trim();
    expect(tem, "authenticated perdeu execute — o filtro de tag para de funcionar").toBe("t");
  });
});
