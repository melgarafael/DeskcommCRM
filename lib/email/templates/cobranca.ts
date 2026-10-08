/**
 * O e-mail da cobrança do revendedor (spec §7a, §7d): aviso da régua à empresa
 * e troca de chave ao dono. Mesmo molde do convite (`./invite.ts`): estilo
 * inline, nenhum asset externo além do logo da marca, cores da régua do produto
 * e o accent da marca no botão. O botão é o link de PAGAMENTO quando há um —
 * pagar em um clique é o que recupera a receita.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import type { Idioma } from "@/lib/i18n/idiomas";

export interface EmailDaCobranca {
  titulo: string;
  corpo: string;
  marca: MarcaDeSaida;
  botao: { rotulo: string; href: string } | null;
  rodape: string;
  idioma: Idioma;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export function buildEmailDaCobranca(o: EmailDaCobranca): { subject: string; html: string; text: string } {
  const logo = o.marca.logoUrl
    ? `<p style="margin:0 0 24px"><img src="${escapar(o.marca.logoUrl)}" alt="${escapar(o.marca.nome)}" height="40" style="height:40px;width:auto;max-width:200px;border:0;display:block"></p>`
    : "";
  const botao = o.botao
    ? `<p style="margin:24px 0"><a href="${escapar(o.botao.href)}" style="display:inline-block;padding:12px 24px;background:${o.marca.accent};color:${o.marca.accentFg};border-radius:6px;text-decoration:none;font-weight:600">${escapar(o.botao.rotulo)}</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="${o.idioma}">
<body style="margin:0;padding:0;background:${NEUTROS_DE_SAIDA.fundo};font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${NEUTROS_DE_SAIDA.texto}">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    ${logo}
    <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;color:${NEUTROS_DE_SAIDA.texto}">${escapar(o.titulo)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapar(o.corpo)}</p>
    ${botao}
    <p style="margin:24px 0 0;font-size:12px;color:${NEUTROS_DE_SAIDA.suave}">${escapar(o.rodape)} — ${escapar(o.marca.nome)}</p>
  </div>
</body>
</html>`;
  const text = [o.titulo, "", o.corpo, ...(o.botao ? ["", `${o.botao.rotulo}: ${o.botao.href}`] : []), "", o.rodape].join("\n");
  return { subject: `${o.titulo} — ${o.marca.nome}`, html, text };
}
