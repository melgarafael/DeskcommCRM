import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import {
  CATALOGO_DA_INSTALACAO,
  type ChaveDaInstalacao,
  type GrupoDaInstalacao,
} from "@/lib/instalacao/catalogo";
import { estadoParaTela, type EstadoParaTela } from "@/lib/instalacao/config";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

import { PainelDeConfiguracao } from "./_form";

export const metadata = { title: "Configuração da instalação" };
export const dynamic = "force-dynamic";

/**
 * A ordem dos grupos é a ordem em que a instalação DÓI, não a alfabética.
 *
 * E-mail primeiro porque é o que falta em toda instalação nova — sem ele não sai
 * convite para a equipe nem recuperação de senha, e a pessoa descobre isso
 * quando já precisava. Depois o que ela pode querer conferir; por último o que
 * ela não troca aqui, que é referência e não tarefa.
 */
const ORDEM: readonly {
  grupo: GrupoDaInstalacao;
  titulo: string;
  resumo: string;
  ponteiro?: { href: string; texto: string };
}[] = [
  {
    grupo: "email",
    titulo: "E-mail",
    resumo: "Sem isto o sistema não envia convite para a equipe nem recuperação de senha.",
    ponteiro: {
      href: "/admin/email",
      texto: "O serviço de envio de e-mail — próprio ou externo — fica em E-mail →",
    },
  },
  {
    grupo: "seguranca",
    titulo: "Segurança e privacidade",
    resumo: "Contatos obrigatórios e as chaves que protegem o que está guardado.",
  },
  {
    grupo: "whatsapp",
    titulo: "WhatsApp",
    resumo: "As senhas que ligam o sistema ao programa que conecta o WhatsApp.",
  },
  { grupo: "banco", titulo: "Banco de dados", resumo: "Onde ficam todos os seus dados." },
  { grupo: "fila", titulo: "Fila de tarefas", resumo: "Controla o ritmo dos envios." },
  { grupo: "ia", titulo: "Inteligência artificial", resumo: "Como o atendimento automático opera." },
];

export interface LinhaDaTela {
  readonly definicao: ChaveDaInstalacao;
  readonly estado: EstadoParaTela;
}

export default async function Page() {
  const usuario = await loadAuthUser();
  // Gate local redundante com o layout de `(protected)`, de propósito: um layout
  // pode ser movido, e a única regra que não depende de vizinho é a que a
  // própria página aplica. `notFound()` e não 403 — para quem não administra a
  // instalação, esta tela não faz parte do produto.
  if (!usuario?.is_platform_admin) notFound();
  const idioma = normalizarIdioma(usuario.locale);

  // Uma ida ao banco por chave, em paralelo. Sem cache de propósito — ver o
  // cabeçalho de `lib/instalacao/config.ts`: com memo, a tela mostraria o valor
  // velho depois de uma troca, atrás de um aviso de sucesso.
  // ⚠️ SÓ O QUE MORA AQUI. A chave e o remetente do serviço externo de e-mail
  // saíram desta tela para `/admin/email` (DEC-009, opção A): "como o meu
  // servidor manda e-mail" é um assunto só, e estava dividido em duas telas.
  // O filtro é o catálogo, não uma lista escrita aqui — assim não há como as
  // duas telas mostrarem a mesma chave.
  const daTela = CATALOGO_DA_INSTALACAO.filter((d) => (d.telaDona ?? "credenciais") === "credenciais");

  const linhas: LinhaDaTela[] = await Promise.all(
    daTela.map(async (definicao) => ({
      definicao,
      estado: await estadoParaTela(definicao.chave, definicao.natureza === "segredo"),
    })),
  );

  const grupos = ORDEM.map((g) => ({
    ...g,
    linhas: linhas.filter((l) => l.definicao.grupo === g.grupo),
  })).filter((g) => g.linhas.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Configuração da instalação", idioma)}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          {traduzir(
            "O que este servidor precisa saber para funcionar. O que dá para trocar aqui, você troca e vale na hora — sem mexer no servidor.",
            idioma,
          )}
        </p>
      </div>

      <PainelDeConfiguracao grupos={grupos} idioma={idioma} />
    </div>
  );
}
