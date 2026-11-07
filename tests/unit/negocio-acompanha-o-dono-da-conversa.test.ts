/**
 * #4019 — O NEGÓCIO ABERTO ACOMPANHA O DONO DA CONVERSA: CADA CAMINHO, E A RLS
 * QUE NÃO FOI AFROUXADA.
 *
 * ─── O que já está entregue (medido, com arquivo:linha no PR) ───────────────
 *
 * A régua desceu para a PORTA ÚNICA da atribuição, `fn_conversation_assign`
 * (migration 9208, PR #4046): transferir leva o negócio aberto do contato;
 * assumir, fila, carteira e passagem só dão dono a negócio SEM responsável.
 * Como todo caminho de troca de dono passa por essa função, o negócio acompanha
 * sem que nenhuma rota repita a regra.
 *
 * ─── O que este arquivo cerca ───────────────────────────────────────────────
 *
 * Que os caminhos CONTINUEM passando pela porta única — um `update` direto de
 * `crm_leads.owner_user_id` numa rota voltaria a deixar o card para trás nas
 * outras. E que a permissão continue sendo a de quem clicou: a escrita do
 * negócio dentro da definer exige `fn_can_view_lead` sobre o responsável ATUAL
 * (o USING de `crm_leads_update`) e sobre o NOVO (o WITH CHECK). Se alguém
 * "consertar" o caminho 1 do #4019 apagando essa condição, o teste fica
 * vermelho: a RLS não se afrouxa por dentro.
 *
 * O caminho 1 (Atendente transferindo para colega em `own_and_unassigned`) e o
 * caminho 4 (contato com mais de um negócio aberto) NÃO são consertados aqui —
 * são decisão de produto, e o teste abaixo fixa o comportamento atual para que
 * a decisão seja tomada de propósito, não por acidente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8");
const BASELINE = ler("supabase/baseline.sql");

/** A ÚLTIMA definição de `fn_conversation_assign` no baseline (a vigente). */
function ultimaDefinicaoDeAssign(): string {
  const marca = "create or replace function public.fn_conversation_assign(";
  const inicio = BASELINE.lastIndexOf(marca);
  expect(inicio, "fn_conversation_assign sumiu do baseline").toBeGreaterThan(-1);
  const fim = BASELINE.indexOf("$function$;", inicio);
  expect(fim, "fn_conversation_assign sem fecho $function$").toBeGreaterThan(inicio);
  return BASELINE.slice(inicio, fim);
}

describe("#4019 — cada caminho de troca de dono passa pela porta única", () => {
  /** caminho → [arquivo, trecho que prova a chamada da porta única] */
  const CAMINHOS: Array<[string, string, string[]]> = [
    [
      "transferir (tela)",
      "app/api/v1/conversations/[id]/transfer/route.ts",
      ['rpc("fn_conversation_assign"', 'p_reason: "transfer"'],
    ],
    [
      "assumir (botão Assumir e Iniciar conversa)",
      "lib/inbox/assumir-conversa.ts",
      ['rpc("fn_conversation_assign"', 'p_reason: "claim"'],
    ],
    [
      "assumir (rota /claim, pelo mesmo helper)",
      "app/api/v1/conversations/[id]/claim/route.ts",
      ["assumirConversaComEfeitos"],
    ],
    [
      "reativar o bot (libera a conversa para a IA)",
      "lib/escalacao/retomada.ts",
      ['rpc("fn_conversation_assign"', 'p_reason: "release"', "p_to_user_id: null"],
    ],
    [
      "fora da tela (MCP crm_assign_conversation)",
      "lib/mcp/tools/governance.ts",
      ['rpc("fn_conversation_assign"'],
    ],
    [
      "fila automática (worker de roteamento)",
      "lib/routing/worker.ts",
      ['rpc("fn_channel_routing_claim"'],
    ],
    [
      "passagem para humano (MCP)",
      "lib/mcp/tools/handoff.ts",
      ['rpc("fn_channel_routing_claim"'],
    ],
  ];

  for (const [nome, arquivo, trechos] of CAMINHOS) {
    it(`${nome} — ${arquivo}`, () => {
      const fonte = ler(arquivo);
      for (const trecho of trechos) {
        expect(fonte, `${arquivo} não contém ${trecho}`).toContain(trecho);
      }
    });
  }

  it("nenhuma rota de conversa escreve o dono do negócio por fora da porta única", () => {
    // A régua mora dentro da função; rota que faz `update crm_leads owner_user_id`
    // à mão deixaria os outros caminhos para trás — é o defeito que o #4019 mede.
    // O worker de roteamento é a exceção declarada: `adotarLeadsDoContato` adota
    // negócio SEM dono (issue #144), e o teste seguinte prova a guarda.
    const rotas = [
      "app/api/v1/conversations/[id]/transfer/route.ts",
      "app/api/v1/conversations/[id]/claim/route.ts",
      "app/api/v1/conversations/[id]/reactivate-bot/route.ts",
      "lib/inbox/assumir-conversa.ts",
      "lib/mcp/tools/governance.ts",
      "lib/mcp/tools/handoff.ts",
    ];
    for (const rota of rotas) {
      const fonte = ler(rota);
      expect(fonte, `${rota} mexe em crm_leads por fora da fn_conversation_assign`).not.toMatch(
        /from\("crm_leads"\)[\s\S]{0,200}?\.update\(\{[^}]*owner_user_id/,
      );
    }
  });

  it("a adoção do worker só toca negócio SEM dono (nem humano, nem agente de IA)", () => {
    const fonte = ler("lib/routing/worker.ts");
    const inicio = fonte.indexOf('from("crm_leads")');
    expect(inicio).toBeGreaterThan(-1);
    const trecho = fonte.slice(inicio, inicio + 900);
    expect(trecho).toContain('.is("owner_user_id", null)');
    expect(trecho).toContain('.is("owner_agent_id", null)');
  });
});

describe("#4019 — a escrita do negócio dentro da porta única e a RLS de crm_leads", () => {
  it("a porta única leva o negócio aberto quando o contato tem UM só", () => {
    const fn = ultimaDefinicaoDeAssign();
    expect(fn).toContain("-- ─── #4019: o NEGÓCIO ABERTO do contato acompanha o dono novo");
    expect(fn).toContain("l.status = 'open'");
    expect(fn).toContain("set owner_user_id = p_to_user_id");
    expect(fn).toContain("owner_kind = 'user'");
  });

  it("só 'transfer' leva negócio que JÁ tem responsável (o resto só preenche vazio)", () => {
    const fn = ultimaDefinicaoDeAssign();
    expect(fn).toContain("v_so_sem_dono boolean := p_negocio_so_sem_dono or p_reason is distinct from 'transfer'");
    expect(fn).toContain("v_negocio.owner_user_id is null and v_negocio.owner_agent_id is null");
  });

  it("⭐ a definer NÃO afrouxa a RLS: exige fn_can_view_lead no responsável atual E no novo", () => {
    const fn = ultimaDefinicaoDeAssign();
    expect(fn).toContain("auth.uid() is null");
    expect(fn).toMatch(
      /public\.fn_can_view_lead\(p_organization_id, v_negocio\.owner_user_id\)[\s\S]{0,120}public\.fn_can_view_lead\(p_organization_id, p_to_user_id\)/,
    );
  });

  it("a policy crm_leads_update continua visibility-aware (USING e WITH CHECK)", () => {
    const inicio = BASELINE.lastIndexOf('create policy "crm_leads_update"');
    expect(inicio).toBeGreaterThan(-1);
    const policy = BASELINE.slice(inicio, BASELINE.indexOf("create policy \"crm_leads_delete\"", inicio));
    // USING e WITH CHECK, os dois, com a mesma régua: é o que recusa o Atendente
    // entregando o negócio a uma colega em `own_and_unassigned` (caminho 1).
    expect(policy.match(/fn_can_view_lead\(organization_id, owner_user_id\)/g)).toHaveLength(2);
    expect(policy).toContain("with check");
  });

  it("caminho 1 e caminho 4 continuam INTOCADOS — decisão de produto, não acidente", () => {
    // Dois abertos ⇒ nada é tocado (nenhuma escolha por adivinhação)…
    const fn = ultimaDefinicaoDeAssign();
    expect(fn).toContain("if v_negocios = 1 then");
    // …e a recusa ao Atendente é a da RLS, não um atalho privilegiado.
    const invariante = ler("tests/invariants/negocio-aberto-acompanha-o-dono.test.ts");
    expect(invariante).toContain("caminho 1: atendente transfere em own_and_unassigned");
  });
});
