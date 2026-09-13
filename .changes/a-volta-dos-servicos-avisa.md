---
impacto: capacidade_nova
secao: corrigido
titulo: Se alguma peça do banco não voltar depois da atualização, você fica sabendo
---

A atualização pausa alguns serviços enquanto mexe no banco e os devolve no fim. **Numa instalação real, eles não voltaram** — e a atualização mesmo assim disse "concluída com sucesso". O sistema ficou sem ler nem gravar até alguém perceber.

O motivo de ninguém ter percebido é o de sempre por aqui: a volta era **muda**. Se falhasse, não sobrava rastro nenhum.

Agora ela confere peça por peça, tenta uma segunda vez, e — se ainda faltar alguma — **avisa em vermelho, dizendo o nome de cada uma** e o comando para subir à mão.

E o aviso não toca à toa: quando tudo volta, ele fica calado. Alarme que dispara sem motivo ensina quem opera a ignorar o alarme de verdade.

*(A causa de as peças não terem voltado naquela vez segue desconhecida. O que este ajuste garante é que uma próxima vez não passe despercebida.)*
