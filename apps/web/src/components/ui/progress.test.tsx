import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

describe("Progress", () => {
  it("exposes progressbar values and an accessible label", () => {
    const markup = renderToStaticMarkup(<Progress value={140} aria-label="Upload progress" />);

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain('aria-label="Upload progress"');
  });

  it("supports custom ranges and aria-labelledby", () => {
    const markup = renderToStaticMarkup(<Progress min={10} max={20} value={15} aria-labelledby="progress-label" />);

    expect(markup).toContain('aria-valuemin="10"');
    expect(markup).toContain('aria-valuemax="20"');
    expect(markup).toContain('aria-valuenow="15"');
    expect(markup).toContain('aria-labelledby="progress-label"');
    expect(markup).toContain("width:50%");
  });
});
