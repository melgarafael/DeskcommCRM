/**
 * Monta o site do curso (curso/saida/index.html) a partir das lições, das
 * capturas medidas e do menu REAL do produto.
 *
 *   pnpm exec tsx curso/montar.ts
 *
 * Por padrão sai o corpo da página (o Artifact do claude.ai põe o esqueleto).
 * Para servir de um site — deskcomm.com.br/curso —, CURSO_BASE="/curso/" prefixa
 * o caminho das fotos e o arquivo sai como documento HTML completo.
 *
 * O menu lateral do curso é projetado de lib/navigation/catalogo.ts — o mesmo
 * array que desenha o sidebar do app —, então o aluno navega pelos mesmos
 * grupos e nomes que vai encontrar no sistema, e tela nova do produto aparece
 * no curso (como "em breve") sem ninguém lembrar de acrescentá-la.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GRUPO_NO_RODAPE, NAV_CATALOG, NAV_GROUPS } from "../lib/navigation/catalogo";
import { Modulo, chaveDoPasso } from "./licao";
import { Nicho, validarJornadas } from "./jornada";
import { menuDoAdmin } from "./menu-do-admin";
import { pastaDaSaida } from "./configuracao";

const RAIZ = path.dirname(new URL(import.meta.url).pathname);
const SAIDA = pastaDaSaida();
const ler = (f: string) => readFileSync(path.join(RAIZ, f), "utf8");

// `montar.ts inbox radar` monta só esses; sem argumento, todos
const soEstes = process.argv.slice(2);
function ordemDaTela(href: string): number {
  const i = NAV_CATALOG.findIndex((d) => d.href === href);
  return i >= 0 ? i : NAV_CATALOG.length + menuDoAdmin().findIndex((d) => d.href === href);
}
const todosModulos = readdirSync(path.join(RAIZ, "licoes"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => Modulo.parse(JSON.parse(ler(path.join("licoes", f)))))
  // ordem do menu do produto (a empresa, depois o Admin), para o curso seguir a ordem da tela
  .sort((a, b) => ordemDaTela(a.tela) - ordemDaTela(b.tela));

const modulos = todosModulos.filter((m) => soEstes.length === 0 || soEstes.includes(m.id));

const ADMIN = menuDoAdmin();
const telas = new Set<string>([...NAV_CATALOG.map((d) => d.href), ...ADMIN.map((i) => i.href)]);
for (const m of modulos) {
  if (!telas.has(m.tela))
    throw new Error(`módulo ${m.id}: a tela ${m.tela} não existe no catálogo nem no menu do Admin`);
}

const arquivoCapturas = path.join(SAIDA, "capturas.json");
if (!existsSync(arquivoCapturas))
  throw new Error("falta curso/saida/capturas.json — rode curso/capturar.ts antes");
const {
  largura,
  altura,
  capturas: manifesto,
  falhas = [],
} = JSON.parse(readFileSync(arquivoCapturas, "utf8"));

// O capturador conserva fotos anteriores; elas não podem esconder uma falha
// desta rodada, inclusive de revogação. Manifestos antigos não tinham `falhas`.
const modulosComFalha = modulos
  .filter((m) => {
    const chaves = new Set(m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id))));
    return falhas.some((falha: string) => chaves.has(falha)
      || falha.startsWith(`${m.id}/`) || falha.startsWith(`${m.id}:`));
  })
  .map((m) => m.id);
if (modulosComFalha.length) {
  throw new Error(
    `capturas com falha nos módulos selecionados: ${modulosComFalha.join(", ")} — capture novamente antes de montar`,
  );
}

const pastaJornadas = path.join(RAIZ, "demonstracoes");
const todosNichos = existsSync(pastaJornadas)
  ? readdirSync(pastaJornadas)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => Nicho.parse(JSON.parse(readFileSync(path.join(pastaJornadas, f), "utf8"))))
  : [];
// Recorte de desenvolvimento: não publicar histórias com links para lições omitidas.
const nichos = todosNichos
  .map((n) => ({
    ...n,
    jornadas: n.jornadas.filter((j) =>
      j.montagem.every((ref) => modulos.some((m) => m.id === ref.modulo)),
    ),
  }))
  .filter((n) => n.jornadas.length > 0);
// A montagem completa valida tudo; um recorte não depende das fotos omitidas.
validarJornadas(soEstes.length === 0 ? todosNichos : nichos, todosModulos, manifesto);
const cenasPendentes = nichos.flatMap((n) =>
  n.jornadas.flatMap((j) =>
    j.cenas.filter((c) => falhas.includes(c.captura)).map((c) => c.captura),
  ),
);
if (cenasPendentes.length) {
  throw new Error(
    `capturas pendentes nas jornadas publicadas: ${cenasPendentes.join(", ")} — recapture antes de montar`,
  );
}
const referenciadas = new Set([
  ...modulos.flatMap((m) =>
    m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id))),
  ),
  ...nichos.flatMap((n) => n.jornadas.flatMap((j) => j.cenas.map((c) => c.captura))),
]);
// Na ordem do curso, não na do manifesto: a do manifesto depende das rodadas que a bancada já fez.
const capturas = Object.fromEntries(
  [...referenciadas].filter((chave) => manifesto[chave]).map((chave) => [chave, manifesto[chave]]),
);
for (const [chave, captura] of Object.entries(capturas)) {
  const foto = (captura as { foto?: unknown }).foto;
  if (
    typeof foto !== "string" ||
    !/^(?:fotos|capturas)\/[a-zA-Z0-9_./-]+\.(png|webp|jpe?g)$/.test(foto) ||
    foto.split("/").includes("..") ||
    !existsSync(path.join(SAIDA, foto))
  ) {
    throw new Error(`foto ausente ou inválida: ${chave}`);
  }
}

const faltando = modulos.flatMap((m) =>
  m.licoes.flatMap((l) =>
    l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id)).filter((k) => !capturas[k]),
  ),
);
if (faltando.length)
  throw new Error(`passos sem foto (o capturar falhou neles?): ${faltando.join(", ")}`);

type ItemDoMenu = { href: string; rotulo: string; descricao: string; modulo: string | null };
const menu: Array<{ grupo: string; itens: ItemDoMenu[] }> = NAV_GROUPS.map((g) => ({
  // o grupo do rodapé aparece no produto pelo nome do hub ("Configurações"), não pelo id do grupo
  grupo: g.id === GRUPO_NO_RODAPE && g.hub ? g.hub.label : g.label,
  itens: NAV_CATALOG.filter(
    (d) =>
      d.group === g.id && (("sidebar" in d && d.sidebar) || modulos.some((m) => m.tela === d.href)),
  ).map((d) => ({
    href: d.href,
    rotulo: d.label,
    descricao: d.description,
    modulo: modulos.find((m) => m.tela === d.href)?.id ?? null,
  })),
})).filter((g) => g.itens.length);
// O Admin da plataforma: só quem administra a instalação vê; no curso, um grupo próprio no fim.
if (modulos.some((m) => m.tela.startsWith("/admin/"))) {
  menu.push({
    grupo: "Admin da plataforma",
    itens: ADMIN.map((i) => {
      const modulo = modulos.find((m) => m.tela === i.href);
      return {
        href: i.href,
        rotulo: i.rotulo,
        descricao: modulo?.resumo ?? "",
        modulo: modulo?.id ?? null,
      };
    }),
  });
}

const versao = (() => {
  // Fotos podem vir de rodadas antigas: a base local de git não diz qual app foi fotografado.
  if (process.env.CURSO_VERSAO_FOTOS) return process.env.CURSO_VERSAO_FOTOS.replace(/^v/, "");
  const versoes = [
    ...new Set(
      (Object.values(capturas) as Array<{ versao?: string }>).map((c) => c.versao).filter(Boolean),
    ),
  ];
  if (versoes.length) return versoes.join(" / ");
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: RAIZ,
      encoding: "utf8",
    })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "desconhecida";
  }
})();

// com base, a foto é absoluta: em /curso (sem barra final) um caminho relativo cairia na raiz do site
const BASE = process.env.CURSO_BASE ?? "";
if (BASE && !/^\/.*\/$/.test(BASE))
  throw new Error(`CURSO_BASE precisa começar e terminar com "/" (veio "${BASE}")`);
for (const c of Object.values(capturas) as Array<{ foto: string }>) c.foto = BASE + c.foto;

const dados = {
  versao,
  gerado: process.env.CURSO_DATA_FOTOS ?? new Date().toISOString().slice(0, 10),
  datas_das_fotos: [
    ...new Set(
      (Object.values(capturas) as Array<{ capturado_em?: string }>)
        .map((c) => c.capturado_em?.slice(0, 10))
        .filter(Boolean),
    ),
  ].sort(),
  largura,
  altura,
  modulos,
  nichos,
  capturas,
  menu,
};

// "<" escapado: o JSON vai dentro de <script>, e um "</script>" num texto de lição fecharia a tag
const json = JSON.stringify(dados).replace(/</g, "\\u003c");
const html = ler("site/pagina.html")
  .replace("/*ESTILO*/", () => ler("site/estilo.css") + "\n" + ler("site/demonstracoes.css"))
  .replace("/*DADOS*/", () => json)
  .replace("/*APP*/", () => ler("site/demonstracoes.js") + "\n" + ler("site/app.js"));
const DOCUMENTO = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Curso em imagens do DeskComm: cada tela do sistema com fotos reais, setas e um simulador para treinar.">
`;
writeFileSync(path.join(SAIDA, "index.html"), BASE ? DOCUMENTO + html : html);
console.info(
  `${path.relative(process.cwd(), path.join(SAIDA, "index.html"))} — ${modulos.length} módulo(s), ${Object.keys(capturas).length} fotos, versão ${versao}`,
);
