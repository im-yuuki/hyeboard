import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { downloadExport, printExport, type ExportDocument, type ExportFormat } from "@/lib/data-export";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type ExportAttemptState = { failed: boolean; attempt: number };

export function nextExportAttemptState(state: ExportAttemptState, outcome: "success" | "failure"): ExportAttemptState {
  if (outcome === "failure") return { failed: true, attempt: state.attempt + 1 };
  return { failed: false, attempt: state.attempt };
}

export function ExportMenu({ model, className }: { model: ExportDocument; className?: string }) {
  const { t } = useLocale();
  const [attemptState, setAttemptState] = useState<{ kind?: "download" | "print"; attempt: number }>({ attempt: 0 });

  const chooseFormat = (format: ExportFormat) => {
    try {
      downloadExport(model, format);
      setAttemptState((state) => ({ attempt: state.attempt }));
    } catch {
      setAttemptState((state) => ({ kind: "download", attempt: state.attempt + 1 }));
    }
  };
  const choosePrint = () => {
    try {
      printExport(model, document.documentElement.lang || "en", t.exports.printLabels);
      setAttemptState((state) => ({ attempt: state.attempt }));
    } catch {
      setAttemptState((state) => ({ kind: "print", attempt: state.attempt + 1 }));
    }
  };

  return (
    <div className={cn("min-w-0", className)} data-export-surface={model.surface}>
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
          <DropdownMenuItem className="min-h-11" onSelect={choosePrint}>{t.exports.print}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {attemptState.kind ? (
        <p key={attemptState.attempt} className="mt-1 max-w-72 text-xs text-destructive" role="status" aria-live="polite">
          {attemptState.kind === "print" ? t.exports.printFailed : t.exports.failed}
        </p>
      ) : null}
    </div>
  );
}
