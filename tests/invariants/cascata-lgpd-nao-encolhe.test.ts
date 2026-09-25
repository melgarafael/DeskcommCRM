/**
 * A CASCATA DE LGPD NÃO ENCOLHE — a catraca da lista de tabelas.
 *
 * ## O defeito que este arquivo existe para impedir
 *
 * `fn_lgpd_cascade_redact_contact` é uma função só, e o Postgres não mescla
 * corpos: `create or replace` substitui o corpo INTEIRO. O épico dos casos vivos
 * a reescreve em cinco entregas diferentes (0280, e depois a conversa do caso, o
 * aviso no WhatsApp e a passagem para humano). Quem derivar do corpo errado — o
 * de uma migration anterior, ou o de um `git stash` velho — apaga passos alheios
 * sem um único erro. E o modo de falha é o de sempre para obrigação legal: a
 * rota devolve SUCESSO, a contagem por tabela fecha, o SLA de D+15 é marcado
 * como cumprido, e o texto sobre quem pediu para ser esquecido volta a ficar
 * legível.
 *
 * `tests/invariants/lgpd-caso-anonimiza.test.ts` prova o EFEITO de um passo.
 * Este arquivo guarda o CONJUNTO — e é o conjunto que encolhe em silêncio.
 *
 * ## Por que a lista é NOMEADA, e não um número
 *
 * Um `expect(tabelas.length).toBeGreaterThanOrEqual(11)` fica verde quando uma
 * entrega tira `agent_cases` e põe outra tabela no lugar: o número não se mexe e
 * o dado pessoal volta. A lista nomeada não tem esse ponto cego.
 *
 * ## Por que a comparação é nos DOIS sentidos
 *
 * Só cobrar "não falta nenhuma" faz a catraca ser satisfeita pelo motivo errado:
 * quem quiser afrouxá-la tira o nome daqui e ninguém nota. Cobrando também "não
 * sobra nenhuma", a lista só muda por edição DELIBERADA deste arquivo — que é o
 * rastro que se quer. **A lista CRESCE uma entrada por entrega**; encolher
 * reprova, e crescer sem editar aqui também.
 *
 * ## Por que ler do BANCO e não do arquivo
 *
 * O que vale é o corpo instalado, não o texto de um `.sql`. Um apêndice que não
 * foi aplicado, ou uma migration posterior que sobrescreveu a função com um
 * corpo antigo, são exatamente os casos que este arquivo precisa pegar — e os
 * dois ficariam invisíveis para um `grep` no repositório.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * As tabelas que a cascata TEM de tocar, por nome.
 *
 * Retrato da migration 0280. Cada linha diz de onde veio, porque "por que esta
 * tabela está aqui" é a pergunta que a próxima entrega vai fazer.
 */
const TABELAS_NA_CASCATA = [
  // 0375/0376 — `rendered_body` é a MENSAGEM que a pessoa recebeu e
  // `recipient_address` o telefone para onde foi. A LINHA fica (é a prova de
  // que ela esteve na campanha, e apagá-la desfaria a contagem de quem
  // recebeu); o conteúdo sai.
  "campaign_recipients",
  // 0376 — a cauda do telefone e o motivo. O HASH do endereço PERMANECE: é
  // ele que faz o "não me mande mais" continuar valendo depois da
  // anonimização — apagá-lo faria a pessoa voltar a receber campanha.
  "campaign_suppressions",
  "agent_case_chat_messages", // 0281 — o `body` da consulta interna da equipe sobre o caso
  "agent_case_events", //  0280 — body/metadata da linha do tempo do caso
  "agent_cases", //        0280 — title/summary/blocker/context_snapshot
  "agent_inbox_items", //  0280 — o aviso da Central que embute o texto do caso
  "contacts", //           0019 — a linha do titular
  "conversations", //      0019 — metadata e prévia da última mensagem
  "crm_lead_activities", //0071 — payload, metadata e `reason` escrito por LLM
  "crm_leads", //          0019 — título, descrição, campos personalizados, tags
  "demandas", //           0280 — o assunto do pedido
  // 0292 — `erro_detalhe` do registro de entrega do aviso: é o texto CRU que o
  // transporte devolveu, e um provedor que recusa um envio costuma devolver o
  // destinatário dentro da mensagem de erro. A tabela NÃO satisfaz as duas
  // condições de `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` (sem FK para
  // `contacts`, sem coluna de nome-de-PII), então aquele gate ficaria VERDE sem
  // este passo. É esta catraca que o segura.
  "entregas_de_aviso_de_caso",
  "messages", //           0019 — corpo, mídia e metadata
  "orders", //             0019 — dados pessoais dentro do payload do pedido
  // 0291 — o briefing da passagem: title/body/notes/content e as tentativas.
  // `body` é `not null` e recebe o RÓTULO, não `null`.
  "passagens_de_atendimento",
  // 0359 — o texto livre da comanda: `notes`, `cancel_reason` e
  // `reverse_reason`. O valor, o status, as datas e o vínculo com o contato
  // FICAM: a venda é registro financeiro da organização, e desligá-la faria o
  // relatório por cliente deixar de fechar com o faturamento do período.
  "sales",
  // 0345 — nome, telefone, endereço e `maps_url` do negócio raspado antes de
  // existir conversa. O passo alcança por vínculo OU POR TELEFONE (variantes do
  // nono dígito): quando o número já era de um contato conhecido, o candidato
  // fica com `contact_id` NULO de propósito — lá o vínculo é o freio de mão do
  // envio —, e só pelo vínculo a pessoa que a empresa JÁ conhecia era a única
  // que o expurgo não alcançava. Prova de comportamento em
  // `lgpd-alcanca-prospeccao-de-quem-ja-era-contato.test.ts`.
  "prospecting_candidates",
  "voice_calls", //        0235 — o telefone de quem falou ao telefone
] as const;

/**
 * Os tipos de evento reservados ao servidor em `public.emit_event`.
 *
 * Mesma catraca, mesmo motivo: a 0279 acrescentou os dois de caso ao corpo da
 * função, e a função é reescrita pelas mesmas entregas que reescrevem a cascata.
 * Um tipo que sai da reserva volta a ser forjável por quem tem `auth.uid()`.
 */
const TIPOS_RESERVADOS = [
  "ai.case_closed", //               0279
  "ai.case_opened", //               0279
  "appointment.outcome_confirmed", //herdado
  "message.received", //             herdado
] as const;

/** Uma coluna de texto do psql (`-tA`) virada lista, sem linha vazia. */
function linhas(consulta: string): string[] {
  return sql(consulta)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Os alvos de `update`/`delete from` no corpo INSTALADO da cascata.
 *
 * Mesma sonda de `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts`, de
 * propósito: duas sondas diferentes para a mesma grandeza divergiriam, e a
 * divergência seria lida como defeito do produto.
 */
function tabelasNaCascata(): string[] {
  return linhas(`
    select distinct m[1]
      from pg_proc p,
           lateral regexp_matches(
             pg_get_functiondef(p.oid),
             '(?:update|delete from)\\s+(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     where p.proname = 'fn_lgpd_cascade_redact_contact'
       and p.pronamespace = 'public'::regnamespace
     order by 1;
  `);
}

/**
 * Os literais da lista de tipos reservados do corpo instalado do `emit_event`.
 *
 * A âncora é a GUARDA inteira (`auth.uid() is not null and p_event_type in (`),
 * não só `p_event_type in (` — o corpo tem uma SEGUNDA lista com esse texto
 * (`'lead.created','lead.stage_changed','lead.tag_added'`, o roteamento de
 * evento de lead), e um `substring` frouxo passaria a medir aquela no dia em que
 * alguém trocasse a ordem dos blocos. Forma que muda ⇒ `substring` devolve null
 * ⇒ zero linhas ⇒ o CONTROLE abaixo fica vermelho, que é o lado certo para
 * errar.
 */
function tiposReservados(): string[] {
  return linhas(`
    select distinct m[1]
      from pg_proc p,
           lateral regexp_matches(
             substring(pg_get_functiondef(p.oid)
                       from 'auth\\.uid\\(\\) is not null and p_event_type in \\(([^)]*)\\)'),
             '''([a-z_.]+)''', 'g') m
     where p.proname = 'emit_event'
       and p.pronamespace = 'public'::regnamespace
     order by 1;
  `);
}

describe("catraca: a cascata de LGPD e a reserva do emit_event não encolhem", () => {
  it("CONTROLE: a sonda da cascata leu um corpo de verdade", () => {
    // Um regex que deixe de casar devolve lista vazia — e lista vazia faria a
    // comparação "não sobra nenhuma" passar enquanto a de "não falta nenhuma"
    // reprovaria com uma mensagem que não fala de defeito nenhum.
    const lidas = tabelasNaCascata();
    expect(lidas.length, "a cascata não foi lida do banco — sonda cega ou função ausente").toBeGreaterThan(5);
    expect(lidas, "a cascata não toca `contacts` — isso não é possível").toContain("contacts");
  });

  it("nenhuma tabela saiu da cascata", () => {
    const instaladas = new Set(tabelasNaCascata());
    const faltando = TABELAS_NA_CASCATA.filter((t) => !instaladas.has(t));
    expect(
      faltando,
      "Estas tabelas estavam na cascata e não estão mais. Anonimizar devolve SUCESSO e o " +
        "texto sobre a pessoa continua legível — a falha é muda e o SLA é marcado como " +
        "cumprido. Causa típica: uma entrega derivou o corpo da função de uma versão " +
        "anterior e sobrescreveu o passo de outra (o Postgres troca o corpo INTEIRO). " +
        "Derive do corpo VIGENTE:\n" +
        "  grep -n 'FUNCTION .public...fn_lgpd_cascade_redact_contact' supabase/baseline.sql | tail -1\n",
    ).toEqual([]);
  });

  it("CATRACA: nenhuma tabela entrou na cascata sem ser declarada aqui", () => {
    // Este é o caso que torna a lista acima uma catraca em vez de um `toContain`
    // que qualquer um afrouxa sem deixar rastro: a lista só muda por edição
    // deliberada deste arquivo, e a edição aparece no diff do PR.
    const declaradas = new Set<string>(TABELAS_NA_CASCATA);
    const sobrando = tabelasNaCascata().filter((t) => !declaradas.has(t));
    expect(
      sobrando,
      "A cascata passou a tocar tabela que este arquivo não declara. Se o passo é " +
        "legítimo, acrescente o nome em `TABELAS_NA_CASCATA` com a migration de origem no " +
        "comentário — é assim que a próxima entrega sabe que ele existe e não o apaga.\n",
    ).toEqual([]);
  });

  it("CONTROLE: a sonda da reserva do `emit_event` leu a lista de verdade", () => {
    expect(
      tiposReservados().length,
      "nenhum tipo reservado lido — o `p_event_type in (…)` mudou de forma?",
    ).toBeGreaterThan(1);
  });

  it("nenhum tipo saiu da reserva do `emit_event`", () => {
    const instalados = new Set(tiposReservados());
    const faltando = TIPOS_RESERVADOS.filter((t) => !instalados.has(t));
    expect(
      faltando,
      "Estes tipos de evento voltaram a ser emissíveis por quem tem `auth.uid()`. Um " +
        "`ai.case_opened` forjado por login move o funil e acorda o agente em nome de uma " +
        "decisão que ninguém tomou.\n",
    ).toEqual([]);
  });

  it("CATRACA: nenhum tipo entrou na reserva sem ser declarado aqui", () => {
    const declarados = new Set<string>(TIPOS_RESERVADOS);
    const sobrando = tiposReservados().filter((t) => !declarados.has(t));
    expect(
      sobrando,
      "A reserva do `emit_event` cresceu sem passar por aqui. Reservar um tipo é decidir " +
        "que nenhum caminho de sessão pode emiti-lo — acrescente o nome em " +
        "`TIPOS_RESERVADOS` com a migration de origem.\n",
    ).toEqual([]);
  });
});
