import { createHash } from "node:crypto";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { gerarIconeDoApp, lerArquivoDoIcone } from "@/lib/branding/icone-do-app";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { marcaDaSaida } from "@/lib/branding/saida";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export const dynamic = "force-dynamic";
const tamanho = z.enum(["192", "512"]);

/** Leitura pública da mesma marca que o login mostra; nenhum dado de tenant. */
export async function GET(request: Request, { params }: { params: Promise<{ size: string }> }) {
  const lido = tamanho.safeParse((await params).size);
  if (!lido.success) return fail("invalid_request", "Tamanho de ícone inválido.", 400);
  const ip = ipDoCliente(request.headers) ?? "local";
  const chave = createHash("sha256").update(ip).digest("hex");
  const limite = await checkRateLimit(`app-icon:${chave}`, 60, 60);
  if (!limite.allowed) return fail("rate_limited", "Muitas leituras de ícone.", 429);
  const marca = await marcaDaSaida(null);
  const linha = await marcaDaInstalacao();
  const arquivo = await lerArquivoDoIcone(linha?.favicon_path);
  const corpo = await gerarIconeDoApp(lido.data === "192" ? 192 : 512, marca, arquivo);
  return new Response(corpo, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
      "x-content-type-options": "nosniff",
    },
  });
}
