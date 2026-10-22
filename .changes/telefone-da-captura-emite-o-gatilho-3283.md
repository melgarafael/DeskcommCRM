---
impacto: nada_mudou
secao: corrigido
titulo: O telefone gravado sozinho na ficha também acorda a regra "Quando um contato ganhar um telefone"
---

Quando o cliente informa o telefone numa conversa e a ficha do contato estava sem número, o número entra sozinho no cadastro (com a opção da organização ligada) — mas por esse caminho a regra "Quando um contato ganhar um telefone" não rodava: nenhum envio de WhatsApp, nada na fila de automação, sem erro e sem aviso. Agora esse caminho emite o mesmo gatilho que a edição da ficha já emitia, com o número em formato internacional no conteúdo do evento, e só depois de o número estar gravado de fato — quem já tinha número, quem perdeu a corrida e o número que pertence a outro contato continuam não emitindo nada. A proteção contra laço entre regras segue valendo. Nada a fazer na atualização.
