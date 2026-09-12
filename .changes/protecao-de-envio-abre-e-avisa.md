---
impacto: nada_mudou
secao: corrigido
titulo: Proteção de envio abre depois de mexer nos canais — e nunca mais em silêncio
---

Quem criava, reconectava ou excluía uma conexão e logo abria a **Proteção de envio** encontrava o painel sem os dados daquela conexão. A lista de conexões era atualizada, mas a ficha de limites anti-ban (`pacing-knobs`) ficava com o cache velho. As duas andam juntas — agora qualquer mexida nos canais invalida as duas, e o painel abre com os números certos.

Pior era o outro lado: quando a conexão já não estava mais na lista (excluída em outra aba ou máquina), o painel simplesmente **não aparecia** e o botão morria mudo. Agora a mesma folha abre com uma mensagem honesta — a proteção desta conexão não pôde ser carregada, ela pode ter sido removida ou a lista está desatualizada — e duas saídas: **Tentar de novo**, que recarrega a lista (quando a conexão reaparece, o formulário volta sozinho), e **Fechar**.

Nada muda para quem abre a proteção de uma conexão que está na lista: o painel é o mesmo de sempre.
