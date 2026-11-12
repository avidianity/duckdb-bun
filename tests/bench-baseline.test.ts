// The bench's choice of baseline (bench/baseline.ts).
import { expect, test } from "bun:test";
import { previousRelease } from "../bench/baseline.ts";

test("the previous release is the newest stable version older than this one", () => {
  const published = ["1.0.0", "1.0.1", "1.1.0", "1.1.1", "1.2.0", "2.0.0-rc.1"];
  expect(previousRelease(published, "1.2.0")).toBe("1.1.1");
  expect(previousRelease(published, "1.1.0")).toBe("1.0.1");
  expect(previousRelease(published, "2.0.0")).toBe("1.2.0");
});

test("there is no previous release before the first one", () => {
  expect(previousRelease([], "1.0.0")).toBeUndefined();
  expect(previousRelease(["1.0.0"], "1.0.0")).toBeUndefined();
});
