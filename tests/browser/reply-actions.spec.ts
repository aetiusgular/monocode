import { expect, test, type Locator } from "@playwright/test";

type Probe = { spoken: string[]; retried: number[] };

async function inside(row: Locator, button: Locator) {
  const outer = (await row.boundingBox())!;
  const inner = (await button.boundingBox())!;
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

for (const width of [0, 340]) {
  test(`Read aloud and Retry sit in the action row ${
    width ? `of a ${width}px pane` : "of a wide pane"
  }`, async ({ page }) => {
    await page.goto(
      `/tests/browser/reply-actions.html${width ? `?width=${width}` : ""}`,
    );
    const rows = page.locator("[data-turn-actions]");
    await expect(rows).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);

    // Read aloud under every reply; Retry under the last one only.
    await expect(page.getByRole("button", { name: "Read aloud" })).toHaveCount(
      2,
    );
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
    const last = rows.nth(1);
    const copy = last.getByRole("button", { name: "Copy response" });
    const read = last.getByRole("button", { name: "Read aloud" });
    const retry = last.getByRole("button", { name: "Retry" });

    // One line, the copy button's size, nothing pushed out of the row.
    const copyBox = (await copy.boundingBox())!;
    for (const button of [read, retry]) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBe(copyBox.width);
      expect(box.height).toBe(copyBox.height);
      expect(box.y).toBe(copyBox.y);
      await inside(last, button);
    }
    for (const row of [rows.nth(0), last]) {
      expect((await row.boundingBox())!.height).toBeLessThan(48);
    }
    // The clock at the end of the row is still on show.
    await inside(last, last.locator("span.shrink-0").last());

    const shot = process.env.REPLY_ACTIONS_SCREENSHOT;
    if (shot) {
      await page.screenshot({ path: shot.replace(".png", `-${width}.png`) });
    }

    // Reading starts, the button turns into Stop, and only one reply reads.
    await read.click();
    const stop = page.getByRole("button", { name: "Stop reading" });
    await expect(stop).toHaveCount(1);
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(() => (window as unknown as Probe).spoken),
    ).toEqual(["Done. The lockfile is updated and CI is green."]);

    await rows.nth(0).getByRole("button", { name: "Read aloud" }).click();
    await expect(stop).toHaveCount(1);
    await expect(last.getByRole("button", { name: "Read aloud" })).toHaveCount(
      1,
    );
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).spoken))
      .toEqual([
        "Done. The lockfile is updated and CI is green.",
        "The lockfile is out of date. Run this:",
        "Code block.",
        "Then push again.",
      ]);

    // Stop by keyboard, and focus stays on the button that was pressed.
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(stop).toHaveCount(0);
    await expect(
      rows.nth(0).getByRole("button", { name: "Read aloud" }),
    ).toBeFocused();

    await retry.click();
    expect(
      await page.evaluate(() => (window as unknown as Probe).retried.length),
    ).toBe(1);
  });
}
