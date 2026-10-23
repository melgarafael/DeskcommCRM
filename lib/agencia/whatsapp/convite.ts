import { marcaDaSaida } from "@/lib/branding/saida";

import { enfileirarWhatsappDaAgencia } from "./enfileirar";

/**
 * O texto do convite. O nome da agência sai da MARCA resolvida (banco acima do
 * `.env`), nunca escrito no código — `tests/unit/branding.test.ts` vigia isso.
 */
export function textoDoConvite(nomeDoMembro: string, nomeDaMarca: string, link: string): string {
  const primeiro = nomeDoMembro.trim().split(/\s+/)[0] ?? nomeDoMembro;
  return [
    `Olá, ${primeiro}!`,
    `Você foi convidado para a área da equipe da ${nomeDaMarca}.`,
    `Crie sua senha por este link (vale 7 dias): ${link}`,
  ].join("\n\n");
}

/**
 * Manda o link do convite pelo WhatsApp da agência. Devolve `false` quando não
 * há WhatsApp configurado — a tela então mostra o link para copiar (E4).
 */
export async function enviarConvitePeloWhatsapp(p: {
  conviteId: string;
  nome: string;
  whatsapp: string;
  link: string;
}): Promise<boolean> {
  const marca = await marcaDaSaida(null);
  const r = await enfileirarWhatsappDaAgencia({
    motivo: "convite",
    referenciaId: p.conviteId,
    telefone: p.whatsapp,
    corpo: textoDoConvite(p.nome, marca.nome, p.link),
  });
  return r.enfileirado;
}
