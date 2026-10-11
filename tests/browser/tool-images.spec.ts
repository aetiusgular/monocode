import { expect, test, type Page } from "@playwright/test";

// A running Claude Code turn that drove a browser: five tool calls, three of
// which returned images (one, one JPEG, and six), eight images in all.
const FIXTURE = "/tests/browser/tool-images.html";

const SHOT = "mcp__playwright__browser_take_screenshot";

/** Opens the turn's work down to its tool rows. */
async function showCalls(page: Page) {
  await page.getByRole("button", { name: "Show the work" }).click();
  await page.getByRole("button", { name: /^Show the steps for/ }).click();
  await expect(page.locator("[data-tool-images]").first()).toBeVisible();
}

function gallery(page: Page) {
  return page.getByRole("dialog", { name: /^Image preview:/ });
}

function panelOf(page: Page) {
  return page.getByRole("complementary", { name: "Session panel" });
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
});

test("a tool call that returned images shows them as small thumbnails", async ({
  page,
}) => {
  await showCalls(page);
  // Three of the five calls returned images. The other two have no strip.
  const strips = page.locator("[data-tool-images]");
  await expect(strips).toHaveCount(3);
  await expect(strips.nth(0).locator("[data-tool-image]")).toHaveCount(1);
  // The JPEG the Read tool opened was kept too.
  await expect(strips.nth(1).locator("[data-tool-image]")).toHaveCount(1);

  // Six images: four thumbnails, then a chip for the other two.
  const many = strips.nth(2);
  await expect(many.locator("[data-tool-image]")).toHaveCount(4);
  await expect(many.locator("[data-tool-images-more]")).toHaveText("+2");
  await expect(
    many.getByRole("button", { name: `Open 2 more images from ${SHOT}` }),
  ).toBeVisible();

  const thumbnail = strips.nth(0).locator("[data-tool-image]");
  await expect(thumbnail.locator("img")).toBeVisible();
  const box = (await thumbnail.boundingBox())!;
  expect(box.height).toBe(40);
  // The strip sits under its own row, not beside it.
  const row = (await page
    .getByLabel(`Tool call: ${SHOT}`)
    .first()
    .boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(row.y + row.height - 1);

  // A thumbnail is a small drawing of the image, not the 640 px original.
  const drawn = await thumbnail.locator("img").evaluate((img) => ({
    src: (img as HTMLImageElement).src.slice(0, 22),
    height: (img as HTMLImageElement).naturalHeight,
  }));
  expect(drawn.src).toBe("data:image/png;base64,");
  expect(drawn.height).toBeLessThanOrEqual(96);

  // Everything kept is a PNG file, the JPEG included.
  const files = await page.evaluate(() =>
    (window as unknown as { __disk: () => string[] }).__disk(),
  );
  expect(files).toHaveLength(8);
});

test("resting on a thumbnail shows it larger", async ({ page }) => {
  await showCalls(page);
  const thumbnail = page.locator("[data-tool-image]").first();
  const preview = page.locator("[data-tool-image-preview]");
  await expect(preview).toHaveCount(0);

  await thumbnail.hover();
  await expect(preview).toBeVisible();
  // The full image, once it has been read.
  await expect
    .poll(() =>
      preview
        .locator("img")
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(640);
  const shown = (await preview.locator("img").boundingBox())!;
  expect(shown.height).toBeGreaterThan(150);
  // It opens beside the thumbnail and covers none of it.
  const anchor = (await thumbnail.boundingBox())!;
  const frame = (await preview.boundingBox())!;
  expect(
    frame.y + frame.height <= anchor.y || frame.y >= anchor.y + anchor.height,
  ).toBe(true);

  await page.mouse.move(600, 700);
  await expect(preview).toHaveCount(0);
});

test("a thumbnail opens the gallery, which steps through every image", async ({
  page,
}) => {
  await showCalls(page);
  const thumbnail = page.locator("[data-tool-image]").first();
  await thumbnail.click();

  const dialog = gallery(page);
  await expect(dialog).toBeVisible();
  // The hover preview does not linger behind it.
  await expect(page.locator("[data-tool-image-preview]")).toHaveCount(0);
  const position = dialog.locator("[data-gallery-position]");
  await expect(position).toHaveText("1 of 8");
  await expect(dialog.locator("[data-gallery-caption]")).toContainText(SHOT);
  const image = dialog.locator("img");
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(640);

  const previous = dialog.getByRole("button", { name: "Previous image" });
  const next = dialog.getByRole("button", { name: "Next image" });
  await expect(previous).toHaveAttribute("aria-disabled", "true");

  // Next, by key and by button. The second image is the Read tool's.
  const first = await image.getAttribute("src");
  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText("2 of 8");
  await expect(dialog.locator("[data-gallery-caption]")).toContainText(
    "checkout-mock.jpg",
  );
  await expect(image).not.toHaveAttribute("src", first!);
  await next.click();
  await expect(position).toHaveText("3 of 8");

  // Previous, by button and by key.
  await previous.click();
  await expect(position).toHaveText("2 of 8");
  await page.keyboard.press("ArrowLeft");
  await expect(position).toHaveText("1 of 8");
  await expect(image).toHaveAttribute("src", first!);
  await page.keyboard.press("ArrowLeft");
  await expect(position).toHaveText("1 of 8");

  // Escape closes it and focus goes back to the thumbnail.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});

test("the count chip opens the gallery past the thumbnails", async ({
  page,
}) => {
  await showCalls(page);
  const more = page.locator("[data-tool-images-more]");
  await more.click();
  const dialog = gallery(page);
  const position = dialog.locator("[data-gallery-position]");
  // Images 3 to 6 have thumbnails. The chip opens on the seventh.
  await expect(position).toHaveText("7 of 8");
  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText("8 of 8");
  await expect(
    dialog.getByRole("button", { name: "Next image" }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText("8 of 8");

  await dialog.getByRole("button", { name: "Close image preview" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("the panel previews the latest image and follows the turn", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  const section = panel.getByRole("region", { name: "Preview" });
  await expect(section).toBeVisible();

  // The newest image: the last of the six from the last screenshot call.
  const latest = section.locator("[data-preview-image]");
  await expect(latest).toHaveAttribute("data-preview-image", "toolu_3:5");
  await expect(section.locator("[data-preview-title]")).toHaveText(SHOT);
  await expect(section.locator("[data-preview-count]")).toHaveText("8 images");
  await expect(latest.locator("img")).toBeVisible();
  const shown = (await latest.boundingBox())!;
  expect(shown.width).toBeLessThanOrEqual(304);
  expect(shown.height).toBeGreaterThan(80);
  const before = await latest.locator("img").getAttribute("src");

  // The agent takes another screenshot while the turn runs.
  await page.evaluate(() =>
    (window as unknown as { __shoot: () => Promise<void> }).__shoot(),
  );
  await expect(latest).toHaveAttribute("data-preview-image", "toolu_live_9:0");
  await expect(section.locator("[data-preview-count]")).toHaveText("9 images");
  await expect(latest.locator("img")).not.toHaveAttribute("src", before!);

  // It opens the gallery on the image it shows.
  await latest.click();
  const dialog = gallery(page);
  await expect(dialog.locator("[data-gallery-position]")).toHaveText("9 of 9");
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.locator("[data-gallery-position]")).toHaveText("8 of 9");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(latest).toBeFocused();
  // Escape closed the gallery, not the panel under it.
  await expect(panel).toBeVisible();

  // The section folds, and stays folded.
  await section.getByRole("button", { name: "Preview" }).click();
  await expect(latest).toHaveCount(0);
  await page.reload();
  await expect(
    panelOf(page).getByRole("region", { name: "Preview" }),
  ).toBeVisible();
  await expect(panelOf(page).locator("[data-preview-image]")).toHaveCount(0);
});

test("a session whose tool calls returned no images has none of this", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?images=0`);
  await page.getByRole("button", { name: "Show the work" }).click();
  await page.getByRole("button", { name: /^Show the steps for/ }).click();
  await expect(page.getByText("npm test -- checkout")).toBeVisible();
  await expect(page.locator("[data-tool-images]")).toHaveCount(0);

  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("region", { name: "Outputs" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Preview" })).toHaveCount(0);
});

test("a subagent's screenshots show on the subagent's row", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?agent=1`);
  // A running subagent keeps its row in view, outside the folded work.
  const row = page.getByRole("button", {
    name: "Show Check the mobile layout's work",
  });
  await expect(row).toBeVisible();
  const thumbnails = page.locator("[data-tool-image]");
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.first()).toHaveAccessibleName(
    "Open image 1 of 2 from Check the mobile layout",
  );

  // They are part of the session's gallery, after the lead's own images.
  await thumbnails.nth(1).click();
  const dialog = gallery(page);
  await expect(dialog.locator("[data-gallery-position]")).toHaveText(
    "10 of 10",
  );
  await expect(dialog.locator("[data-gallery-caption]")).toContainText(
    "Check the mobile layout",
  );
});
