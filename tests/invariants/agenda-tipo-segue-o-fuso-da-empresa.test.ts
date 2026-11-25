import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O TIPO DE AGENDAMENTO SEGUE O FUSO DA EMPRESA (#5205).
 *
 * Defeito: `calendar_event_types.service_timezone` nasce em
 * 'America/Sao_Paulo' (default da coluna, sem criador passar o fuso) e nunca
 * acompanha `organizations.timezone`. A organização nasce em São Paulo e o fuso
 * certo chega depois por UPDATE (boas-vindas, Configurações > Empresa), então o
 * tipo fica em São Paulo para sempre.
 *
 * As três peças da migration 9477 (aberta como 9469 no #5216):
 *  (a) backfill idempotente dos tipos já semeados (roda uma vez);
 *  (b) trigger BEFORE INSERT que herda o fuso da empresa ao criar o tipo;
 *  (c) trigger AFTER UPDATE OF timezone que propaga a troca de fuso da empresa
 *      para os tipos que ainda estavam no fuso antigo, sem falhar por serviço
 *      ativo sem programação (exceção 22023 capturada linha a linha).
 *
 * O teste tem de FALHAR sem a migration (casos 1, 2, 3, 4 e 6 dependem dos
 * gatilhos). Nomes em PT-BR, UUIDs fixos próprios, fusos permitidos:
 * America/Manaus, America/Recife, America/Sao_Paulo, Europe/Berlin.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

// UUIDs fixos próprios, formato exigido, não colidem com outros testes de invariante.
const ORG_SEM_FUSO = "5eed0000-0000-4000-8000-000000000020"; // nasce em São Paulo (padrão)
const ORG_JA_COM_FUSO = "5eed0000-0000-4000-8000-000000000021"; // nasce Manaus
const ORG_TIPO_NOVO = "5eed0000-0000-4000-8000-000000000022"; // Manaus, insere tipo sem fuso
const ORG_BERLIM = "5eed0000-0000-4000-8000-000000000023"; // Manaus + tipo Berlim
const ORG_INVALIDO = "5eed0000-0000-4000-8000-000000000024"; // Nao/Existe
const ORG_GUARDA = "5eed0000-0000-4000-8000-000000000025"; // Manaus, tipo ativo sem programacao
const ORG5_MAN = "5eed0000-0000-4000-8000-000000000026"; // Manaus, update para fuso invalido

function fusos(org: string): string[] {
  return sql(`select service_timezone from public.calendar_event_types
               where organization_id = '${org}' order by service_timezone;`)
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function fusoDaOrg(org: string): string {
  return sql(`select timezone from public.organizations where id = '${org}';`);
}

beforeAll(() => {
  sql(`insert into public.organizations (id, slug, legal_name, display_name)
       values ('${ORG_SEM_FUSO}', 'fuso-5205-sem-fuso', 'Org Sem Fuso', 'Org Sem Fuso')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG_JA_COM_FUSO}', 'fuso-5205-ja-com-fuso', 'Org Ja Com Fuso', 'Org Ja Com Fuso', 'America/Manaus')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG_TIPO_NOVO}', 'fuso-5205-tipo-novo', 'Org Tipo Novo', 'Org Tipo Novo', 'America/Manaus')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG_BERLIM}', 'fuso-5205-berlim', 'Org Berlim', 'Org Berlim', 'America/Manaus')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG_INVALIDO}', 'fuso-5205-invalido', 'Org Invalido', 'Org Invalido', 'Nao/Existe')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG_GUARDA}', 'fuso-5205-guarda', 'Org Guarda', 'Org Guarda', 'America/Manaus')
       on conflict (id) do nothing;`);
  sql(`insert into public.organizations (id, slug, legal_name, display_name, timezone)
       values ('${ORG5_MAN}', 'fuso-5205-manaus', 'Org5 Manaus', 'Org5 Manaus', 'America/Manaus')
       on conflict (id) do nothing;`);
});

describe("o tipo de agendamento segue o fuso da empresa", () => {
  it("caso 1: org nasce sem fuso (São Paulo); os 3 tipos estão em SP; update para Manaus passa os 3 a Manaus", () => {
    // sem a migration: tipos semeados ficam em São Paulo para sempre
    expect(fusos(ORG_SEM_FUSO)).toEqual(["America/Sao_Paulo", "America/Sao_Paulo", "America/Sao_Paulo"]);
    sql(`update public.organizations set timezone = 'America/Manaus' where id = '${ORG_SEM_FUSO}'`);
    // sem a migration: não há gatilho de propagação, os 3 continuam em São Paulo
    expect(fusos(ORG_SEM_FUSO)).toEqual(["America/Manaus", "America/Manaus", "America/Manaus"]);
  });

  it("caso 2: org já nasce com America/Manaus; os 3 tipos semeados nascem em Manaus", () => {
    // sem a migration: fn_semear_tipos_de_agendamento não passa service_timezone => default São Paulo
    expect(fusos(ORG_JA_COM_FUSO)).toEqual(["America/Manaus", "America/Manaus", "America/Manaus"]);
  });

  it("caso 3: tipo novo inserido sem service_timezone numa org Manaus herda America/Manaus", () => {
    // sem a migration: o insert herda o default da coluna, America/Sao_Paulo
    sql(`insert into public.calendar_event_types (organization_id, name, slug, category, duration_minutes, position)
         values ('${ORG_TIPO_NOVO}', 'Consulta nova', 'consulta-nova', 'consulta', 30, 1000);`);
    const f = sql(`select service_timezone from public.calendar_event_types
                    where organization_id = '${ORG_TIPO_NOVO}' and slug = 'consulta-nova';`);
    expect(f).toBe("America/Manaus");
  });

  it("caso 4: tipo colocado à mão em Europe/Berlim continua Berlim quando a empresa troca para America/Recife; os de Manaus viram Recife", () => {
    // sem a migration: não há gatilho de propagação, nada muda
    sql(`insert into public.calendar_event_types (organization_id, name, slug, category, duration_minutes, position, service_timezone)
         values ('${ORG_BERLIM}', 'Reuniao Berlim', 'reuniao-berlim', 'reuniao', 30, 1000, 'Europe/Berlin');`);
    sql(`update public.organizations set timezone = 'America/Recife' where id = '${ORG_BERLIM}';`);
    const berlim = sql(`select service_timezone from public.calendar_event_types
                         where organization_id = '${ORG_BERLIM}' and slug = 'reuniao-berlim';`);
    expect(berlim).toBe("Europe/Berlin");
    // sem a migration: os 3 semeados continuam em Manaus
    expect(fusos(ORG_BERLIM).sort()).toEqual(["America/Recife", "America/Recife", "America/Recife", "Europe/Berlin"]);
  });

  it("caso 5a: fuso invalido Nao/Existe; tipo novo numa org com Nao/Existe nasce America/Sao_Paulo sem erro", () => {
    sql(`insert into public.calendar_event_types (organization_id, name, slug, category, duration_minutes, position)
         values ('${ORG_INVALIDO}', 'Tipo invalido', 'tipo-invalido', 'outro', 30, 1000);`);
    const f = sql(`select service_timezone from public.calendar_event_types
                    where organization_id = '${ORG_INVALIDO}' and slug = 'tipo-invalido';`);
    expect(f).toBe("America/Sao_Paulo");
  });

  it("caso 5b: fuso inválido; update org em Manaus para Nao/Existe não falha e não muda os tipos", () => {
    sql(`update public.organizations set timezone = 'Nao/Existe' where id = '${ORG5_MAN}';`);
    // sem a migration: também não muda, mas o ponto é que a migration não lança nem propaga um fuso inválido
    expect(fusos(ORG5_MAN)).toEqual(["America/Manaus", "America/Manaus", "America/Manaus"]);
  });

  it("caso 6: serviço ativo sem programação (guarda recusa 22023); troca de fuso da empresa não falha, o tipo guarda fica no fuso antigo, os outros acompanham", () => {
    // INSERT passa: o guarda só dispara em UPDATE (ou INSERT com auth.uid() set)
    sql(`insert into public.calendar_event_types (organization_id, name, slug, category, duration_minutes, position, service_enabled, is_active)
         values ('${ORG_GUARDA}', 'Ativo sem programa', 'ativo-sem-programa', 'consulta', 30, 1000, true, true);`);
    sql(`update public.organizations set timezone = 'America/Recife' where id = '${ORG_GUARDA}';`);
    // sem a migration: o UPDATE da organização não falha (não há gatilho), mas nenhum tipo acompanha
    expect(fusoDaOrg(ORG_GUARDA)).toBe("America/Recife");
    const guarda = sql(`select service_timezone from public.calendar_event_types
                         where organization_id = '${ORG_GUARDA}' and slug = 'ativo-sem-programa';`);
    expect(guarda).toBe("America/Manaus");
    // sem a migration: os 3 semeados continuam em Manaus
    const semeados = sql(`select service_timezone from public.calendar_event_types
                           where organization_id = '${ORG_GUARDA}' and slug in ('consulta','reuniao','atendimento')
                           order by service_timezone;`);
    expect(semeados.split("\n").map((s) => s.trim()).filter(Boolean).sort()).toEqual([
      "America/Recife",
      "America/Recife",
      "America/Recife",
    ]);
  });
});
