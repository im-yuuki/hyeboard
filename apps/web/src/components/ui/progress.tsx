import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ProgressProps = Omit<ComponentProps<"div">, "children"> & {
  value?: number;
  min?: number;
  max?: number;
};

export function Progress({ value = 0, min = 0, max = 100, className, ...props }: ProgressProps) {
  const safeMax = max > min ? max : min + 1;
  const normalizedValue = Math.max(min, Math.min(safeMax, value));
  const percentage = (normalizedValue - min) / (safeMax - min) * 100;
  return (
    <div
      {...props}
      role="progressbar"
      aria-valuemin={min}
      aria-valuemax={safeMax}
      aria-valuenow={normalizedValue}
      className={cn("h-2 overflow-hidden rounded-full bg-secondary", className)}
    >
      <div className="h-full bg-primary transition-all" style={{ width: `${percentage}%` }} />
    </div>
  );
}
