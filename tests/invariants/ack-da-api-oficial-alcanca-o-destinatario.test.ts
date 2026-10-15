import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * #2937 — o entregue e o lido da API OFICIAL alcançam o destinatário da campanha.
 *
 * ═══ O DEFEITO, E POR QUE ELE SÓ APARECE NO CANAL OFICIAL ═══
 *
 * `fn_campanha_sincroniza_ack` foi escrita para o canal NÃO oficial, onde cada
 * ack é uma TRANSIÇÃO de `messages.status` (`ack >= 2` grava `delivered_at` e o
 * status; `ack >= 3` idem para `read`) e o gatilho `after update of status`
 * bastava. O canal oficial não muda o status: `lib/channels/meta/status-update.ts`
 * mantém o domínio colapsado em `sent | failed` de propósito — é o que o resto
 * do produto lê — e joga a informação fina em `delivered_at` / `read_at`. Com o
 * gatilho escutando só o status e a função saindo cedo em `new.status is not
 * distinct from old.status`, o ack de entrega e leitura de uma campanha enviada
 * pela API oficial morria ali: os carimbos do destinatário ficavam nulos para
 * sempre e as taxas de entrega/leitura da campanha, zeradas.
 *
 * ═══ O QUE ESTES CASOS MEDEM (no Postgres de verdade, não lendo SQL) ═══
 *
 *  - o `update` que a Cloud API faz quando a Meta confirma entrega/leitura —
 *    `status` inalterado (`sent`) e o carimbo novo — chega ao destinatário, e o
 *    destinatário atravessa `sent → delivered → read`;
 *  - `read` sem `delivered` antes (a Meta não garante a ordem) entrega os DOIS
 *    carimbos: quem foi lido foi entregue;
 *  - o caminho do canal não oficial segue idêntico: transição de status resolve;
 *  - a falha (`status='failed'` + motivo) continua gravando código e detalhe;
 *  - e o custo: um `update` que não toca `status`, `delivered_at` nem `read_at`
 *    NÃO sincroniza nada — a lista de colunas do gatilho é a mínima do ack.
 *
 * A guarda que sustenta o último caso é o `if` de saída da função: com os três
 * fatos iguais ela devolve `new` sem escrever. O caso do `updated_at` é o que
 * prova isso — sem ele, um gatilho `after update` sem lista de colunas
 * sincronizaria a cada `update` da mensagem e o teste não sentiria.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "29370000-0000-4000-8000-000000002937";
/** O número pelo qual a campanha sai — um só: o teste mede o ack, não o canal. */
const SESSAO = "29370000-1111-4000-8000-000000002937";

type Envio = { campanha: string; mensagem: string };

/**
 * Monta o caminho inteiro de um envio de campanha: contato, conversa, campanha,
 * a mensagem (já `sent`, como a Cloud API a deixa quando a Meta ACEITA o
 * template) e o destinatário apontando para ela.
 *
 * Ids aleatórios por caso porque `campaign_recipients` tem duas unicidades por
 * campanha (contato e endereço) e cada caso aqui quer o seu destinatário limpo.
 */
async function montarEnvio(rotulo: string): Promise<Envio> {
  const contato = randomUUID();
  const conversa = randomUUID();
  const campanha = randomUUID();
  const mensagem = randomUUID();

  await pool.query("insert into contacts (id, organization_id, display_name) values ($1, $2, $3)", [
    contato,
    ORG,
    rotulo,
  ]);
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [conversa, ORG, contato, SESSAO],
  );
  await pool.query(
    `insert into campaigns (id, organization_id, name, channel_session_id, base_legal, status)
     values ($1, $2, $3, $4, 'consent', 'running')`,
    [campanha, ORG, rotulo, SESSAO],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'outbound', 'sent', 'user', now())`,
    [mensagem, ORG, conversa, SESSAO, contato],
  );
  await pool.query(
    `insert into campaign_recipients (organization_id, campaign_id, contact_id, status, eligibility_status, message_id)
     values ($1, $2, $3, 'sending', 'eligible', $4)`,
    [ORG, campanha, contato, mensagem],
  );

  return { campanha, mensagem };
}

type Destinatario = {
  status: string;
  entregue: boolean;
  lido: boolean;
  codigo: string | null;
  detalhe: string | null;
  atualizado: string;
};

async function destinatarioDe(campanha: string): Promise<Destinatario> {
  const { rows } = await pool.query<Destinatario>(
    `select status,
            delivered_at is not null as entregue,
            read_at is not null as lido,
            last_error_code as codigo,
            last_error_detail as detalhe,
            updated_at::text as atualizado
       from campaign_recipients where campaign_id = $1`,
    [campanha],
  );
  const linha = rows[0];
  if (!linha) throw new Error(`campanha ${campanha} ficou sem destinatário`);
  return linha;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-ack-2937', 'Ack 2937 LTDA', 'Ack 2937') on conflict (id) do nothing`,
    [ORG],
  );
  // `on conflict (id)`: o arbiter é a PK — com o arbiter explícito o unique
  // DEFERRABLE (phone_per_org) não atrapalha, e este arquivo roda num banco só
  // seu (o setupFile recria o banco por arquivo).
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, 'ack-2937', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("#2937 — o ack da campanha alcança o destinatário", () => {
  it("entregue e lido da API OFICIAL, com `messages.status` inalterado, chegam ao destinatário", async () => {
    const { campanha, mensagem } = await montarEnvio("Ack pela API oficial");

    // 1. A Meta ACEITA o template: o status muda `sending → sent`. O gatilho já
    //    cobria este passo — ele continua aqui porque é o começo real do caminho.
    await pool.query("update messages set status = 'sent' where id = $1", [mensagem]);
    // 2. ENTREGUE: é exatamente o que `statusUpdate` grava — `status` segue
    //    `sent`, e a informação fina vai para o carimbo.
    await pool.query("update messages set status = 'sent', delivered_at = now() where id = $1", [mensagem]);

    let destino = await destinatarioDe(campanha);
    // ⬇ VEM VERMELHO na main: sem o conserto o destinatário fica `sent` com os
    //   dois carimbos nulos, porque o gatilho não dispara para `delivered_at` e a
    //   função saía no `if` do status.
    expect(destino.entregue).toBe(true);
    expect(destino.status).toBe("delivered");

    // 3. LIDO: idem — o status NÃO muda de novo.
    await pool.query(
      "update messages set status = 'sent', delivered_at = coalesce(delivered_at, now()), read_at = now() where id = $1",
      [mensagem],
    );

    destino = await destinatarioDe(campanha);
    expect(destino.lido).toBe(true);
    expect(destino.status).toBe("read");
  });

  it("`read` sem `delivered` antes entrega os DOIS carimbos (a Meta não garante a ordem)", async () => {
    const { campanha, mensagem } = await montarEnvio("Lido sem entregue");

    await pool.query("update messages set status = 'sent', read_at = now() where id = $1", [mensagem]);

    const destino = await destinatarioDe(campanha);
    expect(destino.lido).toBe(true);
    // Quem foi lido foi entregue: o carimbo de entrega é derivado do mesmo ack.
    expect(destino.entregue).toBe(true);
    expect(destino.status).toBe("read");
  });

  it("o caminho do canal NÃO oficial continua igual: a transição de `status` resolve sozinha", async () => {
    const { campanha, mensagem } = await montarEnvio("Ack pelo canal não oficial");

    await pool.query("update messages set status = 'delivered', delivered_at = now(), ack = 2 where id = $1", [
      mensagem,
    ]);
    let destino = await destinatarioDe(campanha);
    expect(destino.entregue).toBe(true);
    expect(destino.status).toBe("delivered");

    await pool.query("update messages set status = 'read', read_at = now(), ack = 3 where id = $1", [mensagem]);
    destino = await destinatarioDe(campanha);
    expect(destino.lido).toBe(true);
    expect(destino.status).toBe("read");
  });

  it("o status analítico não retrocede: um carimbo atrasado não desfaz a leitura", async () => {
    const { campanha, mensagem } = await montarEnvio("Carimbo atrasado");

    await pool.query("update messages set status = 'sent', read_at = now() where id = $1", [mensagem]);
    const lido = await destinatarioDe(campanha);
    expect(lido.status).toBe("read");

    // O ack de entrega chega DEPOIS (fora de ordem): o destinatário lido segue lido.
    await pool.query("update messages set status = 'sent', delivered_at = now() where id = $1", [mensagem]);
    const depois = await destinatarioDe(campanha);
    expect(depois.status).toBe("read");
    expect(depois.lido).toBe(true);
  });

  it("a falha continua gravando o código e o detalhe que o operador lê", async () => {
    const { campanha, mensagem } = await montarEnvio("Falha da API oficial");

    await pool.query(
      `update messages set status = 'failed', error_code = '131026', error_message = 'Message undeliverable'
        where id = $1`,
      [mensagem],
    );

    const destino = await destinatarioDe(campanha);
    expect(destino.status).toBe("failed");
    expect(destino.codigo).toBe("131026");
    expect(destino.detalhe).toBe("Message undeliverable");
    expect(destino.entregue).toBe(false);
  });

  it("um `update` que não toca `status`, `delivered_at` nem `read_at` não sincroniza nada", async () => {
    const { campanha, mensagem } = await montarEnvio("Ruído na mensagem");

    // O destinatário começa em `sending` e sem carimbo: se o gatilho disparasse
    // por coluna alheia, o `updated_at` dele mudaria (e o `status`, ao menos).
    const antes = await destinatarioDe(campanha);
    await pool.query("select pg_sleep(0.05)");

    await pool.query("update messages set body = 'corpo reescrito', updated_at = now() where id = $1", [mensagem]);

    const depois = await destinatarioDe(campanha);
    expect(depois.atualizado).toBe(antes.atualizado);
    expect(depois.status).toBe("sending");

    // E o mesmo vale para um `update` que REPETE o status: o `if` de saída da
    // função (os três fatos iguais) devolve `new` sem escrever no destinatário.
    await pool.query("select pg_sleep(0.05)");
    await pool.query("update messages set status = 'sent' where id = $1", [mensagem]);

    const terceiro = await destinatarioDe(campanha);
    expect(terceiro.atualizado).toBe(antes.atualizado);
    expect(terceiro.status).toBe("sending");
  });
});
