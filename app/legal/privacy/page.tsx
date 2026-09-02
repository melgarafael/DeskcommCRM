import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { nomeDoOperador, resolverOperador } from "@/lib/legal/operador";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Política de Privacidade" };

export default async function PrivacyPage() {
  const op = await resolverOperador();

  // O operador publicou a política dele: é a dele que vale. Sem isto, o campo
  // `privacy_policy_url` da tela de Organização continuaria sendo um controle
  // que o produto oferece e o código ignora. A URL já vem checada — valor cru
  // do banco nunca chega a um redirect.
  if (op.politicaPropria) redirect(op.politicaPropria);

  const operador = nomeDoOperador(op);

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Política de Privacidade</h1>
        <p className="text-muted-foreground">
          Como esta instalação do {op.sistema} trata dados pessoais.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">1. Quem é o controlador</h2>
        <p>
          O controlador dos dados tratados aqui é <strong>{operador}</strong>
          {op.nuit ? ` (NUIT ${op.nuit})` : ""} — quem instalou e opera este sistema. Os autores do
          software não têm acesso a este servidor nem aos dados guardados nele, e não são
          controladores nem operadores desses dados.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">2. Que dados são tratados</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>De quem é atendido:</strong> nome, telefone, e-mail quando informado, conteúdo
            das conversas, ficheiros enviados (imagens, áudios, documentos) e o histórico de negócios.
          </li>
          <li>
            <strong>De quem usa o sistema:</strong> nome, e-mail, papel de acesso e registo das
            ações realizadas.
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">3. Para que são usados</h2>
        <p>
          Para atender, responder, registar o andamento do atendimento e organizar a relação
          comercial — inclusive por agentes de inteligência artificial que atuam sob as regras
          configuradas pelo operador. Registos de ação são mantidos para auditoria e segurança.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">4. Com quem são partilhados</h2>
        <p>
          Os dados ficam no servidor do operador. Para funcionar, o sistema se comunica com
          terceiros escolhidos e contratados pelo operador:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>a plataforma de mensagens usada para conversar com o cliente;</li>
          <li>
            o provedor de inteligência artificial contratado pelo operador, que recebe o trecho da
            conversa necessário para gerar a resposta;
          </li>
          <li>o provedor de infraestrutura onde o servidor está hospedado.</li>
        </ul>
        <p>Os dados não são vendidos nem cedidos para publicidade de terceiros.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">5. Por quanto tempo</h2>
        <p>
          Conversas e registros de negócio são mantidos enquanto houver relação com o cliente ou
          obrigação legal de guarda. Arquivos de mídia têm prazo próprio, configurado pelo operador.
          Registros de auditoria são mantidos por período mais longo, por serem prova de quem fez o
          quê.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">6. Seus direitos</h2>
        <p>
          A Lei n.º 3/2017 (Moçambique) garante-lhe o direito de confirmar se há tratamento,
          aceder aos seus dados, corrigir dados incompletos ou desatualizados, pedir
          anonimização ou eliminação, saber com quem foram partilhados e revogar consentimento.
        </p>
        <p>
          O sistema atende esses pedidos por um fluxo próprio: a exportação reúne o que existe sobre
          a pessoa, e a anonimização remove a identificação preservando o histórico de atendimento —
          por isso ela <strong>não pode ser desfeita</strong>.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">7. Segurança</h2>
        <p>
          O acesso é controlado por conta, senha e papel, com verificação em duas etapas obrigatória
          para administradores. Cada organização hospedada só vê os próprios dados, e as chaves
          de integração são guardadas cifradas.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">8. Encarregado e contacto</h2>
        <p>
          {op.dpoEmail ? (
            <>
              Para exercer seus direitos ou tirar dúvidas sobre privacidade, fale com o encarregado
              de dados:{" "}
              <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
                {op.dpoEmail}
              </a>
              .
            </>
          ) : (
            <>
              O operador ainda não publicou um endereço de contacto do encarregado de dados nesta
              instalação. Os pedidos devem ser feitos pelos canais de atendimento da própria
              organização.
            </>
          )}
        </p>
      </section>
    </>
  );
}
