import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/lib/i18n";

export type CaptchaChallenge = { image: string; resolve: (answer: string) => void };

// Bridges api.importUetGoogleSession's promise-based onCaptchaNeeded callback
// to dialog state: exposes the pending challenge for rendering and resolves
// the promise with the user's answer on submit. The abort signal (stream
// failure, or the whole login being cancelled) dismisses the dialog and
// rejects the relay so the caller's error path runs.
export function useCaptchaRelay(cancelledMessage: string) {
  const [challenge, setChallenge] = useState<CaptchaChallenge>();
  const [answer, setAnswer] = useState("");

  const relayCaptcha = useCallback((imageDataUrl: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    const nextChallenge: CaptchaChallenge = {
      image: imageDataUrl,
      resolve: (value) => {
        signal.removeEventListener("abort", onAbort);
        setChallenge((current) => (current === nextChallenge ? undefined : current));
        setAnswer("");
        resolve(value);
      },
    };
    const onAbort = () => {
      setChallenge((current) => (current === nextChallenge ? undefined : current));
      setAnswer("");
      reject(signal.reason ?? new DOMException(cancelledMessage, "AbortError"));
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      setChallenge(nextChallenge);
    }
  }), [cancelledMessage]);

  const submitAnswer = () => {
    if (!challenge) return;
    const trimmed = answer.trim();
    if (!trimmed) return;
    challenge.resolve(trimmed);
  };

  return { challenge, answer, setAnswer, submitAnswer, relayCaptcha };
}

// The StudentHub verification-code prompt, shared by the login page and the
// inline session re-auth dialog (components/reauth.tsx).
export function CaptchaDialog({ image, answer, onAnswerChange, onSubmit, title, description, footer }: {
  image: string;
  answer: string;
  onAnswerChange: (value: string) => void;
  onSubmit: () => void;
  title?: string;
  description?: string;
  footer?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title ?? t.login.enterVerificationCode}</CardTitle>
          <CardDescription>{description ?? t.login.verificationCodeDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <img src={image} alt={t.login.verificationImageAlt} className="w-full rounded-lg border border-border" />
          <div className="grid gap-2">
            <label htmlFor="captcha-answer" className="text-sm font-medium">{t.login.verificationCodeLabel}</label>
            <Input
              id="captcha-answer"
              name="captcha-answer"
              autoFocus
              value={answer}
              onChange={(event) => onAnswerChange(event.target.value)}
              placeholder={t.login.enterCodeShown}
              onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }}
            />
          </div>
          <Button onClick={onSubmit} disabled={!answer.trim()} className="w-full">{t.common.submit}</Button>
          {footer}
        </CardContent>
      </Card>
    </div>
  );
}
