/**
 * GET|POST /api/v1/webhooks/instagram — o webhook de mensagens do Instagram.
 *
 * A Meta exige um webhook configurado no produto "Instagram" mesmo quando o
 * único uso é publicar conteúdo — o caso de uso "Gerenciar mensagens e
 * conteúdo no Instagram" bundla os dois, e o painel não deixa salvar a tela
 * sem um Callback URL + Verify Token que respondam ao handshake.
 *
 * `GET` é esse handshake (mesmo contrato do webhook da WhatsApp Cloud API,
 * `lib/channels/meta/webhook.ts`): devolve `hub.challenge` em texto puro
 * quando `hub.verify_token` bate.
 *
 * `POST` não processa nada ainda — não usamos mensageria do Instagram, só
 * publicação (que é OAuth + Graph API, não webhook). Responde 200 sempre,
 * porque um evento que não nos interessa não deve virar reentrega em
 * backoff da Meta.
 */
import { NextResponse, type NextRequest } from "next/server";

import { verificationChallenge } from "@/lib/channels/meta/webhook";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const challenge = verificationChallenge(
    req.nextUrl.searchParams,
    env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
  );
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(): Promise<NextResponse> {
  return new NextResponse("ok", { status: 200 });
}
