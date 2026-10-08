/**
 * O ANEXO DA NOTA VIVA tem retenção por idade (#1887, opção A) —
 * `fn_enfileirar_midia_vencida`, passo 2c, contra o Postgres de verdade.
 *
 * O defeito: a 0483 tirou o bucket `internal-media` da varredura DE PROPÓSITO
 * (o varredor órfão apagaria a nota de amanhã) e o alcançava só quando a nota
 * SUMIA (passo 2b) ou sob pedido LGPD. Uma nota que continua existindo segurava
 * o anexo para sempre — e numa cota de 1 GB dividida com `whatsapp-media` o
 * bucket crescia sem teto, com anexos de até 50 MB. A opção escolhida é a (A):
 * o anexo interno segue a MESMA retenção da mídia de conversa, com o MESMO knob.
 *
 * Casos, um por modo de falha:
 *   - nota acima do knob → arquivo enfileirado com bucket `internal-media`
 *     (NUNCA `whatsapp-media`) e os três ponteiros da nota zerados — sem esta
 *     prova, o bucket volta a crescer para sempre;
 *   - nota DENTRO do knob → não enfileirada, ponteiro intacto: é o anexo de
 *     nota viva que esta issue manda NÃO apagar, e é a linha que reprova se a
 *     condição de idade sumir do passo 2c;
 *   - a idade é a da NOTA (a mesma medida do passo 1 na mensagem), não a do
 *     objeto: nota nova com arquivo velho não sai;
 *   - o knob é o da ORGANIZAÇÃO e o piso de 30 dias vale mesmo com knob menor;
 *   - arquivo já removido à mão não quebra a rodada (fila `pending`, sem erro);
 *   - a segunda rodada não reenfileira (idempotência, ponteiro já zerado).
 *
 * Banco próprio por arquivo de teste (issue #207): os fixtures deste arquivo
 * não conversam com os de `anexo-da-nota-interna-responde-a-lgpd.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GOV_CONV_UNASSIGNED, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const CONVERSA = GOV_CONV_UNASSIGNED;
const ORG = GOV_ORG;

const NOTA_VENCIDA = "43870000-0000-4000-8000-000000000001";
const NOTA_NOVA = "43870000-0000-4000-8000-000000000002";
const NOTA_SEM_ARQUIVO = "43870000-0000-4000-8000-000000000003";
const NOTA_FORA_DO_PISO = "43870000-0000-4000-8000-000000000004";

const ANEXO_VENCIDO = `${ORG}/${CONVERSA}/note-vencido.png`;
const ANEXO_NOVO = `${ORG}/${CONVERSA}/note-novo.png`;
const ANEXO_SUMIDO = `${ORG}/${CONVERSA}/note-sumido.png`;
const ANEXO_DENTRO_DO_PISO = `${ORG}/${CONVERSA}/note-piso.png`;

const conta = (q: string) => Number(lastLine(sql(q)));

/** Linha na fila de purga, com o bucket explicitado — o detalhe que importa. */
const naFila = (bucket: string, caminho: string) =>
  conta(
    `select count(*) from storage_redaction_queue where bucket = '${bucket}' and object_path = '${caminho}'`,
  );

/** O ponteiro da nota, com `NULL` textual para o `toBe` não confundir. */
const ponteiro = (id: string) =>
  lastLine(sql(`select coalesce(media_storage_path, 'NULL') from conversation_notes where id = '${id}';`));

function objeto(bucket: string, nome: string, idadeDias: number): string {
  return `insert into storage.objects (bucket_id, name, metadata, created_at)
          values ('${bucket}', '${nome}', '{"size": 1000}'::jsonb, now() - interval '${idadeDias} days');`;
}

/** A nota nasce COM idade — o que a mensagem faz pelo `created_at` da mensagem. */
function nota(id: string, caminho: string | null, idadeDias: number): string {
  return `insert into conversation_notes (id, organization_id, conversation_id, body, media_storage_path,
                                           media_mime, media_size_bytes, created_at)
          values ('${id}', '${ORG}', '${CONVERSA}', 'anotação viva', ${caminho === null ? "null" : `'${caminho}'`},
                  ${caminho === null ? "null" : "'image/png'"}, ${caminho === null ? "null" : "1000"},
                  now() - interval '${idadeDias} days');`;
}

const roda = () => JSON.parse(lastLine(sql(`select public.fn_enfileirar_midia_vencida(500)::text`)));

beforeEach(() => {
  seedGov();
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media')
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('internal-media', 'internal-media', false, 52428800)
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from storage.objects where name like '${ORG}/%';
    delete from conversation_notes where organization_id = '${ORG}';
    update organizations set media_retention_days = 60 where id = '${ORG}';
  `);
});

describe("anexo da nota interna — retenção por idade (0571, #1887)", () => {
  it("nota acima do knob vai para a fila com o bucket certo e os ponteiros zerados", () => {
    sql(`${nota(NOTA_VENCIDA, ANEXO_VENCIDO, 400)}${objeto("internal-media", ANEXO_VENCIDO, 400)}`);

    const r = roda();

    // Controle positivo: sem ele, uma função que não faz nada passaria nos "não saiu".
    expect(r.vencidas, "o anexo vencido conta como vencida — a chave não muda de nome").toBeGreaterThanOrEqual(1);
    expect(naFila("internal-media", ANEXO_VENCIDO), "anexo de nota viva acima do knob enfileirado").toBe(1);
    // Enfileirar em whatsapp-media apontaria a remoção para um bucket onde o
    // arquivo não está — é a mesma medida da F3 da #1863.
    expect(naFila("whatsapp-media", ANEXO_VENCIDO), "nunca vira mídia de conversa").toBe(0);
    // Retenção, não LGPD: linha sem pedido (request_id nulo).
    expect(
      lastLine(sql(`select count(*) from storage_redaction_queue
                     where bucket = 'internal-media' and object_path = '${ANEXO_VENCIDO}'
                       and request_id is null and status = 'pending';`)),
      "fila de retenção, não linha de pedido do titular",
    ).toBe("1");

    // A nota fica; o card não pode apontar para arquivo que já saiu.
    expect(ponteiro(NOTA_VENCIDA), "os três ponteiros zerados").toBe("NULL");
    expect(lastLine(sql(`select body from conversation_notes where id = '${NOTA_VENCIDA}';`))).toBe(
      "anotação viva",
    );
    expect(
      lastLine(sql(`select count(*) from conversation_notes
                     where id = '${NOTA_VENCIDA}' and media_mime is null and media_size_bytes is null;`)),
      "mime e tamanho zerados junto (mesmo que o passo 6d da 0483)",
    ).toBe("1");
  });

  it("nota DENTRO do knob não é tocada — o anexo de nota viva que a issue manda não apagar", () => {
    sql(`${nota(NOTA_NOVA, ANEXO_NOVO, 10)}${objeto("internal-media", ANEXO_NOVO, 10)}`);

    const r = roda();

    expect(naFila("internal-media", ANEXO_NOVO), "dentro da retenção, o arquivo fica").toBe(0);
    expect(ponteiro(NOTA_NOVA), "o ponteiro também fica").toBe(ANEXO_NOVO);
    expect(r.vencidas, "nada vencido nesta rodada").toBe(0);
  });

  it("a idade é a da NOTA, não a do objeto: nota nova com arquivo velho não sai", () => {
    // Os dois casos medem idades diferentes de propósito: se o passo 2c olhasse
    // `storage.objects.created_at`, o anexo de 400 dias sairia debaixo de uma
    // nota de 10 dias — e a mensagem que o passo 1 mede é a da LINHA, não a do
    // arquivo.
    sql(`${nota(NOTA_NOVA, ANEXO_NOVO, 10)}${objeto("internal-media", ANEXO_NOVO, 400)}`);

    roda();

    expect(naFila("internal-media", ANEXO_NOVO), "nota nova segura o arquivo").toBe(0);
    expect(ponteiro(NOTA_NOVA)).toBe(ANEXO_NOVO);
  });

  it("o knob é o da ORGANIZAÇÃO: com 60 dias, a de 100 sai e a de 40 fica", () => {
    sql(`
      ${nota(NOTA_VENCIDA, ANEXO_VENCIDO, 100)}
      ${nota(NOTA_NOVA, ANEXO_NOVO, 40)}
      ${objeto("internal-media", ANEXO_VENCIDO, 100)}
      ${objeto("internal-media", ANEXO_NOVO, 40)}
    `);

    const r = roda();

    expect(naFila("internal-media", ANEXO_VENCIDO), "100 dias > knob de 60").toBe(1);
    expect(naFila("internal-media", ANEXO_NOVO), "40 dias < knob de 60").toBe(0);
    expect(ponteiro(NOTA_VENCIDA), "a vencida perde o ponteiro").toBe("NULL");
    expect(ponteiro(NOTA_NOVA), "a de 40 dias mantém").toBe(ANEXO_NOVO);
    expect(r.vencidas).toBeGreaterThanOrEqual(1);
  });

  it("o piso de 30 dias segura a nota mesmo com o knob da organização em 5", () => {
    // O formulário já recusa abaixo de 30 (`lib/schemas/settings.ts`), mas o
    // banco não tem essa trava: quem grava à mão põe 5 e o piso do passo 1 é
    // o que vale — 20 dias não passa de 30.
    sql(`${nota(NOTA_FORA_DO_PISO, ANEXO_DENTRO_DO_PISO, 20)}${objeto("internal-media", ANEXO_DENTRO_DO_PISO, 20)}`);
    sql(`update organizations set media_retention_days = 5 where id = '${ORG}'`);
    expect(
      lastLine(sql(`select media_retention_days from organizations where id = '${ORG}';`)),
      "fixture: o knob está mesmo em 5",
    ).toBe("5");

    const r = roda();

    expect(naFila("internal-media", ANEXO_DENTRO_DO_PISO), "20 dias não passa do piso de 30").toBe(0);
    expect(ponteiro(NOTA_FORA_DO_PISO), "o ponteiro fica").toBe(ANEXO_DENTRO_DO_PISO);
    expect(r.vencidas).toBe(0);
  });

  it("arquivo já removido à mão não quebra a rodada", () => {
    // A nota vencida é a única coisa que existe: sem linha em
    // `storage.objects`, o passo 2c enfileira assim mesmo e o worker fecha a
    // linha como `skipped` — o mesmo destino de um objeto que sumiu no passo 1.
    sql(nota(NOTA_VENCIDA, ANEXO_SUMIDO, 400));

    const r = roda();

    expect(r.vencidas, "a rodada termina e conta o enfileiramento").toBeGreaterThanOrEqual(1);
    expect(naFila("internal-media", ANEXO_SUMIDO)).toBe(1);
    expect(ponteiro(NOTA_VENCIDA)).toBe("NULL");
  });

  it("a segunda rodada não enfileira de novo (idempotência)", () => {
    sql(`${nota(NOTA_VENCIDA, ANEXO_VENCIDO, 400)}${objeto("internal-media", ANEXO_VENCIDO, 400)}`);
    roda();

    const depois = roda();

    expect(depois.vencidas, "ponteiro zerado na primeira rodada — nada sobra").toBe(0);
    expect(naFila("internal-media", ANEXO_VENCIDO)).toBe(1);
    expect(
      lastLine(sql(`select count(*) from storage_redaction_queue
                     where bucket = 'internal-media' and object_path = '${ANEXO_VENCIDO}';`)),
      "uma linha só, não duas",
    ).toBe("1");
    expect(ponteiro(NOTA_VENCIDA)).toBe("NULL");
  });

  it("nota sem anexo e nota só com texto não geram fila nenhuma", () => {
    sql(nota(NOTA_SEM_ARQUIVO, null, 400));

    const r = roda();

    expect(naFila("internal-media", ANEXO_VENCIDO)).toBe(0);
    expect(r.vencidas).toBe(0);
    expect(lastLine(sql(`select count(*) from storage_redaction_queue;`))).toBe("0");
  });
});
