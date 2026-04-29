"use client";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useResolveIncident } from "@/hooks/useResolveIncident";

interface ResolveIncidentDialogProps {
  incidentId: string;
}

export function ResolveIncidentDialog({ incidentId }: ResolveIncidentDialogProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { mutate, isPending } = useResolveIncident();

  const isValid = note.trim().length >= 10;

  function handleResolve() {
    if (!isValid) return;
    mutate(
      { id: incidentId, resolution_note: note.trim() },
      {
        onSuccess: () => {
          setOpen(false);
          setNote("");
        },
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="default" size="sm">
          Resolver incidente
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resolver incidente</AlertDialogTitle>
          <AlertDialogDescription>
            Descreva como o incidente foi resolvido. Esta ação é registrada no
            audit log e não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="resolution-note">
            Nota de resolução{" "}
            <span className="text-muted-foreground font-normal">(mín. 10 caracteres)</span>
          </Label>
          <Textarea
            id="resolution-note"
            placeholder="Descreva a causa raiz e as ações tomadas para resolver o incidente..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            className="resize-none"
            disabled={isPending}
          />
          {note.trim().length > 0 && note.trim().length < 10 && (
            <p className="text-xs text-destructive">
              Mínimo de 10 caracteres ({note.trim().length}/10)
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleResolve}
            disabled={!isValid || isPending}
          >
            {isPending ? "Resolvendo..." : "Confirmar resolução"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
