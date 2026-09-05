import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O CPF GUARDADO NUM CAMPO PERSONALIZADO NÃO SOBREVIVE À ANONIMIZAÇÃO.
 *
 * ─── O defeito que este arquivo previne ─────────────────────────────────────
 *
 * `contacts.custom_fields` (migration 0206) é campo LIVRE num registro de pessoa
 * física. O primeiro uso que um operador de clínica ou de escritório dá a um
 * campo chamado "documento" é escrever o CPF nele — não é hipótese, é o motivo
 * de a coluna existir.
 *
 * A cascata de LGPD percorre uma lista escrita à mão. Ela limpa
 * `crm_leads.custom_fields` desde sempre, e passaria BATIDO no do contato: o
 * sistema responderia "anonimizado" a um pedido do titular, marcaria o SLA de
 * D+15 como cumprido, e o CPF continuaria legível no banco. Falha silenciosa, no
 * direito que tem prazo legal.
 *
 * ─── Por que o gatilho é no ESTADO, e por que o teste cobre OS DOIS caminhos ──
 *
 * Há mais de um jeito de anonimizar um contato neste produto:
 *
 *   fn_lgpd_cascade_redact_contact          o cascade completo
 *   app/api/v1/lgpd/anonymize/route.ts:104  a rota direta, que faz UPDATE
 *                                           próprio e nem limpa consent/tags
 *
 * Pendurar a limpeza numa das duas deixa a outra vazando — é a razão que o bloco
 * `trg_contacts_anonimizado_limpa_propostas` já registrou neste baseline. Por
 * isso a limpeza é um gatilho em `is_anonymized`, e por isso o segundo caso aqui
 * NÃO chama a função da cascata: ele reproduz o UPDATE da rota direta.
 *
 * ─── A metade que impede o "conserto" fácil ─────────────────────────────────
 *
 * Um gatilho que zerasse `custom_fields` em TODO update deixaria os dois casos
 * de cima verdes e apagaria, em silêncio, o dado de todo contato salvo pela
 * tela. Os dois últimos casos existem para isso: edição normal preserva, e o
 * contato do vizinho não é tocado.
 *
 * A coluna é achado de @prevprocesso-maker no PR #465; esta metade foi
 * acrescentada na triagem, porque a cascata não conhecia o campo novo.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "0206cf00-0000-4000-8000-00000000000a";
const VIA_CASCATA = "0206cf00-2222-4000-8000-000000000001";
const VIA_ROTA = "0206cf00-2222-4000-8000-000000000002";
const VIZINHO = "0206cf00-2222-4000-8000-000000000003";

/** O que um operador de clínica escreve num campo chamado "documento". */
const CPF = "529.982.247-25";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-campos-0206', 'LGPD Campos', 'LGPD Campos')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, custom_fields) values
      ('${VIA_CASCATA}', '${ORG}', 'Maria Silva',  '{"documento":"${CPF}","convenio":"Unimed"}'::jsonb),
      ('${VIA_ROTA}',    '${ORG}', 'Joao Pereira', '{"documento":"${CPF}","convenio":"Unimed"}'::jsonb),
      ('${VIZINHO}',     '${ORG}', 'Ana Souza',    '{"documento":"${CPF}","convenio":"Unimed"}'::jsonb)
      on conflict (id) do nothing;
  `);
});

function campos(contato: string): string {
  return sql(`select custom_fields::text from public.contacts where id = '${contato}';`);
}

describe("a anonimização alcança contacts.custom_fields", () => {
  it("ANTES: o documento está legível nos três (controle positivo)", () => {
    // Sem isto, uma fixture que não gravou nada deixaria todo o resto verde por
    // não haver o que apagar.
    for (const c of [VIA_CASCATA, VIA_ROTA, VIZINHO]) {
      expect(campos(c)).toContain(CPF);
    }
  });

  it("⭐ pelo CASCADE: anonimizar limpa os campos personalizados", () => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${VIA_CASCATA}', gen_random_uuid());`);
    expect(campos(VIA_CASCATA)).toBe("{}");
    // E o resto da anonimização aconteceu — senão o `{}` poderia vir de a
    // função ter abortado antes de fazer qualquer coisa.
    expect(
      sql(`select is_anonymized::text from public.contacts where id = '${VIA_CASCATA}';`),
    ).toBe("true");
  });

  it("⭐ pela ROTA DIRETA: o mesmo UPDATE de /api/v1/lgpd/anonymize também limpa", () => {
    // Este é o caso que uma linha dentro da função da cascata NÃO cobriria. A
    // rota faz o próprio UPDATE e não menciona `custom_fields` — quem limpa é o
    // gatilho, pendurado no FATO de `is_anonymized` virar true.
    sql(`
      update public.contacts set
        name = null,
        display_name = 'Contato Anonimizado #0206',
        email = null,
        phone_number = null,
        cpf_encrypted = null,
        cpf_hash = null,
        birthdate = null,
        is_anonymized = true,
        anonymized_at = now(),
        updated_at = now()
      where id = '${VIA_ROTA}';
    `);
    expect(campos(VIA_ROTA)).toBe("{}");
  });

  it("edição normal PRESERVA os campos — o gatilho não é um apagador geral", () => {
    // Sem este caso, `new.custom_fields := '{}'` sem a cláusula `when` ficaria
    // verde acima e apagaria o dado de todo contato salvo pela tela.
    sql(`update public.contacts set name = 'Ana Souza Lima' where id = '${VIZINHO}';`);
    expect(campos(VIZINHO)).toContain(CPF);
  });

  it("anonimizar um contato não toca no campo do vizinho", () => {
    expect(campos(VIZINHO)).toContain("Unimed");
  });

  it("a coluna recusa valor que não é objeto", () => {
    // O CHECK existe para que o TypeScript possa tratar a coluna como
    // `Record<string, unknown>` sem conferir a cada leitura.
    expect(() =>
      sql(`update public.contacts set custom_fields = '[]'::jsonb where id = '${VIZINHO}';`),
    ).toThrow();
  });
});
