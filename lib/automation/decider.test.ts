/**
 * A ficha que o `ai_decide` (#1970) manda ao provedor de LLM é uma LISTA FIXA.
 *
 * O contexto do motor traz as linhas INTEIRAS de `crm_leads` e `contacts`
 * (`select("*")`). O prompt é o que sai da instalação — então é nele, e não
 * numa função intermediária, que se procura o que não pode sair.
 */
import { describe, expect, it } from "vitest";

import { montarMensagemDaDecisao } from "@/lib/automation/decider";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

const OPCOES = [
  { id: "quente", rotulo: "Marcar como quente", acao: { type: "add_tag", config: { tags: ["quente"] } } },
  { id: "frio", rotulo: "Marcar como frio", acao: { type: "add_tag", config: { tags: ["frio"] } } },
];

const LINHA_DO_LEAD = {
  id: "lead-id-interno-1",
  organization_id: "org-id-interno-1",
  contact_id: "contato-id-interno-1",
  owner_user_id: "usuario-id-interno-1",
  pipeline_id: "funil-id-interno-1",
  stage_id: "etapa-id-interno-1",
  // A forma real: o título nasce do nome do contato (nascimento-do-lead.ts).
  title: "Fulana de Tal",
  status: "open",
  value_cents: 120000,
  currency: "BRL",
  tags: ["site"],
  custom_fields: { forma_de_pagamento: "parcelado" },
  source: "whatsapp",
  source_metadata: { ip: "10.0.0.1" },
};

const LINHA_DO_CONTATO = {
  id: "contato-id-interno-1",
  organization_id: "org-id-interno-1",
  name: "Fulana de Tal",
  display_name: "Fulana",
  email: "fulana@exemplo.test",
  email_normalized: "fulana@exemplo.test",
  phone_number: "+5511988887777",
  cpf_hash: "hash-de-cpf-interno",
  cpf_encrypted: "cpf-cifrado-interno",
  tags: ["cliente"],
  is_blocked: false,
};

const EVENTO = {
  lead_id: "lead-id-interno-1",
  contact_id: "contato-id-interno-1",
  from_phone: "+5511988887777",
  body_preview: "Dá para parcelar em 10x?",
};

describe("montarMensagemDaDecisao: o prompt só leva a lista fixa", () => {
  const prompt = montarMensagemDaDecisao({
    instrucao: "Se quer parcelar, quente; senão, frio.",
    opcoes: OPCOES,
    contexto: { event: EVENTO, lead: LINHA_DO_LEAD, contact: LINHA_DO_CONTATO },
  });

  it.each([
    ["e-mail", "fulana@exemplo.test"],
    ["telefone", "+5511988887777"],
    ["nome", "Fulana"],
    ["id do lead", "lead-id-interno-1"],
    ["id do contato", "contato-id-interno-1"],
    ["id da organização", "org-id-interno-1"],
    ["id do responsável", "usuario-id-interno-1"],
    ["id do funil", "funil-id-interno-1"],
    ["hash do CPF", "hash-de-cpf-interno"],
    ["CPF cifrado", "cpf-cifrado-interno"],
    ["metadado de origem", "10.0.0.1"],
  ])("não leva %s", (_rotulo, valor) => {
    expect(prompt).not.toContain(valor);
  });

  it("leva o que a decisão precisa: a mensagem, o negócio e as etiquetas", () => {
    for (const valor of ["Dá para parcelar em 10x?", "parcelado", "120000", "BRL", "cliente"]) {
      expect(prompt).toContain(valor);
    }
  });

  it("não leva o telefone quando ele virou o título do negócio (contato sem nome)", () => {
    const telefone = phoneForDisplay(LINHA_DO_CONTATO.phone_number);
    const semNome = montarMensagemDaDecisao({
      instrucao: "Se quer parcelar, quente; senão, frio.",
      opcoes: OPCOES,
      contexto: { event: EVENTO, lead: { ...LINHA_DO_LEAD, title: telefone }, contact: LINHA_DO_CONTATO },
    });
    expect(semNome).not.toContain(telefone);
  });
});
