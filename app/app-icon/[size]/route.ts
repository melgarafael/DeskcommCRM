import { createHash } from "node:crypto";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { gerarIconeDoApp, lerArquivoDoIcone } from "@/lib/branding/icone-do-app";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { marcaDaSaida } from "@/lib/branding/saida";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export const dynamic = "force-dynamic";
const tamanho = z.enum(["180", "192", "512", "maskable"]);
/**
 * [lado, fração do lado que o desenho ocupa]. O 180 é o do iPhone, que
 * arredonda os cantos. O maskable fica no círculo de 80% que o Android mantém:
 * o maior quadrado dentro dele tem 0,8/√2 ≈ 0,566 do lado.
 */
const DESENHO = {
  "180": [180, 0.8],
  "192": [192, 1],
  "512": [512, 1],
  maskable: [512, 0.56],
} as const;

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
  const [lado, conteudo] = DESENHO[lido.data];
  const corpo = await gerarIconeDoApp(lado, marca, arquivo, conteudo);
  return new Response(corpo, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
      "x-content-type-options": "nosniff",
    },
  });
}
