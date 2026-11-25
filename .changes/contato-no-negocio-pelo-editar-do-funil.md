---
impacto: capacidade_nova
secao: adicionado
titulo: O negócio criado pelo funil passa a receber um contato existente pela tela de edição
---

Quem abre o negócio pelo funil não passa pela tela de Contatos: o negócio nascia sem ninguém, e as telas só sabiam dizer que faltava contato. O campo já existia na API — o `PATCH /api/v1/leads/{id}` aceita `contact_id` desde sempre —, mas nenhuma tela mandava, então o negócio "oco" continuava oco.

Agora o "Editar negócio" do card tem o campo **Contato do negócio**: ele mostra quem está vinculado e permite escolher outro entre os contatos que já existem, pela busca da própria lista de contatos (a mesma que casa variações de telefone). Este fluxo não cria contato — a régua de telefone do cadastro continua num lugar só —, então nenhum contato duplicado nasce por aqui.

O que não mudou: o cadastro de contato e a criação de negócio seguem idênticos, salvar o negócio sem mexer no contato não reenvia o vínculo, e trocar o contato de um negócio com venda registrada não reabre o Valor.

Contribuição de @webtecnica (#852).
