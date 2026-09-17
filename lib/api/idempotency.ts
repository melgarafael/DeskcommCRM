/**
 * Idempotência de POST no nível da rota — replay e conflito.
 *
 * O contrato está em `docs/specs/01-spec-platform-base.md` §7.3 e em
 * `CLAUDE.md`: POST de criação aceita `Idempotency-Key: <uuid>`; mesma chave
 * com o mesmo corpo devolve a resposta gravada; mesma chave com corpo
 * diferente devolve 409 `idempotency_conflict`; a janela é de 24h.
 *
 * Até aqui havia DUAS implementações e nenhuma compartilhada:
 * `admin/tenants` usa RPC transacional e `lgpd/requests/[id]/approve` faz
 * leitura e gravação no próprio handler. Este arquivo é a terceira, e a
 * primeira reutilizável. `lib/api/README.md` já anunciava um
 * `lib/api/idempotency.ts` que não existia.
 *
 * ── O que este helper garante ────────────────────────────────────────────────
 * 1. MESMA chave + MESMO corpo: devolve a resposta gravada, **sem reexecutar**.
 * 2. MESMA chave + corpo DIFERENTE: devolve `conflito`, para o chamador
 *    responder 409 `idempotency_conflict`.
 * 3. Recibo VENCIDO não conta: a mesma chave depois de 24h é operação nova,
 *    como a spec promete.
 *
 * ── O que este helper NÃO garante, e por quê ─────────────────────────────────
 * A CORRIDA entre duas requisições simultâneas com a mesma chave.
 *
 * `idempotency_keys.status_code` e `.response_body` são `NOT NULL`
 * (`supabase/baseline.sql:1555-1556`) e só existem DEPOIS que o efeito
 * acontece: a tabela só sabe representar recibo terminal, então não há onde
 * gravar "esta chave está em curso" e recusar o segundo pedido. O intervalo
 * entre a leitura e o efeito fica aberto.
 *
 * O caminho robusto do repositório é outro e já existe: RPC que faz reserva e
 * efeito na MESMA transação — `fn_create_tenant_with_owner`
 * (`baseline.sql:18217`) e `fn_reserve_channel_connection`
 * (`baseline.sql:22566`). Funciona porque lá o efeito é SQL. Aqui o efeito é
 * código de aplicação, que não cabe na transação do recibo.
 *
 * Fechar essa corrida neste caminho exige mudança de schema (`status_code`
 * nulável, ou um estado explícito de "em curso") — tripla de migration +
 * `pnpm test:db`. É decisão de projeto, e por isso está como pergunta no PR em
 * vez de embutida aqui.
 *
 * O caso de corrida que ESTE helper cobre é o da gravação: se o recibo já
 * existir quando formos inserir (23505 pela constraint única
 * `idempotency_keys_organization_id_key_endpoint_key`), relemos e devolvemos
 * replay ou conflito, em vez de estourar 500.
 *
 * ── Falha ao gravar o recibo ────────────────────────────────────────────────
 * Se o efeito já aconteceu e a gravação do recibo falha, o desfecho devolvido
 * é `executou` — não erro. Devolver erro faria o cliente retentar e DUPLICAR o
 * efeito, que é exatamente o que a idempotência existe para evitar. A
 * gravação é, portanto, best-effort, e quem chama pode registrar o aviso.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Chave do header, nas duas grafias que o HTTP aceita. */
export function chaveDaRequisicao(req: Request): string | null {
  return req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
}

/** 24h — o TTL que a spec 01 §7.3 fixa, e o mesmo default da coluna. */
export const TTL_MS = 24 * 60 * 60 * 1000;

export type Recibo = {
  request_hash: string;
  status_code: number;
  response_body: unknown;
};

/**
 * Hash do corpo da requisição. É o que distingue "mesma operação" de "mesma
 * chave, operação diferente" — e a única coisa que autoriza devolver a
 * resposta gravada.
 *
 * A serialização dos campos é ordenada: `JSON.stringify` depende da ordem das
 * chaves, e dois corpos iguais com ordem diferente não podem virar conflito.
 */
export function hashDoCorpo(corpo: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(ordenar(corpo)))
    .digest("hex");
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor && typeof valor === "object") {
    const saida: Record<string, unknown> = {};
    for (const chave of Object.keys(valor as Record<string, unknown>).sort()) {
      saida[chave] = ordenar((valor as Record<string, unknown>)[chave]);
    }
    return saida;
  }
  return valor;
}

export type DesfechoIdempotente<T> =
  | { tipo: "executou"; resposta: T; status: number }
  /** A resposta gravada da primeira execução, devolvida sem reexecutar. */
  | { tipo: "replay"; resposta: T; status: number }
  /** Mesma chave, corpo diferente: o chamador responde 409. */
  | { tipo: "conflito" };

export type EntradaDaIdempotencia<T> = {
  /** Cliente Supabase com sessão. A policy `idempotency_tenant` cobre a org. */
  db: SupabaseClient;
  organizationId: string;
  endpoint: string;
  chave: string;
  /** O corpo já validado, que define a identidade da operação. */
  corpo: unknown;
  /** O efeito. Só é chamado quando não há recibo válido para esta chave. */
  executar: () => Promise<{ resposta: T; status: number }>;
  /** Relógio injetado — o repo testa janela de tempo assim, não com sleep. */
  agora?: () => Date;
};

export async function comIdempotencia<T>(
  entrada: EntradaDaIdempotencia<T>,
): Promise<DesfechoIdempotente<T>> {
  const { db, organizationId, endpoint, chave, corpo, executar } = entrada;
  const agora = entrada.agora ?? (() => new Date());
  const hash = hashDoCorpo(corpo);

  const lerRecibo = async (): Promise<Recibo | null> => {
    const { data } = await db
      .from("idempotency_keys")
      .select("request_hash, status_code, response_body")
      .eq("organization_id", organizationId)
      .eq("key", chave)
      .eq("endpoint", endpoint)
      .gt("expires_at", agora().toISOString())
      .maybeSingle();
    return (data as Recibo | null) ?? null;
  };

  const classificar = (recibo: Recibo): DesfechoIdempotente<T> =>
    recibo.request_hash === hash
      ? { tipo: "replay", resposta: recibo.response_body as T, status: recibo.status_code }
      : { tipo: "conflito" };

  const anterior = await lerRecibo();
  if (anterior) return classificar(anterior);

  const { resposta, status } = await executar();

  const expiraEm = new Date(agora().getTime() + TTL_MS).toISOString();
  const { error } = await db.from("idempotency_keys").insert({
    organization_id: organizationId,
    key: chave,
    endpoint,
    request_hash: hash,
    status_code: status,
    response_body: resposta as unknown as Record<string, unknown>,
    expires_at: expiraEm,
  });

  // 23505: alguém gravou este mesmo recibo entre a leitura e agora. O efeito
  // desta requisição já aconteceu; o que podemos fazer é reler e classificar,
  // para que a resposta não seja um 500 opaco.
  if (error) {
    const colisao = (error as { code?: string }).code === "23505";
    if (!colisao) return { tipo: "executou", resposta, status };
    const gravado = await lerRecibo();
    if (gravado) return classificar(gravado);
  }

  return { tipo: "executou", resposta, status };
}
