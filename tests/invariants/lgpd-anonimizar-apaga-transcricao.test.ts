import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ANONIMIZAR APAGA A TRANSCRIÇÃO DA MÍDIA (migration 0497, triagem do #1988).
 *
 * `messages.media_derived_text` é o texto que o `media-derive-worker` tira da
 * mídia — a transcrição do áudio, o OCR da imagem. Até a 0497, a anonimização
 * trocava o body por '[mensagem anonimizada]' e deixava a transcrição legível,
 * e é ela que o agente lê do áudio (get-lead-context, inbound-turn…).
 *
 * Prova, no Postgres real e pelo COMPORTAMENTO:
 *   - a virada de is_anonymized (gatilho da 0391/0494, a porta dos dois
 *     caminhos) zera a transcrição das conversas do contato E das mensagens de
 *     grupo que ele escreveu;
 *   - o pedido formal (`fn_lgpd_cascade_redact_contact`) chega ao mesmo estado;
 *   - a mensagem de OUTRO contato da mesma org fica intacta;
 *   - a cura do apêndice (lida do `baseline.sql`, não copiada) alcança quem JÁ
 *     era anonimizado e poupa a mensagem nova de quem voltou a escrever.
 *
 * O passo 3 da RPC não tem prova por comportamento própria: a RPC vira
 * is_anonymized no passo 1 e o gatilho zera a coluna antes do passo 3. Quem
 * vigia aquela linha é o último caso deste arquivo, pelo corpo instalado.
 *
 * ─── Por que a régua por COLUNA mora aqui ───────────────────────────────────
 * `lgpd-redact-unificado-alcanca-pelo-catalogo` e
 * `lgpd-cascata-alcanca-quem-guarda-pessoa` decidem por TABELA: um comando em
 * `messages` basta para ela contar como coberta, e foi assim que esta coluna
 * passou meses legível com os dois verdes (o `PADRAO_PII` do segundo nem casa
 * `media_derived_text`). Os dois arquivos estão sob o congelamento de
 * `tests/invariants/**`, então a régua nova nasce aqui.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = randomUUID();
const SESSAO = randomUUID();
const ALVO = randomUUID(); // anonimizado pela virada direta (o UPDATE do botão)
const PELO_PEDIDO = randomUUID(); // anonimizado pela RPC do pedido formal
const VIZINHO = randomUUID(); // mesma org, NÃO anonimizado
const JA_ANONIMIZADO = randomUUID(); // anonimizado antes da 0497 — alvo da cura
const GRUPO = randomUUID(); // contato placeholder do grupo
const TELEFONE_DO_ALVO = "+5511987650497";

const conversaDe = new Map<string, string>();
const TRANSCRICAO = "oi, aqui é a Maria Souza, meu CPF é 52998224725";

async function audio(contato: string, body: string | null = null, metadata: object = {}) {
  const id = randomUUID();
  await q(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,
                          sent_via,body,media_storage_path,media_derived_text,media_derived_status,sent_at,metadata)
     values($1,$2,$3,$4,$5,'audio','inbound','delivered','external_device',$6,$7,$8,'ready',now(),$9::jsonb)`,
    [id, ORG, conversaDe.get(contato), SESSAO, contato, body, `${ORG}/${id}.ogg`, TRANSCRICAO, JSON.stringify(metadata)],
  );
  return id;
}

async function transcricao(id: string): Promise<string | null> {
  return (await q("select media_derived_text from messages where id=$1", [id])).rows[0].media_derived_text;
}

let doAlvo: string;
let doGrupo: string;
let doPedido: string;
let doVizinho: string;
let residuo: string;
let deQuemVoltou: string;

beforeAll(async () => {
  await q("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Transcrição LGPD','Transcrição LGPD')", [ORG]);
  await q(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'\\x00'::bytea)",
    [SESSAO, ORG],
  );
  for (const [id, nome, telefone] of [
    [ALVO, "Alvo", TELEFONE_DO_ALVO],
    [PELO_PEDIDO, "Pelo Pedido", "+5521911110497"],
    [VIZINHO, "Vizinho", "+5531922220497"],
  ] as const) {
    await q("insert into contacts(id,organization_id,name,display_name,phone_number) values($1,$2,$3,$3,$4)", [id, ORG, nome, telefone]);
  }
  // Já anonimizado ANTES da 0497: nasce com is_anonymized (o gatilho só dispara na virada).
  await q(
    "insert into contacts(id,organization_id,name,display_name,is_anonymized,anonymized_at) values($1,$2,'Cliente Anonimizado','Cliente Anonimizado',true,now())",
    [JA_ANONIMIZADO, ORG],
  );
  await q(
    "insert into contacts(id,organization_id,name,display_name,kind,source,source_metadata) values($1,$2,'Grupo','Grupo','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id','120363000000000497@g.us'))",
    [GRUPO, ORG],
  );
  for (const contato of [ALVO, PELO_PEDIDO, VIZINHO, JA_ANONIMIZADO, GRUPO]) {
    const conversa = randomUUID();
    conversaDe.set(contato, conversa);
    await q(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'open',$5)",
      [conversa, ORG, contato, SESSAO, contato === GRUPO],
    );
  }

  doAlvo = await audio(ALVO);
  doGrupo = await audio(GRUPO, null, { group_sender: { name: "Alvo", phone: TELEFONE_DO_ALVO, lid: null } });
  doPedido = await audio(PELO_PEDIDO);
  doVizinho = await audio(VIZINHO);
  // O estado que a main deixava: body redigido, transcrição legível.
  residuo = await audio(JA_ANONIMIZADO, "[mensagem anonimizada]");
  // Quem voltou a escrever depois de anonimizado (religado pelo LID): body de verdade.
  deQuemVoltou = await audio(JA_ANONIMIZADO, "voltei, quero o orçamento");
});

describe("LGPD: anonimizar apaga a transcrição da mídia (0497)", () => {
  it("antes: todas as mensagens guardam a transcrição — o experimento tem massa", async () => {
    for (const id of [doAlvo, doGrupo, doPedido, doVizinho, residuo, deQuemVoltou]) {
      expect(await transcricao(id)).toBe(TRANSCRICAO);
    }
  });

  it("⭐ a virada de is_anonymized zera a transcrição da conversa do contato E da mensagem de grupo dele", async () => {
    await q(
      `update contacts set name=null, display_name='Contato Anonimizado', phone_number=null,
         is_anonymized=true, anonymized_at=now(), updated_at=now()
       where organization_id=$1 and id=$2`,
      [ORG, ALVO],
    );
    expect(await transcricao(doAlvo)).toBeNull();
    expect(await transcricao(doGrupo)).toBeNull();
    const m = (await q("select body, media_derived_status from messages where id=$1", [doAlvo])).rows[0];
    expect(m.body).toBe("[mensagem anonimizada]");
    // O status é vocabulário, não conteúdo: é ele que diz ao drain que a derivação terminou.
    expect(m.media_derived_status).toBe("ready");
  });

  it("⭐ o pedido formal (fn_lgpd_cascade_redact_contact) chega ao mesmo estado", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,null)", [ORG, PELO_PEDIDO]);
    expect(await transcricao(doPedido)).toBeNull();
  });

  it("⭐ a mensagem de OUTRO contato da mesma org não é tocada", async () => {
    expect(await transcricao(doVizinho)).toBe(TRANSCRICAO);
  });

  it("⭐ a cura do apêndice alcança quem já era anonimizado e poupa quem voltou", async () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const bloco = baseline.slice(baseline.indexOf("(migration 0497) ----"));
    const cura = /update public\.messages set\s+media_derived_text = null,[\s\S]*?where body = '\[mensagem anonimizada\]'[\s\S]*?;/.exec(
      bloco.slice(0, bloco.indexOf("\n-- ---- ")),
    )?.[0];
    expect(cura, "a cura da 0497 não foi achada no apêndice do baseline").toBeTruthy();

    await q(cura!);

    expect(await transcricao(residuo)).toBeNull();
    expect(await transcricao(deQuemVoltou)).toBe(TRANSCRICAO);
    expect(await transcricao(doVizinho)).toBe(TRANSCRICAO);
  });

  it("⭐ todo UPDATE de messages que redige o body zera a transcrição, nos DOIS corpos instalados", async () => {
    for (const funcao of ["fn_lgpd_cascade_redact_contact", "fn_redigir_conversas_ao_anonimizar"]) {
      const { rows } = await q(
        "select pg_get_functiondef(p.oid) def from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace",
        [funcao],
      );
      expect(rows, `função ${funcao} não existe (ou existe em dobro) em public`).toHaveLength(1);
      const blocos = [...(rows[0].def as string).matchAll(/update\s+(?:public\.)?messages\s+set([\s\S]*?)\bwhere\b/gi)].map(
        (m) => m[1] ?? "",
      );
      expect(blocos.length, `nenhum UPDATE de messages em ${funcao} — a sonda ficou cega`).toBeGreaterThan(0);
      for (const bloco of blocos) {
        expect(bloco, `${funcao}: UPDATE de messages que redige o body e deixa a transcrição`).toContain(
          "[mensagem anonimizada]",
        );
        expect(bloco, `${funcao}: UPDATE de messages sem media_derived_text = null`).toMatch(
          /media_derived_text\s*=\s*null/,
        );
      }
    }
  });
});
