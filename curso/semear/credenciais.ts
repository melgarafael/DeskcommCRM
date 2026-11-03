/**
 * Semente do módulo Credenciais (/app/ai/credentials): as chaves de IA da
 * Clínica Bem Viver, uma em cada selo que o cartão mostra.
 *
 *  - "Chave de testes" (DeepSeek): guardada há dias sem resultado da
 *    conferência — selo "Não validada" (passou a janela de 2 minutos de
 *    `hooks/ai/useCredentials.ts`).
 *  - "Chave antiga da recepção" (Requesty): recusada na conferência
 *    (`auth_failed_401`, o código que `lib/ai/provider-validators.ts` grava
 *    quando o provedor responde 401/403) — selo "Inválida" e a frase da recusa.
 *  - "Chave principal" (Provedor personalizado): aceita na conferência — selo
 *    "Validada", com a lista de modelos que o endereço devolveu.
 *
 * As chaves são FICTÍCIAS e cifradas como o produto cifra (AES-256-GCM com a
 * AI_CRED_AES_KEY do app, o envelope de `lib/crypto/aes_gcm.ts`): nenhuma vale
 * em provedor nenhum, e as lições não clicam em "Salvar e validar", nem em
 * "Revalidar", nem salvam chave nova — os três chamariam o provedor. O único
 * clique que grava é renomear (PATCH só com o nome, que não testa nada).
 *
 * POR QUE ESTES PROVEDORES, e não a Anthropic: a semente fica no banco depois
 * da aula, e outras telas leem estas linhas.
 *  - Nenhuma da Anthropic: o editor da Bia (aula Agentes) mostra "Cadastrar
 *    credencial anthropic" justamente porque não há chave anthropic nenhuma.
 *  - Nenhuma da OpenAI, da OpenRouter nem do Google: elas preparam o material do
 *    Conhecimento (`lib/ai/embeddings/chave.ts`), e aquela aula fotografa a
 *    clínica SEM chave de embedding.
 *  - A única VALIDADA é a do provedor personalizado, que não tem modelo no
 *    catálogo (`ai_models`): o seletor do classificador dos Roteadores
 *    (`lib/ai/classifier-models.ts`) continua sem opção, como aquela aula diz.
 *  - Nenhuma do Jev (TypeSafe): o cartão do Jev em Provedores muda com ela.
 * O que NÃO dá para evitar: a tela Provedores esconde o aviso "Você ainda não
 * cadastrou a chave..." quando existe QUALQUER chave ativa. Por isso `limpar`
 * apaga estas linhas antes de toda aula, e elas só existem durante esta.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria — a lição que
 * renomeia uma chave volta ao nome original na próxima rodada. Nenhuma versão de
 * agente aponta para estas chaves (a Bia usa a chave da instalação), então o
 * apagar não esbarra na FK `ON DELETE RESTRICT`.
 */
import { createCipheriv, randomBytes } from "node:crypto";

import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const credencialId =(n: number) => `d1140000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIA = 24 * 60;

const bytea = (b: Buffer) => `\\x${b.toString("hex")}`;
/** O envelope de `lib/crypto/aes_gcm.ts` (encryptKey + bufToBytea), sem importar o env do app. */
function cifrada(chave: string) {
  const segredo = Buffer.from(process.env.AI_CRED_AES_KEY ?? "", "base64");
  if (segredo.length !== 32) throw new Error("credenciais: AI_CRED_AES_KEY ausente ou sem 32 bytes (o .env.e2e tem)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", segredo, iv);
  const ct = Buffer.concat([c.update(chave, "utf8"), c.final()]);
  return {
    api_key_encrypted: bytea(ct),
    api_key_iv: bytea(iv),
    api_key_tag: bytea(c.getAuthTag()),
    api_key_last4: chave.slice(-4),
  };
}

/** A base chama antes de QUALQUER aula: com uma chave ativa, Provedores esconde o aviso de chave ausente. */
export async function limpar(c: Contexto) {
  semErro(
    await c.db.from("ai_provider_credentials").delete().eq("organization_id", c.org).in("id", [1, 2, 3].map(credencialId)),
    "limpar as chaves do curso",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  await limpar(c);

  const CHAVES = [
    {
      n: 1,
      provider: "custom",
      label: "Chave principal",
      chave: "sk-cursoBemViver-principal-nao-vale-7Kq2",
      base_url: "https://ia.clinicabemviver.com.br/v1",
      criada: ha(40 * DIA),
      validated_at: ha(40 * DIA - 1),
      validation_error: null,
      models_available: ["gpt-4o-mini", "gpt-4o", "llama-3.1-70b-instruct"],
    },
    {
      n: 2,
      provider: "requesty",
      label: "Chave antiga da recepção",
      chave: "rqsty-cursoBemViver-antiga-nao-vale-Rx8m",
      base_url: null,
      criada: ha(200 * DIA),
      validated_at: null,
      validation_error: "auth_failed_401",
      models_available: null,
    },
    {
      n: 3,
      provider: "deepseek",
      label: "Chave de testes",
      chave: "sk-cursoBemViver-testes-nao-vale-d41f",
      base_url: null,
      criada: ha(3 * DIA),
      validated_at: null,
      validation_error: null,
      models_available: null,
    },
  ];

  semErro(
    await db.from("ai_provider_credentials").insert(
      CHAVES.map((k) => ({
        id: credencialId(k.n),
        organization_id: org,
        provider: k.provider,
        label: demo(k.label),
        ...cifrada(k.chave),
        base_url: k.base_url,
        validated_at: k.validated_at,
        validation_error: k.validation_error,
        models_available: k.models_available,
        is_active: true,
        created_by: pessoa.helena,
        created_at: k.criada,
        updated_at: k.criada,
      })),
    ),
    "chaves do curso",
  );
}
