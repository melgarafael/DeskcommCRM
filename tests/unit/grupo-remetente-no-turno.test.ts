/**
 * #2729 — num GRUPO, a IA tem de saber QUEM escreveu cada mensagem.
 *
 * Três pessoas falam na mesma conversa (a empresa, o cliente e a dona). O dado
 * já é gravado desde a entrada dos grupos (`messages.metadata.group_sender`), mas
 * não chegava ao prompt: o turno lia todas as falas como "o cliente".
 *
 * Este arquivo vigia a RENDERIZAÇÃO — o que o modelo lê, e não a consulta que
 * busca o dado (essa é medida contra o banco em
 * `tests/invariants/historico-do-grupo-no-atendimento.test.ts`). Os dois lados
 * precisam existir: buscar e não renderizar é o mesmo que não buscar.
 *
 * Todos os casos têm CONTROLE 1:1 ao lado: numa conversa individual nada muda —
 * sem `sender` no histórico, sem `remetente` na mensagem atual. Um teste que só
 * olhasse o grupo passaria com um prompt que rotula todo mundo como participante.
 */
import { describe, expect, it } from "vitest";

import { buildOpeningMessage } from "@/lib/agent-engine/agent/abertura/ritual";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const DONA = { name: "Dona", phone: "+5511999990000" };
const CLIENTE = { name: "Cliente", phone: "+5511888880000" };

const contextoDeGrupo: LeadContext = {
  lead_id: "contato-do-grupo",
  contact_id: "contato-do-grupo",
  contact: {
    name: "Grupo da obra",
    phone: null,
    email: null,
    tags: [],
    is_blocked: false,
  },
  conversation_id: "conversa-do-grupo",
  last_human_decision: null,
  messages: [
    { direction: "inbound", body: "Bom dia, tudo bem?", sent_at: "2026-10-20T09:00:00-03:00", sender: DONA },
    { direction: "outbound", body: "Bom dia! Em que posso ajudar?", sent_at: "2026-10-20T09:01:00-03:00" },
    { direction: "inbound", body: "Quanto custa o metro?", sent_at: "2026-10-20T09:02:00-03:00", sender: CLIENTE },
  ],
};

const contextoUmParaUm: LeadContext = {
  ...contextoDeGrupo,
  contact: { ...contextoDeGrupo.contact, name: "Cliente", phone: "+5511888880000" },
  messages: [
    { direction: "inbound", body: "Bom dia, tudo bem?", sent_at: "2026-10-20T09:00:00-03:00" },
    { direction: "outbound", body: "Bom dia! Em que posso ajudar?", sent_at: "2026-10-20T09:01:00-03:00" },
    { direction: "inbound", body: "Quanto custa o metro?", sent_at: "2026-10-20T09:02:00-03:00" },
  ],
};

/** O ritual de abertura como o turno o monta: sem checkpoint, sem notas, sem tools. */
function abertura(ctx: LeadContext, atual?: { texto: string; de?: typeof CLIENTE }): string {
  return buildOpeningMessage(
    null,
    null,
    ctx,
    "—",
    false,
    [],
    "",
    atual?.texto,
    atual?.de,
  );
}

describe("#2729 — o histórico do grupo chega ao prompt com quem escreveu", () => {
  it("cada recebida do grupo traz o remetente; a enviada não inventa um", () => {
    const texto = abertura(contextoDeGrupo);
    expect(texto).toContain('"sender":{"name":"Dona","phone":"+5511999990000"}');
    expect(texto).toContain('"sender":{"name":"Cliente","phone":"+5511888880000"}');
    // Duas recebidas, dois remetentes — e o da outbound ("nós") não existe.
    expect(texto.match(/"sender":/g) ?? []).toHaveLength(2);
  });

  it("controle 1:1: sem remetente em lugar nenhum — o autor é o contato da ficha", () => {
    const texto = abertura(contextoUmParaUm);
    expect(texto).not.toContain('"sender"');
    expect(texto).not.toContain("+5511999990000");
  });
});

describe("#2729 — a mensagem ATUAL do grupo também diz quem falou", () => {
  it("o JSON da mensagem atual carrega `remetente`, e a instrução manda responder a ela", () => {
    const texto = abertura(contextoDeGrupo, { texto: "Quanto custa o metro?", de: CLIENTE });
    expect(texto).toContain('"remetente":"Cliente · +5511888880000"');
    expect(texto).toContain("é QUEM falou neste grupo");
  });

  it("controle 1:1: a mensagem atual não ganha `remetente` nem instrução de grupo", () => {
    const texto = abertura(contextoUmParaUm, { texto: "Quanto custa o metro?" });
    expect(texto).not.toContain('"remetente"');
    expect(texto).not.toContain("neste grupo");
  });
});

describe("#2729 — a projeção do contexto (turno sem ferramenta de catálogo) não apaga o autor", () => {
  it("com `projeta`, cada recebida do grupo mantém `quem` — nome e telefone", () => {
    const texto = buildOpeningMessage(null, null, contextoDeGrupo, "—", true, [], "", "Quanto custa o metro?", CLIENTE);
    expect(texto).toContain('"quem":"Dona · +5511999990000"');
    expect(texto).toContain('"quem":"Cliente · +5511888880000"');
    // A projeção continua fechando o que é endereço interno.
    expect(texto).not.toContain("conversa-do-grupo");
  });

  it("controle 1:1 projetado: nenhum `quem`", () => {
    const texto = buildOpeningMessage(null, null, contextoUmParaUm, "—", true, [], "", "Quanto custa o metro?");
    expect(texto).not.toContain('"quem"');
  });
});
