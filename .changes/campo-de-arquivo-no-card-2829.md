---
impacto: capacidade_nova
secao: adicionado
titulo: O card do funil mostra os arquivos dos campos do tipo arquivo
---

O campo personalizado do tipo arquivo já podia ser criado e já recebia upload no dossiê do negócio, mas o card do funil não o mostrava: o operador subia o contrato e o quadro não dizia que aquele negócio tinha documento.

Agora o card mostra, por campo, a contagem e o nome de cada arquivo, com o total real mesmo quando há mais do que cabe na linha. Clicar abre o documento pela mesma rota autenticada de mídia, com URL assinada de curta duração, e não abre o dossiê por cima. Campo declarado e vazio aparece com zero e o aviso de que não há arquivo anexado, em vez de desaparecer.

Nada muda para quem nunca criou um campo desse tipo: nenhuma consulta nova e nenhum dado a mais na resposta do quadro. Se a sua integração lê a rota do quadro de um funil que tem campo de arquivo, cada negócio passa a trazer também o campo `anexos`. Nenhuma migração de banco é necessária: os anexos já moram na tabela própria, criada com o campo.

As travas de etapa (só mover o negócio quando o documento exigido estiver anexado) não entram nesta fatia. Crédito: @webtecnica.
