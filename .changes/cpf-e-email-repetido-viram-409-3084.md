---
impacto: nada_mudou
secao: corrigido
titulo: CPF ou e-mail já usado por outro contato responde 409, não "erro interno"
---

Ao criar um contato com um CPF que já pertencia a outro contato da mesma organização, a API devolvia 500 com `duplicate key value violates unique constraint "uniq_contacts_org_cpf"` e a tela mostrava "erro interno" para um simples duplicado. O mesmo acontecia ao editar (PATCH) um contato com o e-mail de outro. Agora o CPF, o e-mail e o telefone respondem igual: 409 `contact_exists` com o `contact_id` de quem já tem o dado, o que permite à tela ou a uma integração abrir o contato existente. Nada a fazer na atualização.
