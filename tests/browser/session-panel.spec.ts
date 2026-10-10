import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/session-panel.html";

type Asked = { opened: string[]; shown: string[] };

function asked(page: Page): Promise<Asked> {
  return page.evaluate(() => (window as unknown as { __panel: Asked }).__panel);
}

function panelOf(page: Page) {
  return page.getByRole("complementary", { name: "Session panel" });
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
});

test("the button opens the panel, counts outputs, and the choice is remembered", async ({
  page,
}) => {
  const panel = panelOf(page);
  await expect(panel).toHaveCount(0);

  const open = page.getByRole("button", { name: "Show session panel" });
  await expect(open).toHaveAttribute("data-output-count", "2");
  await expect(open).toHaveText("2");
  await open.click();
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("monocode.sessionPanelOpen"),
    ),
  ).toBe("1");

  await page.reload();
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Close session panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show session panel" }),
  ).toBeVisible();
});

test("Escape closes a panel opened here and hands focus back", async ({
  page,
}) => {
  const open = page.getByRole("button", { name: "Show session panel" });
  await open.click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("opening the panel pushes the chat aside and covers nothing", async ({
  page,
}) => {
  const panel = panelOf(page);
  const transcript = page.locator("[data-fixture-transcript]");
  const composer = page.locator("[data-fixture-composer]");
  const box = async (locator: typeof panel) => (await locator.boundingBox())!;
  const right = async (locator: typeof panel) => {
    const { x, width } = await box(locator);
    return x + width;
  };

  expect((await box(transcript)).width).toBe(1000);
  // The button that opens the panel is in the title bar, above the chat. It
  // sits on none of the transcript, open or shut.
  const bottom = async (locator: typeof panel) => {
    const { y, height } = await box(locator);
    return y + height;
  };
  const top = (await box(transcript)).y;
  expect(
    await bottom(page.getByRole("button", { name: "Show session panel" })),
  ).toBeLessThanOrEqual(top);

  await page.getByRole("button", { name: "Show session panel" }).click();
  await expect(panel).toBeVisible();
  // The panel is a column of its own: the chat gives up exactly its width.
  expect((await box(panel)).width).toBe(304);
  expect((await box(transcript)).width).toBe(696);
  expect(await right(panel)).toBe(1000);
  // Nothing of the chat is under the panel: not the transcript, not the
  // composer.
  const edge = (await box(panel)).x;
  expect(await right(transcript)).toBeLessThanOrEqual(edge);
  expect(await right(composer)).toBeLessThanOrEqual(edge);
  expect(
    await bottom(page.getByRole("button", { name: "Hide session panel" })),
  ).toBeLessThanOrEqual(top);
  expect(await panel.evaluate((el) => getComputedStyle(el).position)).not.toBe(
    "absolute",
  );

  // A narrower pane still pushes; the chat keeps a readable column.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(panel).toBeVisible();
  expect((await box(transcript)).width).toBe(396);
  expect(await right(transcript)).toBeLessThanOrEqual((await box(panel)).x);
  expect(await right(composer)).toBeLessThanOrEqual((await box(panel)).x);

  // Too narrow to push: the pane goes without, rather than be covered.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-session-panel-toggle]")).toHaveCount(0);
  expect((await box(transcript)).width).toBe(600);

  // The choice is kept for when there is room again.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Close session panel" }).click();
  await expect(panel).toHaveCount(0);
  expect((await box(transcript)).width).toBe(1000);
});

test("the Progress heading folds the step list", async ({ page }) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  const fold = panel.locator("[data-progress-fold]");
  const steps = panel.locator("[data-progress-steps]");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(steps).toBeVisible();
  const open = (await panel
    .locator("[data-session-panel-body]")
    .boundingBox())!;

  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(steps).toHaveCount(0);
  await expect(panel.locator("[data-progress-count]")).toHaveText("5 of 9");
  // The card shrinks to what is left in it.
  const shut = (await panel
    .locator("[data-session-panel-body]")
    .boundingBox())!;
  expect(shut.height).toBeLessThan(open.height);
  await expect(panel.getByRole("region", { name: "Outputs" })).toBeVisible();

  await page.reload();
  await expect(panel).toBeVisible();
  await expect(steps).toHaveCount(0);
  await fold.click();
  await expect(steps).toBeVisible();
});

test("the Tasks card in the chat opens as a dropdown", async ({ page }) => {
  const card = page.getByRole("region", { name: "Task progress" });
  const fold = card.getByRole("button");
  // One line: the step in hand and how far along the list is.
  await expect(card).toHaveAttribute("data-task-list", "folded");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByRole("listitem")).toHaveCount(0);
  await expect(card.locator("[data-task-list-current]")).toHaveText(
    "Retry safely when the provider times out",
  );
  await expect(card).toContainText("5 of 9");
  const folded = (await card.boundingBox())!;
  expect(folded.height).toBeLessThan(48);

  await fold.click();
  await expect(card).toHaveAttribute("data-task-list", "open");
  await expect(card.getByRole("listitem")).toHaveCount(9);
  await expect(
    card.getByText("Reproduce the duplicate-charge bug"),
  ).toBeVisible();
  expect((await card.boundingBox())!.height).toBeGreaterThan(folded.height * 4);

  await fold.click();
  await expect(card.getByRole("listitem")).toHaveCount(0);
});

test("progress folds finished steps behind a toggle", async ({ page }) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  const steps = panel.locator("[data-progress-steps]");

  await expect(panel.locator("[data-progress-count]")).toHaveText("5 of 9");
  const earlier = steps.locator("[data-earlier-steps]");
  await expect(earlier).toHaveText("5 earlier steps");
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await expect(steps.getByRole("listitem")).toHaveCount(5);
  await expect(
    steps.getByText("Reproduce the duplicate-charge bug"),
  ).toHaveCount(0);
  await expect(
    steps.getByText("Retry safely when the provider times out"),
  ).toBeVisible();

  await earlier.click();
  await expect(earlier).toHaveText("Hide earlier steps");
  await expect(earlier).toHaveAttribute("aria-expanded", "true");
  await expect(steps.getByRole("listitem")).toHaveCount(10);
  await expect(
    steps.getByText("Reproduce the duplicate-charge bug"),
  ).toBeVisible();

  await earlier.click();
  await expect(earlier).toHaveText("5 earlier steps");
});

test("a long plan scrolls inside its own area and fades the cut edge", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?steps=long`);
  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  const steps = panel.locator("[data-progress-steps]");
  await expect(panel.locator("[data-progress-count]")).toHaveText("23 of 32");
  await expect(steps.locator("[data-earlier-steps]")).toHaveText(
    "23 earlier steps",
  );

  const metrics = () =>
    steps.evaluate((el) => ({
      top: el.scrollTop,
      client: el.clientHeight,
      full: el.scrollHeight,
    }));
  const before = await metrics();
  expect(before.full).toBeGreaterThan(before.client);
  await expect(steps).toHaveAttribute("data-fade-below", "true");
  await expect(steps).not.toHaveAttribute("data-fade-above", "true");
  // The sections under it stay where they are, in reach.
  await expect(panel.getByRole("region", { name: "Outputs" })).toBeVisible();

  await steps.hover();
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(async () => (await metrics()).top)
    .toBeGreaterThan(before.top);
  await expect(steps).toHaveAttribute("data-fade-above", "true");
  await expect(steps).not.toHaveAttribute("data-fade-below", "true");
  await expect(steps.getByText("Later step 8")).toBeVisible();
});

test("the step list follows the running step until scrolled away", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?steps=long`);
  await page.getByRole("button", { name: "Show session panel" }).click();
  const steps = panelOf(page).locator("[data-progress-steps]");
  const advance = (count: number) =>
    page.evaluate(
      (by) =>
        (window as unknown as { __advance: (n: number) => void }).__advance(by),
      count,
    );
  const running = steps.locator('li:has([aria-label="In progress"])');
  const inArea = async () => {
    const area = await steps.boundingBox();
    const row = await running.boundingBox();
    return (
      !!area &&
      !!row &&
      row.y >= area.y - 1 &&
      row.y + row.height <= area.y + area.height + 1
    );
  };

  // With the earlier steps showing, the running one is far down the list.
  await steps.locator("[data-earlier-steps]").click();
  await expect.poll(inArea).toBe(false);
  // Opened to read the earlier steps: a step change must not pull the list
  // away from them.
  await advance(1);
  await expect(running).toContainText("Later step 1");
  await page.waitForTimeout(200);
  expect(await steps.evaluate((el) => el.scrollTop)).toBe(0);

  await running.scrollIntoViewIfNeeded();
  await expect.poll(inArea).toBe(true);

  // Six steps on, the running step has moved out of sight; the list goes
  // after it.
  await advance(6);
  await expect(running).toContainText("Later step 7");
  await expect.poll(inArea).toBe(true);

  // Scrolled back to the top, the viewer is reading something else.
  await steps.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(inArea).toBe(false);
  await advance(1);
  await expect(running).toContainText("Later step 8");
  await page.waitForTimeout(200);
  expect(await steps.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await inArea()).toBe(false);
});

test("an output opens on click", async ({ page }) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const outputs = panelOf(page).getByRole("region", { name: "Outputs" });
  const rows = outputs.locator("button[data-output]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("duplicate-charge.md");
  await expect(rows.nth(0)).toContainText("MD");

  await rows.nth(0).click();
  expect((await asked(page)).opened).toEqual([
    "/home/dev/worktrees/storefront-duplicate-charge/docs/duplicate-charge.md",
  ]);

  // The reveal button shows up on the row the pointer is on.
  const reveal = outputs.locator("[data-output-reveal]");
  await expect(reveal.nth(1)).toBeHidden();
  await rows.nth(1).hover();
  await expect(reveal.nth(1)).toBeVisible();
});

test("used rows preview what was used and open their lists", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const used = panelOf(page).getByRole("region", {
    name: "Used in this session",
  });
  const row = (id: string) => used.locator(`button[data-used-row="${id}"]`);
  const list = page.locator("[data-used-list]");

  for (const [id, preview, more] of [
    ["attachments", "double-charge-receipt.png", "+2"],
    ["folders", "~/worktrees/storefront-duplicate-charge", "+1"],
    ["connectors", "github", "+1"],
    ["files", "4 edited · 4 read", null],
    ["commands", "npm test -- retry", "+3"],
    ["web", "payment provider idempotency key retry window", "+1"],
    ["searches", "createCharge", null],
    ["subagents", "Review the retry change", null],
  ] as const) {
    await expect(row(id).locator("[data-used-preview]")).toHaveText(preview);
    if (more)
      await expect(row(id).locator("[data-used-more]")).toHaveText(more);
    else await expect(row(id).locator("[data-used-more]")).toHaveCount(0);
  }
  await expect(row("other")).toHaveCount(0);

  // Resting on a row shows its list; leaving both takes it away.
  await expect(list).toHaveCount(0);
  await row("attachments").hover();
  await expect(list).toHaveAttribute("data-used-list", "attachments");
  await expect(list.getByRole("button")).toHaveText([
    "double-charge-receipt.png",
    "provider-timeout.log",
    "refund-thread.pdf",
  ]);
  await list.hover();
  await page.waitForTimeout(400);
  await expect(list).toBeVisible();
  await page.mouse.move(5, 400);
  await expect(list).toHaveCount(0);

  // Sliding from one row to the next swaps the list for that row's.
  await row("attachments").hover();
  await expect(list).toHaveAttribute("data-used-list", "attachments");
  await row("folders").hover();
  await expect(list).toHaveAttribute("data-used-list", "folders");
  await row("commands").hover();
  await expect(list).toHaveAttribute("data-used-list", "commands");
  await page.mouse.move(5, 400);
  await expect(list).toHaveCount(0);

  // A click keeps the list until it is dismissed.
  await row("connectors").click();
  await expect(list).toHaveAttribute("data-used-list", "connectors");
  await page.mouse.move(5, 400);
  await page.waitForTimeout(400);
  await expect(list).toBeVisible();
  await expect(list).toContainText("github");
  await expect(list).toContainText("3 calls");
  await expect(list).toContainText("list_pull_requests");
  await expect(list).toContainText("linear");

  // Escape closes the list first and leaves the panel open.
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(panelOf(page)).toBeVisible();
  await expect(row("connectors")).toBeFocused();
});

test("picking from a list opens the file or jumps to the call in chat", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const used = panelOf(page).getByRole("region", {
    name: "Used in this session",
  });
  const list = page.locator("[data-used-list]");

  await used.locator('button[data-used-row="files"]').click();
  await expect(list.getByRole("group", { name: "Edited" })).toBeVisible();
  const edited = list
    .getByRole("group", { name: "Edited" })
    .getByRole("button");
  await expect(edited).toHaveCount(4);
  await expect(edited.nth(0)).toContainText("charge.ts");
  await expect(edited.nth(0)).toContainText("src/checkout");
  await edited.nth(0).click();
  expect((await asked(page)).opened).toEqual([
    "/home/dev/worktrees/storefront-duplicate-charge/src/checkout/charge.ts",
  ]);
  // Opening a file takes the viewer elsewhere, so the list goes with it.
  await expect(list).toHaveCount(0);

  await used.locator('button[data-used-row="commands"]').click();
  await expect(list).toHaveAttribute("data-used-list", "commands");
  const commands = list.getByRole("button");
  // Newest last; a command run twice is one row, where it last ran.
  await expect(commands).toHaveText([
    "npm run typecheck",
    "npm test -- checkout×2",
    "git diff --stat",
    "npm test -- retry",
  ]);
  await commands.nth(0).click();
  expect((await asked(page)).shown).toHaveLength(1);
  // The transcript unfolds the work and marks the very row it was sent to.
  const current = page.locator('[data-transcript-search-current="true"]');
  await expect(current).toBeVisible();
  await expect(current).toContainText("npm run typecheck");
  // A jump within the chat leaves the list up for the next one.
  await expect(list).toBeVisible();

  await commands.nth(2).click();
  expect((await asked(page)).shown).toHaveLength(2);
  await expect(current).toContainText("git diff --stat");
});

test("the header jumps to the task list in chat", async ({ page }) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  await panelOf(page)
    .getByRole("button", { name: "Show the task list in chat" })
    .click();
  expect((await asked(page)).shown).toEqual(["tasks"]);
});

test("sections fold and stay folded", async ({ page }) => {
  await page.getByRole("button", { name: "Show session panel" }).click();
  const panel = panelOf(page);
  const facts = panel.getByRole("region", { name: "Session", exact: true });
  await expect(facts.getByText("Claude Code")).toHaveCount(0);
  await facts.getByRole("button", { name: "Session" }).click();
  await expect(facts).toContainText("Claude Code");
  await expect(facts).toContainText("Auto-accept edits");
  await expect(facts).toContainText("fix/duplicate-charge");
  await expect(facts).toContainText("42% · 84K / 200K tokens");

  const used = panel.getByRole("region", { name: "Used in this session" });
  await used.getByRole("button", { name: "Used in this session" }).click();
  await expect(used.locator("[data-used-row]")).toHaveCount(0);

  await page.reload();
  await expect(panel).toBeVisible();
  await expect(used.locator("[data-used-row]")).toHaveCount(0);
  await expect(facts).toContainText("Claude Code");
});
