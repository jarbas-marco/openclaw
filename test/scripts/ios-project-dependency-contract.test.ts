import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("iOS project dependency contract", () => {
  it("pins WebRTC to the available 152 release and retains its license", () => {
    const project = parse(readFileSync("apps/ios/project.yml", "utf8")) as {
      packages?: Record<string, { exactVersion?: string; url?: string }>;
    };

    expect(project.packages?.WebRTC).toEqual({
      exactVersion: "152.0.0",
      url: "https://github.com/stasel/WebRTC.git",
    });
    expect(readFileSync("apps/ios/Resources/Licenses/WebRTC.txt", "utf8")).toContain(
      "Google WebRTC",
    );
  });
});
