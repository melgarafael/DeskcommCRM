/**
 * O menu do Admin da plataforma, lido de lib/admin/navegacao.ts.
 *
 * O Admin não está em lib/navigation/catalogo.ts (aquele registro é da empresa,
 * `app/app/**`). A lista vive num módulo que importa ícones — importá-lo num
 * script arrastaria React e a biblioteca de ícones. Então se lê o TEXTO da
 * lista. Se o formato mudar e a leitura voltar vazia, quem usa falha alto (ver
 * o teste em licoes.test.ts).
 *
 * A lista morava em components/admin/AdminSidebar.tsx e mudou de endereço
 * quando a busca (⌘K) do painel virou o segundo consumidor dela — mesma fonte
 * para o menu e para a busca, em vez de duas cópias que divergem.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ARQUIVO = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "admin", "navegacao.ts");

export type ItemDoAdmin = { href: string; rotulo: string };

export function menuDoAdmin(): ItemDoAdmin[] {
  const fonte = readFileSync(ARQUIVO, "utf8");
  const itens = [...fonte.matchAll(/\{\s*href:\s*"(\/admin\/[a-z0-9/-]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({
    href: m[1]!,
    rotulo: m[2]!,
  }));
  if (itens.length === 0) throw new Error(`nenhum item lido do menu do Admin em ${ARQUIVO} — o formato da lista mudou?`);
  // A Atualização não está no menu do Admin nem no catálogo: a porta é o rodapé de
  // versão (tests/unit/navegacao-completude.test.ts), e só o dono da instalação a abre.
  return [...itens, { href: "/app/settings/atualizacao", rotulo: "Atualização do sistema" }];
}
