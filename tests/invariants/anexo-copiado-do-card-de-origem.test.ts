/**
 * ANEXO COPIADO DO CARD DE ORIGEM (#4544) — o vínculo e a idempotência, contra o
 * Postgres de verdade.
 *
 * O card criado em outro funil leva os anexos do card de origem, e a cópia ganha
 * LINHA PRÓPRIA sob o prefixo do card novo. O que o banco precisa garantir — e
 * este arquivo mede — é:
 *
 *   1. o vínculo com a linha de origem grava, e o MESMO anexo de origem pode
 *      estar em dois cards (duas clonagens do mesmo negócio);
 *   2. o mesmo par (card, anexo de origem) NÃO entra duas vezes: é o índice
 *      único parcial que faz a automação poder repetir a cópia sem duplicar;
 *   3. apagar a linha de origem NÃO apaga a cópia (o ponteiro vira nulo, a linha
 *      e o arquivo do card novo ficam) — o voucher do pós-venda é o que tem de
 *      sobreviver;
 *   4. a cópia continua sendo uma linha do PRÓPRIO card: o caminho preso ao
 *      `lead_id` da linha segue valendo (esta fatia NÃO afrouxou a invariante do
 *      `storage_path`, só acrescentou a coluna do vínculo).
 *
 * O caso 1 do roteiro da issue (o card novo com os mesmos anexos) é de aplicação
 * e mora em `lib/leads/anexos-do-clone.test.ts` e em
 * `lib/automation/actions/create-or-move-lead-anexos.test.ts`; aqui se mede o que
 * só o banco pode recusar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sql, lastLine } from "./gov-helpers";

const ORG = "4544a000-0000-4000-8000-00000000000a";
const FUNIL = "4544a000-2222-4000-8000-00000000000a";
const ETAPA = "4544a000-3333-4000-8000-00000000000a";
const LEAD_ORIGEM = "4544a000-4444-4000-8000-00000000000a";
const LEAD_DESTINO = "4544a000-4444-4000-8000-00000000000b";
const LEAD_OUTRO = "4544a000-4444-4000-8000-00000000000c";
const ANEXO_ORIGEM = "4544a000-5555-4000-8000-00000000000a";
const ANEXO_COPIA = "4544a000-5555-4000-8000-00000000000b";
const ANEXO_COPIA_OUTRO_CARD = "4544a000-5555-4000-8000-00000000000c";

const caminho = (lead: string, arquivo: string) => `${ORG}/leads/${lead}/voucher/${arquivo}`;

const INDICE = "crm_lead_attachments_clonado_unico";

/** stderr do script ('' se passou). */
function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

function insereCopia(id: string, lead: string, origemAnexoId: string | null): string {
  const vinculo = origemAnexoId ? `'${origemAnexoId}'` : "null";
  return erroDe(`
    insert into crm_lead_attachments
      (id, organization_id, lead_id, field_key, file_name, storage_path, clonado_do_attachment_id)
    values ('${id}', '${ORG}', '${lead}', 'voucher', 'apolice.pdf', '${caminho(lead, `${id}.pdf`)}', ${vinculo});
  `);
}

beforeAll(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name, settings)
    values ('${ORG}', 'anexo-copiado-4544', 'Anexo Copiado LTDA', 'Anexo Copiado', '{}'::jsonb)
    on conflict do nothing;
    insert into crm_pipelines (id, organization_id, name, slug)
    values ('${FUNIL}', '${ORG}', 'Experiência do Cliente', 'experiencia-4544')
    on conflict do nothing;
    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
    values ('${ETAPA}', '${ORG}', '${FUNIL}', 'Onboarding', 'onboarding-4544', 1000)
    on conflict do nothing;
    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, source)
    values
      ('${LEAD_ORIGEM}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Pacote Cancún', 'manual'),
      ('${LEAD_DESTINO}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Pacote Cancún (pós-venda)', 'manual'),
      ('${LEAD_OUTRO}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Outra clonagem', 'manual')
    on conflict do nothing;
  `);
});

beforeEach(() => {
  sql(`delete from crm_lead_attachments where organization_id = '${ORG}';`);
  // A linha da origem — sem vínculo, como toda linha que subiu direto no card.
  sql(`
    insert into crm_lead_attachments
      (id, organization_id, lead_id, field_key, file_name, file_size, mime_type, storage_path)
    values ('${ANEXO_ORIGEM}', '${ORG}', '${LEAD_ORIGEM}', 'voucher', 'apolice.pdf', 184320,
            'application/pdf', '${caminho(LEAD_ORIGEM, `${ANEXO_ORIGEM}.pdf`)}');
  `);
});

describe("crm_lead_attachments — o anexo copiado aponta para a linha de origem", () => {
  it("o vínculo grava, e o MESMO anexo de origem pode estar em dois cards", () => {
    expect(insereCopia(ANEXO_COPIA, LEAD_DESTINO, ANEXO_ORIGEM)).toBe("");
    expect(insereCopia(ANEXO_COPIA_OUTRO_CARD, LEAD_OUTRO, ANEXO_ORIGEM)).toBe("");

    const vinculos = sql(`
      select string_agg(lead_id::text || ':' || clonado_do_attachment_id::text, ',' order by lead_id)
        from crm_lead_attachments
       where organization_id = '${ORG}' and clonado_do_attachment_id is not null;
    `);
    expect(lastLine(vinculos)).toBe(
      `${LEAD_DESTINO}:${ANEXO_ORIGEM},${LEAD_OUTRO}:${ANEXO_ORIGEM}`,
    );
  });

  it("o MESMO par (card, anexo de origem) NÃO entra duas vezes — é a idempotência", () => {
    expect(insereCopia(ANEXO_COPIA, LEAD_DESTINO, ANEXO_ORIGEM)).toBe("");

    expect(insereCopia(ANEXO_COPIA_OUTRO_CARD, LEAD_DESTINO, ANEXO_ORIGEM)).toContain(INDICE);
    // e a linha que já estava continua sendo uma só
    expect(
      lastLine(
        sql(`select count(*) from crm_lead_attachments where lead_id = '${LEAD_DESTINO}';`),
      ),
    ).toBe("1");
  });

  it("anexo sem vínculo (upload direto no card) não é limitado pelo índice", () => {
    // Duas linhas com `clonado_do_attachment_id` nulo no MESMO card: o índice é
    // PARCIAL, e é isso que impede a catraca de travar todo upload normal.
    expect(insereCopia(ANEXO_COPIA, LEAD_DESTINO, null)).toBe("");
    expect(insereCopia(ANEXO_COPIA_OUTRO_CARD, LEAD_DESTINO, null)).toBe("");
  });

  it("apagar a linha de ORIGEM não apaga a cópia: o ponteiro vira nulo", () => {
    expect(insereCopia(ANEXO_COPIA, LEAD_DESTINO, ANEXO_ORIGEM)).toBe("");

    sql(`delete from crm_lead_attachments where id = '${ANEXO_ORIGEM}';`);

    const copia = sql(`
      select count(*)::text || '|' || coalesce(max(clonado_do_attachment_id::text), 'nulo')
        from crm_lead_attachments where id = '${ANEXO_COPIA}';
    `);
    expect(lastLine(copia)).toBe("1|nulo");
  });

  it("a cópia continua sendo linha do PRÓPRIO card: caminho de outro negócio é recusado", () => {
    // O caminho da ORIGEM em linha do DESTINO: a restrição do schema continua de
    // pé — esta fatia não a afrouxou, só acrescentou o vínculo.
    const erro = erroDe(`
      insert into crm_lead_attachments
        (id, organization_id, lead_id, field_key, file_name, storage_path, clonado_do_attachment_id)
      values ('${ANEXO_COPIA}', '${ORG}', '${LEAD_DESTINO}', 'voucher', 'apolice.pdf',
              '${caminho(LEAD_ORIGEM, `${ANEXO_ORIGEM}.pdf`)}', '${ANEXO_ORIGEM}');
    `);
    expect(erro).toContain("crm_lead_attachments_storage_path_check");
  });
});

/**
 * As cópias feitas na v1.111.0 (#4569) nasceram SEM o vínculo. A migration as
 * liga à origem: sem isso, a primeira reposição numa continuação daquela versão
 * copiaria cada arquivo de novo (medido na triagem: o dublê de
 * `copiarAnexosDoClone` com uma cópia sem vínculo no destino copiou 1, não 0).
 * A migration é reaplicada aqui, como o `update.sh` reaplica o baseline.
 */
describe("crm_lead_attachments — a cópia antiga, sem vínculo, é ligada à origem", () => {
  const MIGRATION = join(
    process.cwd(),
    "supabase",
    "migrations",
    "20261115043256_9387_anexo_copiado_do_card_de_origem.sql",
  );
  const ANEXO_MANUAL = "4544a000-5555-4000-8000-00000000000d";

  function anexoSemVinculo(id: string, lead: string, nome: string): void {
    sql(`
      insert into crm_lead_attachments
        (id, organization_id, lead_id, field_key, file_name, file_size, mime_type, storage_path)
      values ('${id}', '${ORG}', '${lead}', 'voucher', '${nome}', 184320,
              'application/pdf', '${caminho(lead, `${id}.pdf`)}');
    `);
  }

  function vinculoDe(id: string): string {
    return lastLine(
      sql(`select coalesce(clonado_do_attachment_id::text, 'nulo') from crm_lead_attachments where id = '${id}';`),
    );
  }

  it("liga a cópia do card que declara a origem, e só ela; reaplicar não muda nada", () => {
    sql(`
      update crm_leads set source_metadata = jsonb_build_object('clonado_de', jsonb_build_object('lead_id', '${LEAD_ORIGEM}'))
       where id = '${LEAD_DESTINO}';
      update crm_leads set source_metadata = '{}'::jsonb where id = '${LEAD_OUTRO}';
    `);
    anexoSemVinculo(ANEXO_COPIA, LEAD_DESTINO, "apolice.pdf");
    // Upload direto no card novo, com outro nome: não é cópia de nada.
    anexoSemVinculo(ANEXO_MANUAL, LEAD_DESTINO, "comprovante.pdf");
    // Mesmo arquivo num card que NÃO declara a origem: não se adivinha vínculo.
    anexoSemVinculo(ANEXO_COPIA_OUTRO_CARD, LEAD_OUTRO, "apolice.pdf");

    sql(readFileSync(MIGRATION, "utf8"));

    expect(vinculoDe(ANEXO_COPIA)).toBe(ANEXO_ORIGEM);
    expect(vinculoDe(ANEXO_MANUAL)).toBe("nulo");
    expect(vinculoDe(ANEXO_COPIA_OUTRO_CARD)).toBe("nulo");

    sql(readFileSync(MIGRATION, "utf8"));
    expect(vinculoDe(ANEXO_COPIA)).toBe(ANEXO_ORIGEM);
    expect(
      lastLine(sql(`select count(*) from crm_lead_attachments where organization_id = '${ORG}';`)),
    ).toBe("4");
  });
});
