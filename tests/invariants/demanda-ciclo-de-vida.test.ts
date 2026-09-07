import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * A DEMANDA NASCE NA ENTRADA — passo 3 do cap. 5 (migration 0138).
 *
 * Sem este trigger, `demandas` teria só o passado derivado pela 0119 e pararia
 * de crescer: peça que só recebe é ilha pelo invariante 1 da própria doutrina,
 * e a entidade estaria correta e morta.
 *
 * Guarda o CICLO DE VIDA inteiro, não só a criação. Os quatro casos que
 * importam, e cada um protege uma decisão de desenho:
 *   1. inbound de contato sem demanda aberta ABRE   → a garantia de cobertura;
 *   2. segunda mensagem NÃO duplica                 → senão cada mensagem
 *      viraria uma demanda e o denominador do índice explodiria;
 *   3. conversa encerrada PRESERVA a demanda           → sem isso o denominador
 *      (que conta fechadas) ficaria vazio para sempre, em silêncio;
 *   4. mensagem depois do fechamento abre OUTRA     → N demandas por conversa
 *      ao longo do tempo, que é o modelo da 0119;
 *   5. outbound NÃO abre                            → só o cliente traz demanda.
 *
 * ## Os 5 casos estão PROVADOS por sabotagem
 *
 * O caso 5 ficou um tempo verde sob sabotagem, e a causa não era o teste: o
 * bloco da migration 0138 tinha sido inserido QUATRO vezes no `baseline.sql`
 * (um `str.replace` sem `count=1` sobre uma marca que aparece 4× no arquivo).
 * A sabotagem editava a primeira cópia e as três `create or replace` seguintes
 * restauravam a função. Corrigido em migration própria; com uma única
 * definição, remover o guard de `direction` reprova o caso 5 com
 * `expected 3 to be 2`.
 *
 * Fica a lição embutida: teste verde sob sabotagem pode denunciar o ARTEFATO
 * duplicado, não o teste fraco. Antes de reescrever a asserção, conte quantas
 * vezes o objeto sabotado existe.
 */

const CT = "aeaf1111-0000-4000-8000-000000000001";
const CV = "aeaf2222-0000-4000-8000-000000000001";

function contaDemandas(extra = ""): number {
  const out = sql(`select count(*) from public.demandas where contact_id = '${CT}' ${extra};`);
  return Number(lastLine(out));
}

function inbound(corpo: string): void {
  sql(`insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, sent_via, body, sent_at)
       values ('${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${CT}',
               'text', 'inbound', 'received', 'ai', '${corpo}', now());`);
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.demanda_conversas where conversation_id = '${CV}';
    delete from public.demandas where contact_id = '${CT}';
    delete from public.messages where conversation_id = '${CV}';
    delete from public.conversations where id = '${CV}';
    delete from public.contacts where id = '${CT}';
    insert into public.contacts (id, organization_id, display_name)
      values ('${CT}', '${GOV_ORG}', 'Ciclo de vida da demanda');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CV}', '${GOV_ORG}', '${CT}', '${GOV_SESSION}', 'open');
  `);
});

describe("demanda nasce e morre no ponto de entrada", () => {
  it("comeca sem demanda alguma (senao o teste passaria por inercia)", () => {
    expect(contaDemandas()).toBe(0);
  });

  it("1. mensagem do cliente ABRE a demanda, com origem e dono declarados", () => {
    inbound("oi preciso de ajuda");
    expect(contaDemandas()).toBe(1);
    const linha = lastLine(
      sql(`select origem || '|' || dono_kind || '|' || estado
             from public.demandas where contact_id = '${CT}';`),
    );
    // Dono NUNCA vazio (cap. 5 §5.3): sem ninguem, o dono e a automacao.
    expect(linha).toBe("inbound|ia|aberta");
  });

  it("2. a segunda mensagem NAO duplica a demanda", () => {
    inbound("ainda estou aqui");
    expect(contaDemandas()).toBe(1);
  });

  it("3. encerrar a conversa preserva a demanda sem inventar desfecho", () => {
    sql(`update public.conversations set status = 'resolved' where id = '${CV}';`);
    expect(contaDemandas("and fechada_em is not null")).toBe(0);
    expect(contaDemandas("and proximo_passo is not null and desfecho is null")).toBe(1);
  });

  it("4. mensagem DEPOIS do fechamento abre uma demanda NOVA", () => {
    inbound("voltei com outro problema");
    expect(contaDemandas()).toBe(2);
    expect(contaDemandas("and fechada_em is null")).toBe(2);
  });

  it("5. mensagem NOSSA nao abre demanda — so o cliente traz demanda", () => {
    // A demanda aberta precisa ser FECHADA antes: com uma aberta, o trigger não
    // criaria nada de qualquer jeito e o teste passaria pela razão errada.
    // Medido: sabotar o guard de `direction` NÃO reprovava esta asserção até
    // esta linha existir — o teste acertava por sorte.
    sql(`update public.demandas set estado = 'resolvida', desfecho = 'resolvida',
           fechada_em = now() where contact_id = '${CT}' and fechada_em is null;`);
    expect(contaDemandas("and fechada_em is null")).toBe(0);

    sql(`insert into public.messages
          (organization_id, conversation_id, channel_session_id, contact_id,
           type, direction, status, sent_via, body, sent_at)
         values ('${GOV_ORG}', '${CV}', '${GOV_SESSION}', '${CT}',
                 'text', 'outbound', 'sent', 'ai', 'ola', now());`);
    // Com ZERO demanda aberta, uma mensagem nossa não pode criar uma.
    expect(contaDemandas()).toBe(2);
    expect(contaDemandas("and fechada_em is null")).toBe(0);
  });
});
