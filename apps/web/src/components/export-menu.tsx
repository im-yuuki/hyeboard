import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { downloadExport, type ExportDocument, type ExportFormat } from "@/lib/data-export";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ExportAttemptState = { failed: boolean; attempt: number };

export function nextExportAttemptState(state: ExportAttemptState, outcome: "success" | "failure"): ExportAttemptState {
  if (outcome === "failure") return { failed: true, attempt: state.attempt + 1 };
  return { failed: false, attempt: state.attempt };
}

export function ExportMenu({ model, className }: { model: ExportDocument; className?: string }) {
  const { t } = useLocale();
  const [attemptState, setAttemptState] = useState<ExportAttemptState>({ failed: false, attempt: 0 });

  const chooseFormat = (format: ExportFormat) => {
    try {
      downloadExport(model, format);
      setAttemptState((state) => nextExportAttemptState(state, "success"));
    } catch {
      setAttemptState((state) => nextExportAttemptState(state, "failure"));
    }
  };

  return (
    <div className={cn("min-w-0", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="min-h-11 gap-2">
            <Download className="h-4 w-4" aria-hidden="true" />
            {t.exports.action}
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem className="min-h-11" onSelect={() => chooseFormat("json")}>{t.exports.json}</DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => chooseFormat("csv")}>{t.exports.csv}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {attemptState.failed ? (
        <p key={attemptState.attempt} className="mt-1 max-w-72 text-xs text-destructive" role="status" aria-live="polite">
          {t.exports.failed}
        </p>
      ) : null}
    </div>
  );
}
