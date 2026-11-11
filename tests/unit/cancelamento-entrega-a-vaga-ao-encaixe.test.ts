/**
 * O ENCAIXE ESTÁ LIGADO — não só escrito.
 *
 * Os testes de decisão provam a régua e os de porta provam a linha gravada. Falta
 * a metade que nenhum deles vê: o produto CHAMAR o encaixe nos dois momentos em
 * que ele existe.
 *
 * - Quando um compromisso é desmarcado (`cancelarAgendamentoHandler`), a vaga
 *   tem de ser oferecida na hora. Sem a chamada, tudo o que este PR traz é
 *   código morto e o horário continua indo para o lixo.
 * - Quando a vaga segurada é CONFIRMADA (`alterarAgendamentoHandler`), a
 *   inscrição tem de sair da fila — senão a pessoa segue "esperando" um horário
 *   que já é dela.
 * - Quando a rodada de cron passa (`agenda-expira-pendentes`), a oferta vencida
 *   tem de soltar o horário — a mesma lei do pedido que ninguém confirmou.
 *
 * É invariante de FONTE, como `playbook-cita-a-ferramenta.test.ts`: o que se
 * protege aqui é o fio, e o fio só se perde em refatoração de arquivo — o tipo
 * não acusa uma chamada apagada, e o teste de unidade do módulo continua verde.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

function ler(caminho: string): string {
  return readFileSync(join(RAIZ, caminho), "utf8");
}

/** O corpo de uma função de topo, até o próximo `export` de mesmo nível. */
function corpoDaFuncao(fonte: string, assinatura: string): string {
  const inicio = fonte.indexOf(assinatura);
  if (inicio < 0) throw new Error(`função não encontrada: ${assinatura}`);
  const proximo = fonte.indexOf("\nexport ", inicio + assinatura.length);
  return fonte.slice(inicio, proximo < 0 ? undefined : proximo);
}

describe("o cancelamento entrega a vaga", () => {
  const handler = ler("app/api/v1/agenda/agendamentos/_handler.ts");

  it("`cancelarAgendamentoHandler` chama o encaixe com o compromisso que abriu", () => {
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    expect(corpo).toContain("aposVagaLiberada(");
    expect(corpo).toContain("appointmentId: atual.id");
  });

  it("a chamada vem DEPOIS de a desmarcação estar gravada", () => {
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    // `alteraComRevisao` é quem grava (via `fn_appointment_change`); oferecer
    // antes dela ofereceria uma vaga que ainda não abriu.
    expect(corpo.indexOf("alteraComRevisao(")).toBeGreaterThan(-1);
    expect(corpo.indexOf("aposVagaLiberada(")).toBeGreaterThan(
      corpo.indexOf("alteraComRevisao("),
    );
  });

  it("o encaixe não derruba a resposta do cancelamento", () => {
    // O módulo já não lança; o `await` (em vez de `void`) é o que garante que a
    // rota só responde depois de a oferta existir. Se virar `void`, o teste
    // abaixo continua verde mas o de cima não — por isso a asserção explícita.
    const corpo = corpoDaFuncao(handler, "export async function cancelarAgendamentoHandler");
    expect(corpo).toMatch(/await aposVagaLiberada\(/);
  });
});

describe("a confirmação fecha a inscrição", () => {
  const handler = ler("app/api/v1/agenda/agendamentos/_handler.ts");

  it("`alterarAgendamentoHandler` fecha a inscrição quando o status vira `confirmed`", () => {
    const corpo = corpoDaFuncao(handler, "export async function alterarAgendamentoHandler");
    expect(corpo).toContain("fecharEncaixeConfirmado(");
    expect(corpo).toContain('"confirmed"');
  });
});

describe("o cron solta a oferta vencida", () => {
  const rota = ler("app/api/v1/cron/agenda-expira-pendentes/route.ts");

  it("a varredura de encaixe roda na mesma rodada dos pendentes", () => {
    expect(rota).toContain("varrerOfertasVencidas(admin");
  });

  it("o que a varredura fez volta no corpo da resposta", () => {
    expect(rota).toContain("encaixes: encaixes.vencidas");
  });

  it("o módulo desligado não toca na tabela: a chave vem antes da consulta", () => {
    const fonte = ler("lib/agenda/encaixe-supabase.ts");
    const varredura = corpoDaFuncao(fonte, "export async function varrerOfertasVencidas");
    expect(varredura.indexOf("moduloLigado(")).toBeGreaterThan(-1);
    expect(varredura.indexOf("moduloLigado(")).toBeLessThan(varredura.indexOf('from("calendar_waitlist")'));
    const gancho = corpoDaFuncao(fonte, "export async function aposVagaLiberada");
    expect(gancho.indexOf("moduloLigadoComMemo(")).toBeGreaterThan(-1);
    expect(gancho.indexOf("moduloLigadoComMemo(")).toBeLessThan(gancho.indexOf('from("calendar_waitlist")'));
  });
});

describe("toda vaga que abre chama o encaixe", () => {
  it("a expiração de pendentes passa cada id efetivado", () => {
    const rota = ler("app/api/v1/cron/agenda-expira-pendentes/route.ts");
    expect(rota.indexOf("aposVagaLiberada(")).toBeGreaterThan(rota.indexOf("efetivados"));
  });

  it("o cancelamento vindo do Google também", () => {
    expect(ler("lib/agenda/google/mudanca-vinda-do-google.ts")).toContain("aposVagaLiberada(");
  });
});

describe("o módulo nasce pela provisionadora (ADR-0002)", () => {
  const migration = ler("supabase/migrations/20261106103010_9235_lista_de_espera_modulo_opcional.sql");
  const baseline = ler("supabase/baseline.sql");
  const corpo = (sql: string) => {
    const inicio = sql.indexOf("create or replace function public.fn_lista_de_espera_provisionar()");
    return sql.slice(inicio, sql.indexOf("$f$;", inicio));
  };

  it("a tabela só existe dentro da função, nos dois artefatos", () => {
    for (const sql of [migration, baseline]) {
      expect(sql.split("create table if not exists public.calendar_waitlist").length).toBe(2);
      expect(corpo(sql)).toContain("create table if not exists public.calendar_waitlist");
    }
  });

  it("os dois artefatos trazem o mesmo corpo", () => {
    expect(corpo(baseline)).toBe(corpo(migration));
  });

  it("o CHECK de `source` do núcleo não muda", () => {
    expect(migration).not.toContain("calendar_appointments_source_check");
    expect(baseline).not.toContain("'public_page','waitlist'");
  });
});
