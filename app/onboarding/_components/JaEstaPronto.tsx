import type { RetratoDaInstalacao } from "@/lib/instalacao/retrato";

/**
 * A primeira coisa que a pessoa lê no wizard: o que ela JÁ tem.
 *
 * Quem chega aqui acabou de instalar o sistema num servidor — escolheu a
 * inteligência artificial, colou a chave, subiu o WhatsApp — e era recebido por
 * um formulário em branco, como se tivesse acabado de chegar. Começar pelo que
 * já está pronto muda a pergunta de "quanto trabalho me espera?" para "o que
 * falta?".
 *
 * Cada linha é MEDIDA, nunca presumida. É o oposto do aviso que o painel de
 * provedores dá hoje ("tudo usa a chave que veio na instalação"), disparado sem
 * verificar se existe chave — a frase que tranquiliza enquanto o funcionário
 * está mudo.
 */
export function JaEstaPronto({ retrato }: { retrato: RetratoDaInstalacao }) {
  const itens: { pronto: boolean; texto: string }[] = [
    {
      pronto: true,
      texto: "Servidor no ar e banco de dados instalado",
    },
    {
      // Três estados, não dois: cadastrada-e-confirmada, cadastrada-e-sendo-
      // conferida, e nenhuma. A do meio existe porque a validação roda em
      // segundo plano — e dizer "falta a chave" a quem acabou de colá-la é a
      // frase que manda a pessoa cadastrar de novo o que já está lá.
      pronto: retrato.inteligencia.origemDaChave !== "nenhuma",
      texto:
        retrato.inteligencia.origemDaChave !== "nenhuma"
          ? `Inteligência contratada: ${retrato.inteligencia.rotulo}`
          : retrato.inteligencia.chaveEmVerificacao
            ? "Chave registada — a conferir com a empresa de IA"
            : "Falta a chave da inteligência artificial",
    },
    {
      pronto: retrato.whatsapp.transporteApontado,
      texto: retrato.whatsapp.transporteApontado
        ? "WhatsApp pronto para conectar seu número"
        : "O WhatsApp desta instalação ainda não subiu",
    },
    {
      pronto: Boolean(retrato.funil),
      texto: retrato.funil
        ? `Funil de vendas criado: ${retrato.funil.nome}`
        : "Nenhum funil de vendas ainda",
    },
  ];

  const faltando = itens.filter((i) => !i.pronto).length;

  return (
    <section
      aria-labelledby="ja-pronto"
      className="rounded-lg border bg-background p-5"
    >
      <h3 id="ja-pronto" className="text-sm font-medium">
        Você já instalou o sistema. Isto aqui já está pronto:
      </h3>
      <ul className="mt-3 space-y-1.5 text-sm">
        {itens.map((it) => (
          <li key={it.texto} className="flex items-start gap-2">
            <span
              aria-hidden
              className={
                "mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
                (it.pronto ? "bg-emerald-500" : "bg-amber-500")
              }
            />
            <span className={it.pronto ? "" : "text-muted-foreground"}>{it.texto}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        {faltando === 0
          ? "Agora é montar quem vai atender por si."
          : "O que falta nós resolvemos nos próximos passos."}
      </p>
    </section>
  );
}
