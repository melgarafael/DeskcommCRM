import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { resolveSentryDsn } from "@/lib/sentry/dsn";

/**
 * O TÚNEL DO SENTRY (`tunnelRoute` em `next.config.ts`, issue #5091).
 *
 * O rewrite do `@sentry/nextjs` nasce no BUILD, em toda imagem, e encaminha
 * para o ingest do Sentry o projeto que vier na query. Público sem sessão, ele
 * aceitaria qualquer coisa que casasse o rewrite. Esta guarda deixa passar só o
 * que o SDK DESTA instalação manda: o projeto do DSN em vigor, por POST, com
 * tamanho declarado e teto, e com frequência por IP limitada (DoD 6).
 *
 * `null` = segue o fluxo de sempre (o rewrite). Qualquer outra resposta é a
 * recusa, devolvida pelo proxy antes do `isPublicPath`.
 */
export const CAMINHO_DO_TUNEL = "/monitoring";

// ponytail: teto fixo de 1 MiB por envelope (erro + replay de erro cabem com
// folga). Se um envelope legítimo passar disso, vira knob de env.
export const TETO_DO_ENVELOPE_EM_BYTES = 1024 * 1024;
export const TETO_POR_IP = 60;
export const JANELA_SEGUNDOS = 60;

/** A mesma régua do SDK (`client/tunnelRoute.js`): só DSN do Sentry SaaS é tunelado. */
const HOST_DO_SENTRY_SAAS = /^o(\d+)\.ingest(?:\.([a-z]{2}))?\.sentry\.io$/;

interface Destino {
  o: string;
  p: string;
  r: string | null;
}

function destinoDoDsn(dsn: string | undefined): Destino | null {
  if (!dsn || !URL.canParse(dsn)) return null;
  const url = new URL(dsn);
  const [, organizacao, regiao] = url.hostname.match(HOST_DO_SENTRY_SAAS) ?? [];
  const projeto = url.pathname.split("/").filter(Boolean).pop();
  if (!organizacao || !projeto || !/^\d+$/.test(projeto)) return null;
  return { o: organizacao, p: projeto, r: regiao ?? null };
}

/** Cada parâmetro aparece no máximo uma vez e vale exatamente o esperado (`null` = ausente). */
function parametroConfere(query: URLSearchParams, nome: string, esperado: string | null): boolean {
  const valores = query.getAll(nome);
  return esperado === null ? valores.length === 0 : valores.length === 1 && valores[0] === esperado;
}

export async function recusaDoTunelDoSentry(
  request: NextRequest,
  dsnBruto: string | undefined,
): Promise<NextResponse | null> {
  const destino = destinoDoDsn(resolveSentryDsn(dsnBruto));
  // Telemetria desligada ou DSN que o SDK não tunela: o túnel não existe aqui.
  if (!destino) return new NextResponse(null, { status: 404 });

  if (request.method !== "POST") {
    return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
  }

  const query = request.nextUrl.searchParams;
  if (
    !parametroConfere(query, "o", destino.o) ||
    !parametroConfere(query, "p", destino.p) ||
    !parametroConfere(query, "r", destino.r)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const declarado = request.headers.get("content-length");
  if (declarado === null || !/^\d+$/.test(declarado)) {
    return new NextResponse(null, { status: 411 });
  }
  if (Number(declarado) > TETO_DO_ENVELOPE_EM_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // Sem IP identificável, sem balde: um balde comum trancaria todo navegador
  // de uma vez (mesma escolha de `app/api/v1/anuncios/*`).
  const ip = ipDoCliente(request.headers)?.slice(0, 64) ?? null;
  if (ip !== null) {
    const limite = await checkRateLimit(`sentry-tunel:${ip}`, TETO_POR_IP, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      return new NextResponse(null, {
        status: 429,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }
  }

  return null;
}
