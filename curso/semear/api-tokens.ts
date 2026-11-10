/**
 * Semente do módulo "API Tokens": três chaves de integração da Clínica Bem
 * Viver — a da agenda online (ativa, com validade), a do assistente de IA da
 * recepção (ativa, sem validade) e a de uma planilha antiga (revogada).
 *
 * O hash guardado é de um texto que ninguém conhece: estas chaves não abrem
 * nada, só aparecem na lista. Idempotente: apaga as linhas de ids fixos daqui e
 * a chave que a lição "criar-um-token" cria pela tela (nome fixo).
 */
import { createHash, randomBytes } from "node:crypto";

import { type Contexto, ha, semErro } from "../semear-demonstracao";

const tokenId = (n: number) => `0a7c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** O que a lição cria pela tela — a semente apaga para a lição seguinte partir limpa. */
export const TOKEN_DA_LICAO = "Prontuário eletrônico da clínica";

const DIA = 24 * 60;
// Nunca guardar hash de um segredo previsível: as chaves são só cenográficas.
const hash = () => `\\x${createHash("sha256").update(randomBytes(32)).digest("hex")}`;
const daqui = (dias: number) => new Date(Date.now() + dias * DIA * 60_000).toISOString();

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  const ids = [1, 2, 3].map(tokenId);

  semErro(await db.from("api_tokens").delete().eq("organization_id", org).in("id", ids), "limpar chaves");
  semErro(await db.from("api_tokens").delete().eq("organization_id", org).eq("name", TOKEN_DA_LICAO), "limpar chave da lição");

  semErro(await db.from("api_tokens").insert([
    {
      id: tokenId(1), name: "Agenda online do site", prefix: "dsk_4f8a21c7",
      scopes: ["mcp:read", "mcp:write", "role:manager"],
      created_at: ha(20 * DIA), last_used_at: ha(15), expires_at: daqui(160),
    },
    {
      id: tokenId(2), name: "Assistente de IA da recepção", prefix: "dsk_b31e09d4",
      scopes: ["mcp:read", "mcp:write", "role:manager"],
      created_at: ha(8 * DIA), last_used_at: ha(2 * 60), expires_at: null,
    },
    {
      id: tokenId(3), name: "Planilha de pacientes (antiga)", prefix: "dsk_7c55e2a0",
      scopes: ["mcp:read"],
      created_at: ha(90 * DIA), last_used_at: ha(12 * DIA), expires_at: null,
      revoked_at: ha(10 * DIA), revoked_by: pessoa.helena,
    },
  ].map((t) => ({ ...t, organization_id: org, created_by: pessoa.helena, token_hash: hash(), updated_at: t.created_at }))), "chaves");
}
