import { cn } from "@/lib/utils";

/**
 * O esqueleto de carregamento.
 *
 * ─── O defeito que esta versão fecha ────────────────────────────────────────
 *
 * A classe era `animate-pulse rounded-md bg-primary/10`, e `bg-primary/10` — a
 * accent a 10% — dá contraste **1,146:1 sobre branco**. O esqueleto não era
 * discreto: era invisível. A tela de carregamento parecia uma tela VAZIA, e a
 * diferença entre "está vindo" e "não tem nada" é a diferença entre esperar e
 * ir embora.
 *
 * Quem mediu foi `components/agenda/estados.tsx:34-44`, que contornou o
 * problema localmente com `bg-neutral-400` e deixou escrito que consertar o
 * primitivo era item de produto, não conserto de passagem — havia 113 usos em
 * 51 arquivos. É este o PR que faz o conserto subir para cá.
 *
 * ─── Por que o desenho mudou de pulso para faixa ───────────────────────────
 *
 * `animate-pulse` oscila a opacidade entre 1 e .5, então o esqueleto vivia
 * entre dois contrastes — e o pior deles, 1,525:1, é quase invisível de novo:
 * metade de cada ciclo desfazia o conserto. A faixa que atravessa mantém o
 * corpo sempre no piso medido e só passa por cima dele uma faixa de contraste
 * MAIOR. O movimento nunca vai para baixo.
 *
 * Toda a régua — a tabela de medições, os 1.6s e por que o brilho anda em
 * direções opostas no tema claro e no escuro — está no bloco `.ds-esqueleto` de
 * `app/globals.css`. Aqui fica só o nome.
 *
 * ─── O que acontece com os `bg-neutral-400` escritos à mão ─────────────────
 *
 * Eles ficam INERTES, e o resultado continua certo. `background-image` pinta
 * ACIMA de `background-color` na ordem de pintura do CSS, então o gradiente de
 * `.ds-esqueleto` cobre o fundo sólido que `estados.tsx` passa — a cor dele não
 * aparece mais. Não é perda: `neutral-400` é exatamente o corpo do gradiente,
 * porque foi daquela medição que ele saiu. A tela que já tinha a cor certa
 * continua com ela, só que agora pelo primitivo.
 *
 * Limpar aqueles `bg-neutral-400` é varredura para outro PR. Deixá-los não
 * custa nada, e tirá-los agora mexeria na única tela que estava correta.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // `data-esqueleto` é a âncora de teste, e ela existe por um susto real.
  //
  // `tests/unit/inbox-media-image.test.tsx` procurava o esqueleto por
  // `document.querySelector(".animate-pulse")` — a classe da implementação. Ao
  // trocá-la por `ds-esqueleto`, o caso de PRESENÇA reprovou (certo) e o de
  // AUSÊNCIA passou a valer **vácuo**: `not.toBeInTheDocument()` contra um
  // seletor que nunca casa com nada passa sempre, e passaria mesmo com o
  // esqueleto preso na tela para sempre.
  //
  // Classe é implementação e muda; "isto é um esqueleto" é contrato e não muda.
  // Por isso o atributo — no mesmo padrão de `data-rodape-ocupado` e
  // `data-quadro-do-funil`, que o produto já usa para ser medido.
  return <div data-esqueleto className={cn("ds-esqueleto rounded-md", className)} {...props} />;
}

export { Skeleton };
