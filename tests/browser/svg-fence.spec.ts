import { expect, test } from "@playwright/test";

// Mac test 3.7, the svg ask. Runs on Chromium in the cloud; the Mac's app is
// WebKit, which this run does not cover.

test("a finished svg fence draws a red circle and Show source toggles", async ({
  page,
}) => {
  await page.goto("/tests/browser/svg-fence.html");
  const visual = page.locator('[data-markdown-visual="svg"]');
  await expect(visual).toHaveCount(1);
  const image = visual.getByRole("img", { name: "Drawing from the reply" });
  await expect(image).toBeVisible();

  // The drawing decodes: a broken image has a natural width of 0.
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  // And it is red where the circle is.
  const centre = await image.evaluate((img: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    return Array.from(
      context.getImageData(img.naturalWidth / 2, img.naturalHeight / 2, 1, 1).data,
    );
  });
  expect(centre).toEqual([255, 0, 0, 255]);

  // Show source switches to the code.
  await visual.getByRole("button", { name: "Show source" }).click();
  await expect(image).toHaveCount(0);
  await expect(visual).toContainText('<circle cx="60" cy="60" r="50" fill="red" />');
  const back = visual.getByRole("button", { name: "Show drawing" });
  await expect(back).toBeVisible();

  // And back to the drawing, decoded again.
  await back.click();
  await expect(visual.getByRole("button", { name: "Show source" })).toBeVisible();
  const again = visual.getByRole("img", { name: "Drawing from the reply" });
  await expect
    .poll(() => again.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
});
