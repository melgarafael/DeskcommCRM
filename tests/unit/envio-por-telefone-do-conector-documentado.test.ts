// @vitest-environment node
/**
 * O contrato que o conector do DeskVoice copia é o contrato que a rota pratica
 * (#4513).
 *
 * `docs/integracao/envio-de-mensagem-por-telefone.md` existe para ser copiado
 * por quem escreve o conector — e a classe de defeito que este gate pega é a
 * que já mordeu este repo em 2026-08-14: a afirmação que envelheceu sem
 * ninguém voltar. Um guia que promete `phone_number` e um schema que renomeou
 * o campo é pior que guia nenhum, porque quem copia conclui que o CRM está
 * quebrado.
 *
 * O gate não compara PROSA: ele lê o documento e confere cada valor que um
 * integrador digita (`Idempotency-Key`, códigos de erro, limites do telefone,
 * a janela de 24 h, as funções que resolvem a conversa) contra o CÓDIGO que
 * responde. Mexer num sem o outro deixa vermelho.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const GUIA = path.join(RAIZ, "docs", "integracao", "envio-de-mensagem-por-telefone.md");
const ROTA = path.join(RAIZ, "app", "api", "v1", "messages", "route.ts");
const SCHEMA = path.join(RAIZ, "lib", "schemas", "messaging.ts");
const IDEMPOTENCIA = path.join(RAIZ, "lib", "api", "idempotency.ts");
const ABERTURA = path.join(RAIZ, "lib", "messaging", "open-shared-contact-conversation.ts");

function ler(caminho: string): string {
  expect(fs.existsSync(caminho), `sumiu: ${path.relative(RAIZ, caminho)}`).toBe(true);
  return fs.readFileSync(caminho, "utf8");
}

/** Toda frase que o guia promete precisa existir no código que a cumpre. */
function prometeNoGuia(termo: string): void {
  expect(ler(GUIA)).toContain(termo);
}

function contemNoCodigo(caminho: string, termo: string): void {
  expect(ler(caminho), `${path.relative(RAIZ, caminho)} não tem mais \`${termo}\``).toContain(termo);
}

describe("o guia do envio por telefone descreve o que a rota faz", () => {
  it("o documento existe e é endereçado a quem escreve o conector", () => {
    const guia = ler(GUIA);
    expect(guia).toMatch(/conector/i);
    expect(guia).toContain("POST /api/v1/messages");
    // O caminho que o integrador usa para conferir sozinho a fonte da verdade.
    prometeNoGuia("app/api/v1/messages/route.ts");
    prometeNoGuia("lib/schemas/messaging.ts");
  });

  it("os dois identificadores documentados são os que o schema aceita", () => {
    const schema = ler(SCHEMA);
    // O nome do schema por telefone é o que a rota valida: renomear um sem o
    // outro troca o contrato em silêncio.
    expect(schema).toContain("export const sendMessagePorTelefoneSchema");
    contemNoCodigo(ROTA, "sendMessagePorTelefoneSchema");
    prometeNoGuia("conversation_id");
    prometeNoGuia("phone_number");
    // Os limites do telefone que o guia publica são os do schema, não a
    // memória de quem escreveu o guia.
    expect(schema).toMatch(/phone_number:\s*z\.string\(\)\.min\(8\)\.max\(32\)/);
    prometeNoGuia("8");
    prometeNoGuia("32");
  });

  it("a ambiguidade tem o código de erro que o guia manda tratar", () => {
    contemNoCodigo(ROTA, '"ambiguous_target"');
    prometeNoGuia("ambiguous_target");
    // Os dois juntos são recusa ANTES de qualquer efeito: o guia promete isso.
    expect(ler(ROTA)).toMatch(/entrada\.conversation_id\s*&&\s*entrada\.phone_number\?\.trim\(\)/);
  });

  it("a idempotência documentada é a que a rota aplica (24 h, mesma chave, 409)", () => {
    contemNoCodigo(IDEMPOTENCIA, "export const TTL_MS = 24 * 60 * 60 * 1000");
    prometeNoGuia("24");
    prometeNoGuia("Idempotency-Key");
    contemNoCodigo(ROTA, '"idempotency_conflict"');
    prometeNoGuia("idempotency_conflict");
    contemNoCodigo(ROTA, '"idempotency_in_progress"');
    prometeNoGuia("idempotency_in_progress");
    // A chave é UUID e malformada vira 400, não recibo.
    contemNoCodigo(ROTA, "Idempotency-Key deve ser UUID");
    prometeNoGuia("UUID");
  });

  it("o escopo exigido é o mesmo da autenticação de servidor", () => {
    contemNoCodigo(ROTA, 'scope: "mcp:write"');
    prometeNoGuia("mcp:write");
  });

  it("a resolução da conversa é a função que o guia cita — não uma segunda regra", () => {
    contemNoCodigo(ABERTURA, "export async function openSharedContactConversation");
    prometeNoGuia("openSharedContactConversation");
    // Quem grava contato novo é esta função, com a organização da consulta e
    // `nao_sei` no WhatsApp (DES-1950): o guia promete as duas coisas.
    contemNoCodigo(ABERTURA, "organization_id: orgId,");
    contemNoCodigo(ABERTURA, 'phone_whatsapp: input.phone_whatsapp ?? "nao_sei"');
    prometeNoGuia("nao_sei");
    prometeNoGuia("fn_upsert_wa_contact");
  });

  it("o guia não deixa a organização ser um campo do corpo", () => {
    const guia = ler(GUIA);
    // O conector precisa saber que não existe `organization_id` no corpo: quem
    // tenta mandar um espera que ele seja ignorado, e o guia tem de dizer isso.
    expect(guia).toMatch(/organiza[çc][ãa]o/i);
    expect(guia).toMatch(/token/i);
  });
});
