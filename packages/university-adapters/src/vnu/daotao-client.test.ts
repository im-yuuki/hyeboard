import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaotaoClient } from "./daotao-client";

const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = `${SYNTHETIC_STUDENT_CODE.slice(0, 2)}000000001`;

describe("DaotaoClient cancellation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

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
