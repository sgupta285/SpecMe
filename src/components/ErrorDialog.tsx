import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ErrorDialogState = {
  open: boolean;
  title: string;
  explanation: string;
  reason: string;
  nextSteps: string;
  technicalDetails?: string;
};

type ErrorDialogProps = {
  state: ErrorDialogState;
  onOpenChange: (open: boolean) => void;
};

export default function ErrorDialog({ state, onOpenChange }: ErrorDialogProps) {
  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state.title || "Action failed"}</DialogTitle>
          <DialogDescription>{state.explanation}</DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <div className="font-medium">Reason</div>
          <div className="mt-1 text-red-100/90">{state.reason}</div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
          <div className="font-medium">What to do next</div>
          <div className="mt-1 text-muted-foreground">{state.nextSteps}</div>
        </div>

        {state.technicalDetails ? (
          <details className="rounded-md border border-border bg-muted/10 p-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Show technical details
            </summary>
            <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-foreground/80">
              {state.technicalDetails}
            </pre>
          </details>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
