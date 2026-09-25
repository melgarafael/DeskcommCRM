import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O ROTEIRO DE ATENDIMENTO ENCERRA COM HUMANO, NO OPT-OUT E NO PRAZO
 * (migration 0397 — PR 2 do port do #1130, achados 9 e 5 da prova prática).
 *
 *   1. `force_human` virando true (qualquer escritor: passagem do motor,
 *      ferramenta de handoff, orquestrador, teto de orçamento) encerra o
 *      roteiro vivo do contato, com evento `roteiro_cancelado` (humano_assumiu).
 *   2. `is_blocked` virando true (opt-out) idem (opt_out).
 *   3. A pausa CURTA por resposta manual pelo celular (`bot_silenced_until` com
 *      prazo) NÃO encerra — o roteiro volta com a IA.
 *   4. `fn_encerrar_roteiros_vencidos` encerra o 'coletando' sem mensagem lida
 *      além do prazo do grafo (padrão 72 h), com evento `roteiro_expirado`; não
 *      toca o que está dentro do prazo; e ninguém de fora do service_role a chama.
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

function ultima(out: string): string {
  const linhas = out.split("\n");
  return linhas[linhas.length - 1] ?? "";
}

const ORG = "03970000-0000-4000-8000-00000000000a";
const SESSAO = "03970000-2222-4000-8000-00000000000a";
const ROTEIRO = "03970000-3333-4000-8000-00000000000a";
const VERSAO = "03970000-4444-4000-8000-00000000000a";
const ROTEIRO_24H = "03970000-3333-4000-8000-0000000000b1";
const VERSAO_24H = "03970000-4444-4000-8000-0000000000b1";
const HUMANO = "03970000-5555-4000-8000-000000000001";
const OPT_OUT = "03970000-5555-4000-8000-000000000002";
const CELULAR = "03970000-5555-4000-8000-000000000003";
const VENCIDO = "03970000-5555-4000-8000-000000000004";
const RECENTE = "03970000-5555-4000-8000-000000000005";
const PRAZO_CURTO = "03970000-5555-4000-8000-000000000006";
const CONVERSA_CELULAR = "03970000-6666-4000-8000-000000000003";

function grafo(settings: Record<string, unknown>): string {
  return JSON.stringify({
    nodes: [
      { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
      {
        id: "c1",
        type: "collect",
        label: "Nome",
        position: { x: 0, y: 0 },
        config: { key: "nome_completo", label: "Nome completo", type: "text", required: true, permite_correcao: true },
      },
      { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
      { id: "b", source: "c1", target: "e", priority: 0, condition: { type: "always" } },
    ],
    settings,
  });
}

function roteiro(contato: string, opts: { pointer?: string; versao?: string; inicio?: string } = {}): string {
  return `
    insert into public.followup_enrollments
      (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, started_at)
    values ('${ORG}', '${opts.pointer ?? ROTEIRO}', '${opts.versao ?? VERSAO}', '${contato}', 't', 'coletando', null,
            ${opts.inicio ?? "now()"});`;
}

function status(contato: string): string {
  return sql(`
    select e.status || '|' || coalesce(e.cancel_reason, '') || '|' ||
           coalesce((select string_agg(ev.event_type || ':' || coalesce(ev.payload->>'motivo', ''), ',' order by ev.created_at)
                       from public.followup_enrollment_events ev
                      where ev.enrollment_id = e.id and ev.event_type in ('roteiro_cancelado','roteiro_expirado')), '')
      from public.followup_enrollments e where e.contact_id = '${contato}';`);
}

beforeAll(() => {
  const contatos = [HUMANO, OPT_OUT, CELULAR, VENCIDO, RECENTE, PRAZO_CURTO]
    .map((c, i) => `('${c}', '${ORG}', 'Contato ${i}')`)
    .join(", ");
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'roteiro-0397', 'Roteiro 0397', 'Roteiro 0397');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'roteiro-0397', '\\x00'::bytea);
    insert into public.followup_flow_pointers (id, organization_id, name, status, surface) values
      ('${ROTEIRO}', '${ORG}', 'Cadastro', 'active', 'atendimento'),
      ('${ROTEIRO_24H}', '${ORG}', 'Cadastro curto', 'active', 'atendimento');
    insert into public.followup_flow_versions (id, organization_id, pointer_id, graph) values
      ('${VERSAO}', '${ORG}', '${ROTEIRO}', '${grafo({ max_tentativas_pergunta: 3 })}'::jsonb),
      ('${VERSAO_24H}', '${ORG}', '${ROTEIRO_24H}', '${grafo({ max_tentativas_pergunta: 3, expira_em_horas: 24 })}'::jsonb);
    insert into public.contacts (id, organization_id, name) values ${contatos};
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA_CELULAR}', '${ORG}', '${CELULAR}', '${SESSAO}', 'open');
    ${roteiro(HUMANO)}
    ${roteiro(OPT_OUT)}
    ${roteiro(CELULAR)}
    ${roteiro(VENCIDO, { inicio: "now() - interval '80 hours'" })}
    ${roteiro(RECENTE, { inicio: "now() - interval '80 hours'" })}
    ${roteiro(PRAZO_CURTO, { pointer: ROTEIRO_24H, versao: VERSAO_24H, inicio: "now() - interval '30 hours'" })}
    -- O RECENTE começou há 80 h, mas o roteiro leu uma mensagem dele há 1 h.
    insert into public.followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at)
      select '${ORG}', e.id, 'c1', 'roteiro_mensagem', '{}'::jsonb, 'roteiro_msg:recente', now() - interval '1 hour'
        from public.followup_enrollments e where e.contact_id = '${RECENTE}';
  `);
});

describe("humano assumiu e opt-out encerram o roteiro, num lugar só", () => {
  it("⭐ force_human virando true: cancelado, com evento humano_assumiu", () => {
    sql(`update public.contacts set force_human = true where id = '${HUMANO}';`);
    expect(status(HUMANO)).toBe("cancelled|Humano assumiu o atendimento|roteiro_cancelado:humano_assumiu");
  });

  it("⭐ opt-out (is_blocked virando true): cancelado, com evento opt_out", () => {
    sql(`update public.contacts set is_blocked = true where id = '${OPT_OUT}';`);
    expect(status(OPT_OUT)).toBe("cancelled|Contato pediu para parar (opt-out)|roteiro_cancelado:opt_out");
  });

  it("a pausa curta por resposta pelo celular NÃO encerra — o roteiro volta com a IA", () => {
    sql(`update public.conversations set bot_silenced_until = now() + interval '2 hours', last_handoff_at = now()
          where id = '${CONVERSA_CELULAR}';`);
    expect(status(CELULAR)).toBe("coletando||");
  });

  it("gravar force_human de novo (já true) não duplica nada", () => {
    sql(`update public.contacts set force_human = true where id = '${HUMANO}';`);
    expect(status(HUMANO)).toBe("cancelled|Humano assumiu o atendimento|roteiro_cancelado:humano_assumiu");
  });
});

describe("prazo: fn_encerrar_roteiros_vencidos", () => {
  it("anon e authenticated não a executam", () => {
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_encerrar_roteiros_vencidos(int)', 'execute')::text || ',' ||
                  has_function_privilege('authenticated', 'public.fn_encerrar_roteiros_vencidos(int)', 'execute')::text;`),
    ).toBe("false,false");
  });

  it("⭐ encerra o vencido (padrão 72 h e o prazo do grafo), não o que leu mensagem há pouco", () => {
    const encerrados = Number(ultima(sql(`select public.fn_encerrar_roteiros_vencidos(1000);`)));
    expect(encerrados).toBeGreaterThanOrEqual(2);
    expect(status(VENCIDO)).toBe("cancelled|Roteiro expirou sem resposta|roteiro_expirado:");
    expect(status(PRAZO_CURTO)).toBe("cancelled|Roteiro expirou sem resposta|roteiro_expirado:");
    expect(status(RECENTE)).toBe("coletando||");
    expect(status(CELULAR)).toBe("coletando||");
  });

  it("rodar de novo não encerra nem registra nada a mais", () => {
    sql(`select public.fn_encerrar_roteiros_vencidos(1000);`);
    expect(status(VENCIDO)).toBe("cancelled|Roteiro expirou sem resposta|roteiro_expirado:");
    expect(status(RECENTE)).toBe("coletando||");
  });
});
