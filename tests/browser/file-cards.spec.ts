import { expect, test } from "@playwright/test";

test("document cards sit under the turn that wrote them", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1100 });
  await page.goto("/tests/browser/file-cards.html");
  const turns = page.locator(".transcript-turn");
  await expect(turns).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);

  // Three documents; the source file, the in-place edit and the failed write
  // get no card.
  const first = turns.nth(0).locator("[data-file-card]");
  await expect(first).toHaveCount(3);
  await expect(first.nth(0)).toContainText("launch-plan.md");
  await expect(first.nth(0)).toContainText("Document · MD");
  await expect(first.nth(0)).toContainText("docs/launch-plan.md");
  await expect(first.nth(1)).toContainText("q3-metrics.csv");
  await expect(first.nth(1)).toContainText("Table · CSV");
  await expect(first.nth(2)).toContainText("meeting-notes.txt");
  await expect(first.nth(2)).toContainText(
    "notes/2026-10-kickoff/meeting-notes.txt",
  );
  await expect(turns.nth(0).locator("[data-file-cards-more]")).toHaveCount(0);

  // Nine documents fold to the cap behind "+3 more".
  const second = turns.nth(1).locator("[data-file-card]");
  const more = turns.nth(1).locator("[data-file-cards-more]");
  await expect(second).toHaveCount(6);
  await expect(second.nth(5)).toContainText("note-6.md");
  await expect(more).toHaveText("+3 more");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  const shot = process.env.FILE_CARDS_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot });

  await more.click();
  await expect(second).toHaveCount(9);
  await expect(second.nth(8)).toContainText("note-9.md");
  await expect(more).toHaveText("Show fewer");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await more.click();
  await expect(second).toHaveCount(6);

  // Open hands the transcript's own callback the absolute path, by mouse and
  // from the keyboard.
  await page.getByRole("button", { name: "Open launch-plan.md" }).click();
  const csv = page.getByRole("button", { name: "Open q3-metrics.csv" });
  await csv.focus();
  await expect(csv).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () => (window as unknown as { openedFiles: string[] }).openedFiles,
    ),
  ).toEqual([
    "/Users/ada/acme-app/docs/launch-plan.md",
    "/Users/ada/acme-app/reports/q3-metrics.csv",
  ]);
  // Reveal, Save a copy and Open, each named for the file.
  await expect(
    first.nth(0).getByRole("button", { name: /launch-plan\.md$/ }),
  ).toHaveCount(3);
  await expect(
    first.nth(0).getByRole("button", { name: "Save a copy of launch-plan.md" }),
  ).toHaveCount(1);
});
