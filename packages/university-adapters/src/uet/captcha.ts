import { HyeboardError } from "@hyeboard/core";

export type CaptchaOcrSolver = (imageDataUrl: string, signal?: AbortSignal) => Promise<string | undefined>;

let captchaOcrSolver: CaptchaOcrSolver | undefined;

export function setCaptchaOcrSolver(solver: CaptchaOcrSolver | undefined): void {
  captchaOcrSolver = solver;
}

export async function resolveCaptchaAnswer(
  imageDataUrl: string,
  onCaptchaNeeded?: (imageDataUrl: string, signal?: AbortSignal) => Promise<string>,
  options: { skipOcr?: boolean; signal?: AbortSignal } = {},
): Promise<{ answer: string; source: "ocr" | "human" }> {
  throwIfAborted(options.signal);
  if (!options.skipOcr && captchaOcrSolver) {
    const ocrAnswer = options.signal ? captchaOcrSolver(imageDataUrl, options.signal) : captchaOcrSolver(imageDataUrl);
    const answer = (await awaitAbortable(ocrAnswer, options.signal).catch((error) => {
      if (options.signal?.aborted) throw error;
      return undefined;
    }))?.trim();
    if (answer) return { answer, source: "ocr" };
  }

  const humanAnswer = options.signal ? onCaptchaNeeded?.(imageDataUrl, options.signal) : onCaptchaNeeded?.(imageDataUrl);
  const answer = (await awaitAbortable(humanAnswer, options.signal))?.trim();
  if (answer) return { answer, source: "human" };

  throw new HyeboardError(
    "STUDENTHUB_CAPTCHA_REQUIRED",
    "This sign-in requires a verification code that could not be completed automatically.",
    422,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function awaitAbortable<T>(operation: Promise<T> | undefined, signal?: AbortSignal): Promise<T | undefined> {
  if (!operation) return undefined;
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
