import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * UM DONO POR RESPOSTA — o engine ou o worker embutido, nunca os dois (#129).
 *
 * ## O defeito
 *
 * `lib/waha/ingest.ts` emite, para CADA mensagem inbound, os dois eventos,
 * incondicionalmente: `ai_agent.dispatch_requested` (drenado pelo agent-engine,
 * que responde de verdade) e `message.received` (drenado por
 * `workers/ai-response-worker.ts`). Não havia trava nenhuma entre eles.
 *
 * Numa instalação padrão os dois agiam na mesma mensagem. `ai_agents.is_active`
 * tem DEFAULT `true` e o onboarding o liga explicitamente, então o worker
 * embutido achava agente e seguia: chamava o LLM (custo cobrado duas vezes) e
 * inseria uma outbound `sending` que nunca saía, porque
 * `message.send_requested` nunca teve consumidor. O cliente recebia uma
 * resposta e o dono via duas linhas, uma delas "enviando" para sempre.
 *
 * ## O que se guarda aqui, e por que no banco
 *
 * O PREDICADO, não a mensagem: os dois runtimes têm de decidir por critérios
 * complementares — nunca ambos verdadeiros, nunca ambos falsos para a mesma
 * organização. O do engine é `published_version_id não nulo + não arquivado`
 * (`lib/agent-engine/agent/agent-config.ts`); o do worker embutido passou a ser
 * a negação disso.
 *
 * Isto vive num invariante de BANCO porque a pergunta é sobre linhas: um
 * unitário com dublê provaria que o código consulta, não que a consulta
 * particiona. Aqui as três situações reais são montadas como linhas e medidas.
 */

const ORG_PUB = "eeee0000-0000-4000-8000-000000000001";
const ORG_SEM = "eeee0000-0000-4000-8000-000000000002";
const ORG_ARQ = "eeee0000-0000-4000-8000-000000000003";

/** Réplica FIEL do predicado do engine (agent-config.ts): join em published + não arquivado. */
function engineTemDono(org: string): boolean {
  return (
    sql(`
      select exists(
        select 1 from public.ai_agents a
         join public.ai_agent_versions v on v.id = a.published_version_id
        where a.organization_id = '${org}' and a.archived_at is null
      );
    `) === "t"
  );
}

/** Réplica FIEL do predicado novo do worker embutido (ai-response-worker.ts). */
function embutidoCede(org: string): boolean {
  return (
    sql(`
      select exists(
        select 1 from public.ai_agents a
        where a.organization_id = '${org}'
          and a.published_version_id is not null
          and a.archived_at is null
      );
    `) === "t"
  );
}

function semear(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_PUB}', 'eng-pub', 'Engine Publicado', 'Eng Pub'),
      ('${ORG_SEM}', 'eng-sem', 'Engine Sem Publicacao', 'Eng Sem'),
      ('${ORG_ARQ}', 'eng-arq', 'Engine Arquivado', 'Eng Arq')
      on conflict do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt, is_active)
      values
        ('eeee1111-0000-4000-8000-000000000001', '${ORG_PUB}', 'Publicado', 'p', true),
        ('eeee1111-0000-4000-8000-000000000002', '${ORG_SEM}', 'Só rascunho', 'p', true),
        ('eeee1111-0000-4000-8000-000000000003', '${ORG_ARQ}', 'Arquivado', 'p', true)
      on conflict do nothing;

    -- ai_agent_versions.channel_session_id aceita NULL no rascunho; a versão
    -- publicada carrega o canal por onde ela fala. O engine é quem age por
    -- canal, então o dublê da publicada tem de ter a linha de verdade.
    do $eng$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values
          ('eeee3333-0000-4000-8000-000000000001', '${ORG_PUB}', 'eng-pub-sess', '\\x00'::bytea),
          ('eeee3333-0000-4000-8000-000000000003', '${ORG_ARQ}', 'eng-arq-sess', '\\x00'::bytea);
    exception when unique_violation then null; end $eng$;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
      values
        ('eeee2222-0000-4000-8000-000000000001', '${ORG_PUB}', 'eeee1111-0000-4000-8000-000000000001', 1, 'p', 'anthropic', 'claude-sonnet-4-6', 'eeee3333-0000-4000-8000-000000000001', 'published'),
        ('eeee2222-0000-4000-8000-000000000003', '${ORG_ARQ}', 'eeee1111-0000-4000-8000-000000000003', 1, 'p', 'anthropic', 'claude-sonnet-4-6', 'eeee3333-0000-4000-8000-000000000003', 'published')
      on conflict do nothing;

    update public.ai_agents set published_version_id = 'eeee2222-0000-4000-8000-000000000001'
      where id = 'eeee1111-0000-4000-8000-000000000001';
    update public.ai_agents
       set published_version_id = 'eeee2222-0000-4000-8000-000000000003',
           archived_at = now()
      where id = 'eeee1111-0000-4000-8000-000000000003';
  `);
}

describe("#129 — um dono por resposta", () => {
  it("o cenário foi semeado (guarda de vacuidade)", () => {
    semear();
    // Sem isto, um seed que falhasse em silêncio faria os três casos abaixo
    // medirem organizações vazias — e "nenhum dos dois age" passaria como se
    // fosse partição correta.
    expect(sql(`select count(*) from public.ai_agents where organization_id in ('${ORG_PUB}','${ORG_SEM}','${ORG_ARQ}');`)).toBe("3");
  });

  it("org com versão publicada: o engine é dono e o embutido CEDE", () => {
    semear();
    expect(engineTemDono(ORG_PUB)).toBe(true);
    expect(embutidoCede(ORG_PUB)).toBe(true);
  });

  it("org sem publicação: o engine NÃO é dono e o embutido segue respondendo", () => {
    // O caso que impede a trava de silenciar a IA de quem nunca publicou — sem
    // `published_version_id` o engine não seleciona agente nenhum.
    semear();
    expect(engineTemDono(ORG_SEM)).toBe(false);
    expect(
      embutidoCede(ORG_SEM),
      "ceder aqui deixaria a organização sem NENHUM runtime respondendo",
    ).toBe(false);
  });

  it("agente arquivado não conta para nenhum dos dois", () => {
    semear();
    expect(engineTemDono(ORG_ARQ)).toBe(false);
    expect(embutidoCede(ORG_ARQ)).toBe(false);
  });

  it("os dois predicados PARTICIONAM: nunca ambos, nunca nenhum", () => {
    // A propriedade que de fato importa, afirmada sobre as três situações de
    // uma vez: `engineTemDono` e `!embutidoCede` têm de coincidir sempre. Se um
    // dia alguém mexer num dos dois lados sem o outro, é aqui que aparece.
    semear();
    for (const org of [ORG_PUB, ORG_SEM, ORG_ARQ]) {
      expect(engineTemDono(org), `org ${org}: os dois lados discordaram`).toBe(embutidoCede(org));
    }
  });
});
