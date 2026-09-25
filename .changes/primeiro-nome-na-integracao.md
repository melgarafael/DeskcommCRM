---
impacto: nada_mudou
secao: corrigido
titulo: O primeiro nome do contato passa a sair nas automações de WhatsApp e nos modelos montados pela integração
---

Um modelo com a variável `{{primeiro_nome}}` saía com o espaço vazio ("Olá, !") quando era enviado por uma automação de WhatsApp ou montado pela ferramenta de integração `crm_render_message_template`, embora saísse certo quando inserido na conversa. Agora vale a mesma regra da conversa e das campanhas: a primeira palavra do nome do contato. Sem nome cadastrado, a variável continua listada como lacuna para quem montou o modelo.

Contribuição de @hiro-nikaitou (#1635), a partir do relato de @franceschini-lucas (#1616).
