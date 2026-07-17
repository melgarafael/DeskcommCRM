"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTransferConversation } from "@/hooks/inbox/useTransferConversation";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const ROLE_LABEL: Record<string, string> = {
  agent: "Atendente",
  manager: "Gestor",
  admin: "Admin",
};

/**
 * G3-01 — transferência imediata (decisão G1-06d): reatribui a conversa a
 * outro atendente da org, com motivo opcional. Cada transferência vira evento
 * auditável em conversation_assignment_events.
 */
export function ReassignDialog({ conversationId, open, onOpenChange }: Props) {
  const { user } = useAuth();
  const members = useAssignableMembers(open);
  const transfer = useTransferConversation();
  const [toUserId, setToUserId] = useState<string>("");
  const [reason, setReason] = useState("");

  const options = (members.data ?? []).filter((m) => m.user_id !== user.id);

  function close(v: boolean) {
    if (!v) {
      setToUserId("");
      setReason("");
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transferir conversa</DialogTitle>
          <DialogDescription>
            A transferência é imediata: o atendente escolhido vira o responsável agora e a mudança
            fica registrada no histórico.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reassign-target">Transferir para</Label>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger id="reassign-target" className="w-full">
                <SelectValue
                  placeholder={members.isLoading ? "Carregando atendentes…" : "Escolha o atendente"}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? `Atendente ${m.user_id.slice(0, 8)}`}
                    <span className="ml-1 text-muted-foreground">
                      · {ROLE_LABEL[m.role] ?? m.role}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!members.isLoading && options.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nenhum outro atendente disponível nesta organização.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reassign-reason">Motivo (opcional)</Label>
            <Textarea
              id="reassign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: cliente pediu falar com o financeiro"
              maxLength={500}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!toUserId || transfer.isPending}
            onClick={() =>
              transfer.mutate(
                {
                  conversation_id: conversationId,
                  to_user_id: toUserId,
                  reason: reason.trim() || undefined,
                },
                { onSuccess: () => close(false) },
              )
            }
          >
            {transfer.isPending ? "Transferindo…" : "Transferir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
