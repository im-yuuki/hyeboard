import { HyeboardError } from "@hyeboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaotaoClient } from "./daotao-client";
import { createVnuAdapter } from "./adapter";
import {
  paragraphSessionEndedNoticeHttpHtml,
  paragraphSessionEndedNoticeHtml,
  standaloneSessionEndedNoticeHtml,
  xhtmlParagraphSessionEndedNoticeHttpHtml,
} from "./session-expiry-fixtures";

const AUTHENTICATED_URL = "https://daotao.vnu.edu.vn/StdInfo/TabStdSelf.asp";
const AUTHENTICATED_HTML = "<html><body><main>Authenticated portal page</main></body></html>";

function responseWithFinalUrl(body: string, status = 200, finalUrl = AUTHENTICATED_URL): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function mockFetchResponse(body: string, status = 200, finalUrl = AUTHENTICATED_URL): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseWithFinalUrl(body, status, finalUrl)));
}

async function expectHyeboardError(
  request: Promise<string>,
  expected: { code: string; status: number },
): Promise<HyeboardError> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(HyeboardError);
    expect(error).toMatchObject(expected);
    return error as HyeboardError;
  }

  throw new Error("Expected request to throw HyeboardError");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DaotaoClient session expiry", () => {
  it("rejects a followed redirect that finishes at the trusted login URL", async () => {
    const finalUrl = "https://daotao.vnu.edu.vn/dkmh/login.asp";
    mockFetchResponse(AUTHENTICATED_HTML, 200, finalUrl);

    const error = await expectHyeboardError(
      new DaotaoClient().getProfileHtml(),
      { code: "VNU_SESSION_EXPIRED", status: 401 },
    );

    expect(error.message).toBe("The university portal session has expired. Sign in again.");
    expect(error.message).not.toContain(AUTHENTICATED_HTML);
    expect(error.details).toBeUndefined();
  });

  it("does not classify a followed redirect with a login URL query as expired", async () => {
    const finalUrl = "https://daotao.vnu.edu.vn/dkmh/login.asp?return=profile";
    mockFetchResponse(AUTHENTICATED_HTML, 200, finalUrl);

    await expect(new DaotaoClient().getProfileHtml()).resolves.toBe(AUTHENTICATED_HTML);
  });

  it("rejects an HTTP 200 standalone expiry notice without exposing its HTML", async () => {
    mockFetchResponse(standaloneSessionEndedNoticeHtml);

    const error = await expectHyeboardError(
      new DaotaoClient().getProfileHtml(),
      { code: "VNU_SESSION_EXPIRED", status: 401 },
    );

    expect(error.message).toBe("The university portal session has expired. Sign in again.");
    expect(error.message).not.toContain(standaloneSessionEndedNoticeHtml);
    expect(error.details).toBeUndefined();
  });

  it("normalizes an HTTP 200 paragraph expiry notice for grades without exposing HTML", async () => {
    mockFetchResponse(paragraphSessionEndedNoticeHtml);

    const error = await expectHyeboardError(
      new DaotaoClient().getGradesHtml(),
      { code: "VNU_SESSION_EXPIRED", status: 401 },
    );

    expect(error.message).not.toContain(paragraphSessionEndedNoticeHtml);
    expect(error.details).toBeUndefined();
  });

  it("normalizes an HTTP 200 paragraph expiry notice with an HTTP login anchor without exposing HTML", async () => {
    mockFetchResponse(paragraphSessionEndedNoticeHttpHtml);

    const error = await expectHyeboardError(
      new DaotaoClient().getGradesHtml(),
      { code: "VNU_SESSION_EXPIRED", status: 401 },
    );

    expect(error.message).not.toContain(paragraphSessionEndedNoticeHttpHtml);
    expect(error.details).toBeUndefined();
  });

  it("maps the exact XHTML notification variant from HTTP 200 to VNU_SESSION_EXPIRED 401", async () => {
    mockFetchResponse(xhtmlParagraphSessionEndedNoticeHttpHtml);

    const error = await expectHyeboardError(
      new DaotaoClient().getGradesHtml(),
      { code: "VNU_SESSION_EXPIRED", status: 401 },
    );

    expect(error.message).not.toContain(xhtmlParagraphSessionEndedNoticeHttpHtml);
    expect(error.details).toBeUndefined();
  });

  it.each([
    ["HTTPS default port", "https://daotao.vnu.edu.vn:443/dkmh/login.asp"],
    ["HTTP default port", "http://daotao.vnu.edu.vn:80/dkmh/login.asp"],
    ["HTTPS non-default port", "https://daotao.vnu.edu.vn:8443/dkmh/login.asp"],
    ["HTTP non-default port", "http://daotao.vnu.edu.vn:8080/dkmh/login.asp"],
  ])("returns the strict paragraph notice unchanged for an explicit %s", async (_port, href) => {
    const html = paragraphSessionEndedNoticeHtml.replace(
      "https://daotao.vnu.edu.vn/dkmh/login.asp",
      href,
    );
    mockFetchResponse(html);

    await expect(new DaotaoClient().getGradesHtml()).resolves.toBe(html);
  });

  it("returns authenticated HTML unchanged", async () => {
    mockFetchResponse(AUTHENTICATED_HTML);

    await expect(new DaotaoClient().getProfileHtml()).resolves.toBe(AUTHENTICATED_HTML);
  });
});

describe("DaotaoClient status precedence", () => {
  it.each([
    [429, "VNU_RATE_LIMITED", 429],
    [503, "VNU_UPSTREAM_UNAVAILABLE", 502],
    [403, "VNU_REQUEST_FAILED", 403],
  ])("maps HTTP %i before inspecting the response body", async (status, code, outwardStatus) => {
    mockFetchResponse(standaloneSessionEndedNoticeHtml, status, "https://daotao.vnu.edu.vn/dkmh/login.asp");

    const error = await expectHyeboardError(
      new DaotaoClient().getProfileHtml(),
      { code, status: outwardStatus },
    );

    expect(error.message).not.toContain(standaloneSessionEndedNoticeHtml);
    expect(error.details).toBeUndefined();
  });

  it("maps a network TypeError to upstream unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("synthetic network failure")));

    const error = await expectHyeboardError(
      new DaotaoClient().getProfileHtml(),
      { code: "VNU_UPSTREAM_UNAVAILABLE", status: 502 },
    );

    expect(error.message).not.toContain("synthetic network failure");
    expect(error.details).toBeUndefined();
  });
});

describe("DaotaoClient point detail", () => {
  const DETAIL_URL = "https://daotao.vnu.edu.vn/ListPoint/detailPoint.asp";
  const EMPTY_DETAIL_HTML = `<html><body>
    <p>Điểm chi tiết môn học - Học kỳ 1. Mã học kỳ 251</p>
    <table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr></table>
  </body></html>`;

  it("normalizes a short student ID to the upstream 11-digit request shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithFinalUrl(EMPTY_DETAIL_HTML, 200, DETAIL_URL));
    vi.stubGlobal("fetch", fetchMock);

    await new DaotaoClient().getPointDetailHtml({ id: "123456", stdId: "12345", term: "045" });

    expect(fetchMock).toHaveBeenCalledWith(
      `${DETAIL_URL}?id=123456&val=&StdID=00000012345&Term=045`,
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("rejects a generic student-information page instead of returning a false empty detail", async () => {
    const wrongPageHtml = `<html><head><title>Xem thông tin sinh vien</title></head><body><table><tr><td>Synthetic portal shell</td></tr></table></body></html>`;
    mockFetchResponse(wrongPageHtml, 200, DETAIL_URL);

    const error = await expectHyeboardError(
      new DaotaoClient().getPointDetailHtml({ id: "123456", stdId: "12345", term: "045" }),
      { code: "VNU_UPSTREAM_RESPONSE_INVALID", status: 502 },
    );

    expect(error.message).not.toContain(wrongPageHtml);
    expect(error.details).toBeUndefined();
  });

  it("accepts a recognizable point-detail page with zero component rows", async () => {
    mockFetchResponse(EMPTY_DETAIL_HTML, 200, DETAIL_URL);

    await expect(
      new DaotaoClient().getPointDetailHtml({ id: "123456", stdId: "00000012345", term: "045" }),
    ).resolves.toBe(EMPTY_DETAIL_HTML);
  });
});

const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = `${SYNTHETIC_STUDENT_CODE.slice(0, 2)}000000001`;

describe("DaotaoClient cancellation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("passes the signal to login and preserves its exact fetch cancellation reason", async () => {
    const controller = new AbortController();
    const reason = { cancelled: "login-fetch" };
    fetchMock.mockImplementationOnce(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(reason);
      throw new TypeError("PRIVATE_LOGIN_ABORT_PROSE");
    });

    await expect(new DaotaoClient().login("synthetic-user", "synthetic-password", controller.signal)).rejects.toBe(reason);
  });

  it("passes the signal through profile body consumption and preserves cancellation", async () => {
    const controller = new AbortController();
    const reason = { cancelled: "profile-body" };
    const response = responseWithFinalUrl("");
    vi.spyOn(response, "text").mockImplementation(async () => {
      controller.abort(reason);
      throw new TypeError("PRIVATE_PROFILE_BODY_ABORT_PROSE");
    });
    fetchMock.mockImplementationOnce(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return response;
    });

    await expect(new DaotaoClient().getProfileHtml(controller.signal)).rejects.toBe(reason);
  });

  it("forwards the import signal through login and profile verification", async () => {
    const controller = new AbortController();
    const loginResponse = new Response("", { status: 302, headers: { "Set-Cookie": "SYNTHETIC_SESSION=VALUE; Path=/" } });
    const profileResponse = responseWithFinalUrl(`<input name="StdCode" value="${SYNTHETIC_STUDENT_CODE}">`);
    fetchMock
      .mockImplementationOnce(async (_input, init) => { expect(init?.signal).toBe(controller.signal); return loginResponse; })
      .mockImplementationOnce(async (_input, init) => { expect(init?.signal).toBe(controller.signal); return profileResponse; });

    await expect(createVnuAdapter().importSession({
      vnuUsername: "synthetic-user",
      vnuPassword: "synthetic-password",
      signal: controller.signal,
    })).resolves.toMatchObject({ universityId: "vnu", studentCode: SYNTHETIC_STUDENT_CODE });
  });

  it("passes a signal to the Brc1 transcript fetch", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response("<html></html>"));

    await new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://daotao.vnu.edu.vn/ListPoint/listpoint_Brc1.asp?selStd=${SYNTHETIC_INTERNAL_ID}`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("preserves an explicit cancellation reason", async () => {
    const controller = new AbortController();
    const reason = { cancelled: true };
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new TypeError("aborted");
    });

    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID, controller.signal)).rejects.toBe(reason);
  });

  it("preserves cancellation when transcript body consumption rejects", async () => {
    const controller = new AbortController();
    const reason = { cancelled: "body-stream" };
    const response = new Response("");
    vi.spyOn(response, "text").mockImplementation(async () => {
      controller.abort(reason);
      throw new TypeError("body stream aborted");
    });
    fetchMock.mockResolvedValueOnce(response);

    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID, controller.signal)).rejects.toBe(reason);
  });

  it("maps ordinary transcript body-stream failure to VNU_UPSTREAM_UNAVAILABLE", async () => {
    const response = new Response("");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("body stream failed"));
    fetchMock.mockResolvedValueOnce(response);

    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID)).rejects.toMatchObject({
      code: "VNU_UPSTREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("maps ordinary transport TypeError to VNU_UPSTREAM_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network failed"));

    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID)).rejects.toMatchObject({
      code: "VNU_UPSTREAM_UNAVAILABLE",
      status: 502,
    });
  });
});
