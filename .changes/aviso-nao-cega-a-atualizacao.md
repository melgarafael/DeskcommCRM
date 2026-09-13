---
impacto: capacidade_nova
secao: corrigido
titulo: O aviso de manutenção deixa de cegar a própria atualização
---

O aviso que aparece durante a atualização assumia a porta **inteira** — inclusive a conversa que o próprio atualizador tem com o sistema para dizer em que passo está. Ele recebia a página de volta, em vez de uma resposta, e ficava mudo justamente na janela que precisa narrar.

Agora o aviso responde a **pessoa** com a página e a **máquina** com uma resposta curta de "indisponível". A tela de atualização volta a contar o andamento.

Medido na instalação real antes do conserto: 18 KB de página dentro do registro de erro do atualizador, a cada atualização.
