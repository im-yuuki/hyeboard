import { describe, expect, it, vi } from "vitest";
import { awaitAutomationOperation, detectChallenge, serializeCookies } from "./google-login-automation";

const browserMocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: browserMocks.launch } }));
vi.mock("puppeteer-core", () => ({ default: { connect: vi.fn(), launch: vi.fn() } }));

describe("detectChallenge", () => {
  it("returns GOOGLE_2FA_REQUIRED for a totp challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/totp?x=1", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_2FA_REQUIRED for an ipp challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/ipp", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_2FA_REQUIRED for an iap challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/iap", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_AUTOMATION_BLOCKED when body text warns the sign-in is unsafe", () => {
    expect(detectChallenge("https://accounts.google.com/signin/rejected", "This browser or app may not be secure")).toBe("GOOGLE_AUTOMATION_BLOCKED");
  });

  it("returns GOOGLE_CHALLENGE_REQUIRED for a generic challenge URL with no blocked phrasing", () => {
    expect(detectChallenge("https://accounts.google.com/signin/challenge", "please verify your identity")).toBe("GOOGLE_CHALLENGE_REQUIRED");
  });

  it("returns GOOGLE_CHALLENGE_REQUIRED for a rejected URL with no blocked phrasing", () => {
    expect(detectChallenge("https://accounts.google.com/signin/rejected", "sign-in was not successful")).toBe("GOOGLE_CHALLENGE_REQUIRED");
  });

  it("returns undefined for a normal successful URL and body", () => {
    expect(detectChallenge("https://studenthub.uet.edu.vn/dashboard", "Welcome back")).toBeUndefined();
  });

  it("prioritizes GOOGLE_2FA_REQUIRED over the blocked-phrase check when both could match", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/totp", "unusual activity detected")).toBe("GOOGLE_2FA_REQUIRED");
  });
});

describe("serializeCookies", () => {
  it("joins multiple cookies as name=value pairs separated by semicolons", () => {
    expect(
      serializeCookies([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).toBe("a=1; b=2");
  });

  it("returns an empty string for an empty array", () => {
    expect(serializeCookies([])).toBe("");
  });
});

describe("awaitAutomationOperation", () => {
  it("runs cleanup before rejecting an aborted browser operation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("login cancelled", "AbortError");
    const cleanup = vi.fn(async () => undefined);
    const operation = new Promise<void>(() => undefined);
    const pending = awaitAutomationOperation(operation, controller.signal, cleanup);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("automateVnuGoogleLogin cancellation", () => {
  it("closes the page and browser when cancelled during navigation", async () => {
    const { automateVnuGoogleLogin } = await import("./google-login-automation");
    const controller = new AbortController();
    const reason = new DOMException("login cancelled", "AbortError");
    let rejectNavigation: ((error: Error) => void) | undefined;
    let navigationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      navigationStarted = resolve;
    });
    const page = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(() => {
        navigationStarted();
        return new Promise<never>((_, reject) => {
          rejectNavigation = reject;
        });
      }),
    };
    const browser = {
      connected: true,
      close: vi.fn(async () => {
        rejectNavigation?.(new Error("browser closed"));
      }),
      newPage: vi.fn(async () => page),
    };
    browserMocks.launch.mockResolvedValueOnce(browser);

    const pending = automateVnuGoogleLogin(
      { kind: "cloudflare", binding: { fetch: vi.fn() } },
      "20200001@vnu.edu.vn",
      "password",
      undefined,
      undefined,
      controller.signal,
    );
    await started;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(browser.close).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
  });
});
