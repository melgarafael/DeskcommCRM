/**
 * O `update.sh` DE UM CLONE NÃO PODE DUPLICAR A DEMANDA QUE JÁ EXISTE.
 *
 * ## O defeito que este invariante existe para barrar (medido, não hipotético)
 *
 * O apêndice do `baseline.sql` carrega o backfill histórico da migration 0136:
 * R1 deriva uma demanda de cada `agent_cases`, R2 deriva uma demanda de cada
 * conversa que nunca escalou. O guard de R2 era idempotente só **contra si
 * mesmo** — procurava outra linha `origem = 'derivada'` com o mesmo `aberta_em`.
 *
 * A migration 0138 passou a abrir a demanda `origem = 'inbound'` na entrada de
 * cada mensagem, e essa linha é invisível para aquele guard. O kit self-host
 * re-aplica o baseline INTEIRO a cada `update.sh`. Medido em pg17 com os dois
 * blocos do baseline da main de 23/09 (install + 1 conversa com mensagem de
 * entrada + update):
 *
 *     depois do install + mensagem : inbound=1
 *     depois do update.sh          : inbound=1  derivada=1
 *
 * Ninguém vê acontecer. O operador vê o Radar dizendo que há o dobro de
 * demandas abertas sem próximo passo, e `fn_atrito_metrics` devolve
 * `escopo.demandas` dobrado (migration 0392).
 *
 * ## Por que o teste EXECUTA o SQL do baseline em vez de procurar o guard nele
 *
 * Um `grep` pelo texto do guard mediria presença de símbolo, não comportamento:
 * passaria com o guard escrito num lugar que não é o `where` de R2. Aqui o bloco
 * é EXTRAÍDO do arquivo que o self-hoster aplica e EXECUTADO, dentro de uma
 * transação revertida, para o resto do arquivo não herdar as linhas derivadas.
 *
 * ## Qual caso guarda o quê
 *
 *   1. controle positivo: o bloco extraído AINDA DERIVA demanda para conversa
 *      sem nenhuma. Sem ele, extração quebrada = caso 2 verde por vácuo.
 *   2. o guard: conversa que o trigger já cobriu não ganha segunda demanda.
 *   3. a auto-cura: o clone que JÁ duplicou perde a duplicata. O caso 2 parte de
 *      banco limpo e continuaria verde com o `delete` apagado.
 *   4. o limite da auto-cura: a derivada LEGÍTIMA (anterior à 'inbound' da mesma
 *      conversa, o caso da conversa reaberta) é histórico e fica. Sem a condição
 *      de `created_at`, a cura apagaria demanda encerrada do denominador do índice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

const MARCADOR_INICIO = "-- ---- Índice de Atrito + DEMANDAS";
/** Todo rótulo de bloco do apêndice tem esta forma; o próximo encerra o nosso. */
const MARCADOR_PROXIMO = "\n-- ---- ";

/** O bloco do apêndice que o `update.sh` re-aplica, lido do arquivo de verdade. */
function blocoDoApendice(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) {
    throw new Error(
      `marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql — ` +
        "a extração não pode devolver bloco vazio em silêncio",
    );
  }
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);
  // Sem estas conferências, um bloco truncado passaria como "não duplicou".
  if (!/insert into public\.demandas/.test(bloco)) {
    throw new Error("bloco extraído não contém o insert de demandas (extração quebrada)");
  }
  if (!/'derivada'/.test(bloco)) {
    throw new Error("bloco extraído não contém o backfill R2 (extração quebrada)");
  }
  return bloco;
}

// Namespace pela migration (0392), como manda meta-templates-rls.test.ts.
/** Contato COM mensagem de entrada: o trigger da 0138 já abriu a demanda dele. */
const CT_COM_DEMANDA = "0392cccc-0000-4000-8000-000000000001";
const CV_COM_DEMANDA = "0392cccc-1111-4000-8000-000000000001";
/** Contato SEM mensagem nenhuma: não há demanda, e R2 deve derivar uma. */
const CT_SEM_DEMANDA = "0392cccc-0000-4000-8000-000000000002";
const CV_SEM_DEMANDA = "0392cccc-1111-4000-8000-000000000002";
/** Contato com derivada HISTÓRICA e uma 'inbound' mais nova (conversa reaberta). */
const CT_REABERTA = "0392cccc-0000-4000-8000-000000000003";
const CV_REABERTA = "0392cccc-1111-4000-8000-000000000003";
/** A duplicata que o caso 3 planta para provar a auto-cura. */
const DEMANDA_DUPLICATA = "0392cccc-2222-4000-8000-000000000001";
const DEMANDA_HISTORICA = "0392cccc-2222-4000-8000-000000000002";
const DEMANDA_INBOUND_NOVA = "0392cccc-2222-4000-8000-000000000003";

/**
 * Re-aplica o bloco do apêndice e devolve quantas demandas o contato tem DEPOIS
 * — tudo numa transação revertida, então o efeito é observado e descartado.
 *
 * `psql` imprime o status de cada comando (CREATE INDEX, INSERT 0 2…) junto do
 * resultado, e o último deles é o `ROLLBACK`. Por isso a contagem é a última
 * linha PURAMENTE numérica, não a última linha.
 */
function demandasDepoisDeReaplicar(contato: string): number {
  const saida = sql(`
    begin;
    ${blocoDoApendice()}
    select count(*) from public.demandas where contact_id = '${contato}';
    rollback;
  `);
  const numeros = saida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l));
  const ultimo = numeros[numeros.length - 1];
  if (ultimo === undefined) {
    throw new Error(`nenhuma contagem na saída do psql: ${saida}`);
  }
  return Number(ultimo);
}

function demandasAgora(contato: string): number {
  return Number(
    lastLine(sql(`select count(*) from public.demandas where contact_id = '${contato}';`)),
  );
}

beforeAll(() => {
  seedGov();
  const contatos = `'${CT_COM_DEMANDA}', '${CT_SEM_DEMANDA}', '${CT_REABERTA}'`;
  const conversas = `'${CV_COM_DEMANDA}', '${CV_SEM_DEMANDA}', '${CV_REABERTA}'`;
  sql(`
    delete from public.demanda_conversas where conversation_id in (${conversas});
    delete from public.demandas where contact_id in (${contatos});
    delete from public.messages where conversation_id in (${conversas});
    delete from public.conversations where id in (${conversas});
    delete from public.contacts where id in (${contatos});

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT_COM_DEMANDA}', '${GOV_ORG}', 'Update nao reduplica - com demanda'),
      ('${CT_SEM_DEMANDA}', '${GOV_ORG}', 'Update nao reduplica - sem demanda'),
      ('${CT_REABERTA}', '${GOV_ORG}', 'Update nao reduplica - reaberta');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CV_COM_DEMANDA}', '${GOV_ORG}', '${CT_COM_DEMANDA}', '${GOV_SESSION}', 'open'),
      ('${CV_SEM_DEMANDA}', '${GOV_ORG}', '${CT_SEM_DEMANDA}', '${GOV_SESSION}', 'open'),
      ('${CV_REABERTA}', '${GOV_ORG}', '${CT_REABERTA}', '${GOV_SESSION}', 'open');

    -- Só o primeiro recebe mensagem: é o trigger da 0138 quem abre a demanda,
    -- pelo mesmo caminho que a entrada real usa (nada de INSERT à mão em
    -- demandas, que mentiria sobre a origem da linha).
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, sent_via, body, sent_at)
    values ('${GOV_ORG}', '${CV_COM_DEMANDA}', '${GOV_SESSION}', '${CT_COM_DEMANDA}',
            'text', 'inbound', 'received', 'ai', 'quero saber do meu pedido', now());

    -- A conversa reaberta: a derivada do backfill original (encerrada, e mais
    -- VELHA) e a 'inbound' que o trigger abriu quando o cliente voltou a falar.
    -- Plantadas à mão porque o backfill original não existe mais para rodar:
    -- o que importa aqui é a ORDEM de nascimento, que é o que a cura lê.
    insert into public.demandas
      (id, organization_id, contact_id, aberta_em, origem, estado, dono_kind,
       desfecho, fechada_em, created_at)
    values ('${DEMANDA_HISTORICA}', '${GOV_ORG}', '${CT_REABERTA}', now() - interval '3 days',
            'derivada', 'resolvida', 'ia', 'resolvida', now() - interval '2 days',
            now() - interval '2 days');
    insert into public.demandas (id, organization_id, contact_id, origem, estado, dono_kind)
    values ('${DEMANDA_INBOUND_NOVA}', '${GOV_ORG}', '${CT_REABERTA}', 'inbound', 'aberta', 'ia');
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id) values
      ('${GOV_ORG}', '${DEMANDA_HISTORICA}', '${CV_REABERTA}'),
      ('${GOV_ORG}', '${DEMANDA_INBOUND_NOVA}', '${CV_REABERTA}');
  `);
});

describe("re-aplicar o baseline (update.sh de um clone) não reduplica demanda", () => {
  it("precondição: o trigger da entrada abriu UMA demanda, e o outro contato não tem nenhuma", () => {
    expect(demandasAgora(CT_COM_DEMANDA)).toBe(1);
    expect(demandasAgora(CT_SEM_DEMANDA)).toBe(0);
    expect(demandasAgora(CT_REABERTA)).toBe(2);
  });

  it("1. o bloco extraído está VIVO: deriva demanda para conversa que não tem nenhuma", () => {
    expect(demandasDepoisDeReaplicar(CT_SEM_DEMANDA)).toBe(1);
  });

  it("2. e NÃO deriva uma segunda para a conversa que o trigger já cobriu", () => {
    // O defeito, se voltar, aparece aqui como 2: a linha 'inbound' do trigger
    // mais uma 'derivada' que o backfill histórico criou por cima dela.
    expect(demandasDepoisDeReaplicar(CT_COM_DEMANDA)).toBe(1);
  });

  it("3. e CURA o clone que já duplicou antes do guard existir", () => {
    // Quem rodou `update.sh` com a versão antiga do apêndice já tem a duplicata
    // no banco, e ela nunca sairia sozinha. Plantada DEPOIS da 'inbound', como
    // o `update.sh` antigo a criava.
    sql(`
      insert into public.demandas
        (id, organization_id, contact_id, aberta_em, origem, estado, dono_kind)
      select '${DEMANDA_DUPLICATA}', '${GOV_ORG}', '${CT_COM_DEMANDA}', c.created_at,
             'derivada', 'aberta', 'ia'
        from public.conversations c where c.id = '${CV_COM_DEMANDA}';
      insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
        values ('${GOV_ORG}', '${DEMANDA_DUPLICATA}', '${CV_COM_DEMANDA}');
    `);
    try {
      expect(demandasAgora(CT_COM_DEMANDA)).toBe(2);
      expect(demandasDepoisDeReaplicar(CT_COM_DEMANDA)).toBe(1);
    } finally {
      sql(`delete from public.demandas where id = '${DEMANDA_DUPLICATA}';`);
    }
  });

  it("4. e NÃO apaga a derivada legítima, mais velha que a 'inbound' da mesma conversa", () => {
    // A derivada histórica é intocada, tem um vínculo só e divide a conversa
    // com uma demanda de origem real — tudo o que a duplicata também tem. O
    // que a separa é ter nascido ANTES. Sem essa condição, a cura tira uma
    // demanda encerrada do denominador do índice.
    expect(demandasDepoisDeReaplicar(CT_REABERTA)).toBe(2);
  });
});
