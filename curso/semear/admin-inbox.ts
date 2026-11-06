/**
 * Semente do módulo Inbox (Admin): duas empresas de exemplo na instalação, com
 * conversas próprias, para a lista do Admin misturar empresas diferentes.
 *
 *  - Rede Sorriso Pleno (odontologia): a Rafaela Duarte escreveu há 2 minutos
 *    e vira a primeira da lista; tem e-mail cadastrado (o painel mostra mascarado).
 *  - NutriVida Consultório (nutrição): uma conversa com a IA e uma encerrada.
 *
 * Nenhuma tem Helena, Ana ou Carlos como membro: a Helena enxerga tudo por ser
 * admin da plataforma. A base apaga organizações extras antes de cada lição;
 * mesmo assim esta semente apaga as suas pelos ids fixos antes de recriar
 * (o cascade leva número, contatos, conversas e mensagens junto).
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const ORG = {
  sorriso: "ab100000-0000-4000-8000-000000000001",
  nutri: "ab100000-0000-4000-8000-000000000002",
};
const contato = (n: number) => `ab200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conversaDoAdmin = (n: number) => `ab300000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Msg = { min: number; de: "cliente" | "ia"; texto: string };
const CONVERSAS: Array<{
  n: number; org: keyof typeof ORG; nome: string; telefone: string; email?: string;
  status: "open" | "ai_handling" | "closed"; naoLidas: number; msgs: Msg[];
}> = [
  {
    n: 1, org: "sorriso", nome: "Rafaela Duarte", telefone: "+5511976540101", email: "rafaela.duarte@gmail.com", status: "open", naoLidas: 2,
    msgs: [
      { min: 9, de: "cliente", texto: "Boa tarde! Fiz o clareamento ontem na unidade de Moema." },
      { min: 8, de: "ia", texto: "Oi, Rafaela! Espero que tenha gostado do resultado. Em que posso ajudar?" },
      { min: 3, de: "cliente", texto: "Estou com os dentes bem sensíveis hoje. Isso é normal?" },
      { min: 2, de: "cliente", texto: "Queria falar com a dentista, por favor." },
    ],
  },
  {
    n: 2, org: "nutri", nome: "Sandra Lopes", telefone: "+5511976540202", status: "ai_handling", naoLidas: 0,
    msgs: [
      { min: 21, de: "cliente", texto: "Posso trocar o lanche da tarde por iogurte natural com aveia?" },
      { min: 20, de: "ia", texto: "Pode sim, Sandra! Iogurte natural com 2 colheres de aveia é uma ótima troca para o seu plano." },
    ],
  },
  {
    n: 3, org: "sorriso", nome: "Marcos Teles", telefone: "+5511976540303", status: "open", naoLidas: 1,
    msgs: [{ min: 70, de: "cliente", texto: "Consigo um encaixe para limpeza no sábado de manhã?" }],
  },
  {
    n: 4, org: "nutri", nome: "Gustavo Ramos", telefone: "+5511976540404", status: "closed", naoLidas: 0,
    msgs: [
      { min: 26 * 60, de: "cliente", texto: "Recebi o cardápio novo, muito obrigado!" },
      { min: 26 * 60 - 2, de: "ia", texto: "Que bom, Gustavo! Qualquer dúvida, é só chamar por aqui." },
    ],
  },
];

export async function semear(c: Contexto) {
  semErro(await c.db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await c.db.from("organizations").insert([
      { id: ORG.sorriso, slug: "rede-sorriso-pleno", legal_name: "Rede Sorriso Pleno Odontologia Ltda", display_name: "Rede Sorriso Pleno" },
      { id: ORG.nutri, slug: "nutrivida-consultorio", legal_name: "NutriVida Consultório de Nutrição Ltda", display_name: "NutriVida Consultório" },
    ].map((o) => ({ ...o, status: "active", onboarded_at: ha(60 * 24 * 40) }))),
    "empresas de exemplo",
  );

  const sessao: Record<keyof typeof ORG, string> = { sorriso: "", nutri: "" };
  for (const [chave, nome, sessaoNome, fone] of [
    ["sorriso", "Central Sorriso Pleno", "sorrisopleno-central", "+551130457700"],
    ["nutri", "NutriVida Atendimento", "nutrivida-atendimento", "+551130458800"],
  ] as const) {
    sessao[chave] = (exigir(
      await c.db.from("channel_sessions").insert({
        organization_id: ORG[chave], provider: "waha", waha_session_name: sessaoNome, webhook_secret_encrypted: "\\x00",
        status: "WORKING", phone_number: fone, display_name: nome,
      }).select("id").single(),
      `número ${nome}`,
    ) as { id: string }).id;
  }

  for (const cv of CONVERSAS) {
    const org = ORG[cv.org], ses = sessao[cv.org], ct = contato(cv.n), id = conversaDoAdmin(cv.n);
    semErro(await c.db.from("contacts").insert({ id: ct, organization_id: org, name: cv.nome, phone_number: cv.telefone, email: cv.email ?? null }), `contato ${cv.nome}`);
    semErro(await c.db.from("conversations").insert({ id, organization_id: org, contact_id: ct, channel_session_id: ses, status: "open" }), `conversa ${cv.nome}`);
    // mensagens ANTES do status: uma recebida reabre conversa fechada
    for (const m of cv.msgs) {
      const em = ha(m.min), recebida = m.de === "cliente";
      semErro(await c.db.from("messages").insert({
        organization_id: org, conversation_id: id, channel_session_id: ses, contact_id: ct,
        type: "text", body: m.texto, direction: recebida ? "inbound" : "outbound",
        status: recebida ? "received" : "read", sent_via: recebida ? "external_device" : "ai",
        sent_at: em, created_at: em, ...(recebida ? {} : { metadata: { ai_generated: true } }),
      }), `mensagem de ${cv.nome}`);
      semErro(await c.db.rpc("fn_mark_conversation_message", {
        p_conv: id, p_direction: recebida ? "inbound" : "outbound", p_preview: m.texto, p_at: em,
      }), `carimbo de ${cv.nome}`);
    }
    semErro(await c.db.from("conversations").update({ status: cv.status, unread_count_for_assignee: cv.naoLidas }).eq("id", id), `estado de ${cv.nome}`);
  }
}
