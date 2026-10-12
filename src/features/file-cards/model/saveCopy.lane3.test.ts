import { expect, it, vi } from "vitest";
import { saveCopyOf } from "./saveCopy";

it("copies the document into the folder you pick", async () => {
  const copy = vi.fn(async (_from: string, dest: string) => `${dest}/report 2.pdf`);
  const result = await saveCopyOf("/p/out/report.pdf", {
    pick: async () => ["/Users/ada/Desktop"],
    copy,
  });
  expect(copy).toHaveBeenCalledWith("/p/out/report.pdf", "/Users/ada/Desktop");
  expect(result).toEqual({ status: "saved", path: "/Users/ada/Desktop/report 2.pdf" });
});

it("does nothing when you cancel the picker", async () => {
  const copy = vi.fn();
  expect(await saveCopyOf("/p/a.md", { pick: async () => [], copy })).toEqual({
    status: "cancelled",
  });
  expect(copy).not.toHaveBeenCalled();
});

it("copies to the first folder only when several are picked", async () => {
  const copy = vi.fn(async () => "/a/x");
  await saveCopyOf("/p/x", { pick: async () => ["/a", "/b"], copy });
  expect(copy).toHaveBeenCalledTimes(1);
});

it("reports a failed copy or picker instead of throwing", async () => {
  expect(
    await saveCopyOf("/p/gone.md", {
      pick: async () => ["/a"],
      copy: async () => {
        throw new Error("/p/gone.md: No such file or directory");
      },
    }),
  ).toEqual({ status: "error", message: "/p/gone.md: No such file or directory" });
  expect(
    await saveCopyOf("/p/x", {
      pick: async () => {
        throw "dialog closed";
      },
    }),
  ).toEqual({ status: "error", message: "dialog closed" });
});
