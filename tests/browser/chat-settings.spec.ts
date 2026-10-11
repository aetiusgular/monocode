import { expect, test, type Locator, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/chat-settings.html";

function answers(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __chat: { answers: string[] } }).__chat.answers,
  );
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("not laid out");
  return bounds;
}

/** A popover grows in as it opens; measure it once it has stopped. */
async function settled(locator: Locator) {
  await locator.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
}

async function openToolAccess(page: Page) {
  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await page.getByRole("button", { name: /Tool access/ }).click();
  const popover = page.getByRole("dialog", { name: "Tool access" });
  await expect(popover).toBeVisible();
  await settled(popover);
  return popover;
}

test("the rule menu sits in the card's button row and opens under it", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const allow = page
    .getByRole("button", { name: "Allow", exact: true })
    .first();
  const deny = page.getByRole("button", { name: "Deny", exact: true }).first();
  const more = page.getByRole("button", { name: "Remember a choice for Bash" });
  await expect(more).toBeVisible();

  const [allowBox, denyBox, moreBox] = await Promise.all([
    box(allow),
    box(deny),
    box(more),
  ]);
  // One row, same height, to the right of Deny.
  expect(Math.abs(moreBox.y - denyBox.y)).toBeLessThan(1);
  expect(Math.abs(moreBox.height - denyBox.height)).toBeLessThan(1);
  expect(Math.abs(allowBox.y - denyBox.y)).toBeLessThan(1);
  expect(moreBox.x).toBeGreaterThan(denyBox.x + denyBox.width);

  await more.click();
  const menu = page.getByRole("menu", { name: "Remember a choice for Bash" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Always allow Bash in this chat",
    "Never allow Bash in this chat",
  ]);
  await settled(menu);
  const menuBox = await box(menu);
  expect(menuBox.y).toBeGreaterThanOrEqual(moreBox.y + moreBox.height);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1000);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(800);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("choosing a rule on the card answers it and shows in the tool list", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await page
    .getByRole("button", { name: "Remember a choice for Bash" })
    .click();
  await page
    .getByRole("menuitem", { name: "Always allow Bash in this chat" })
    .click();
  expect(await answers(page)).toEqual(["1:allow"]);
  await expect(
    page.getByRole("button", { name: "Remember a choice for Bash" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-summary]")).toHaveText("1 tool rule");

  const popover = await openToolAccess(page);
  await expect(
    popover
      .getByRole("radiogroup", { name: "Bash access" })
      .getByRole("radio", { checked: true }),
  ).toHaveText("Always");
});

test("a long tool name wraps in the menu and is cut short in the list", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const more = page.getByRole("button", {
    name: /Remember a choice for internal-knowledge-base/,
  });
  await more.click();
  const menu = page.getByRole("menu");
  await settled(menu);
  const menuBox = await box(menu);
  expect(menuBox.width).toBeLessThanOrEqual(252);
  for (const item of await menu.getByRole("menuitem").all()) {
    const itemBox = await box(item);
    expect(itemBox.x).toBeGreaterThanOrEqual(menuBox.x);
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(
      menuBox.x + menuBox.width + 0.5,
    );
    // The name is not clipped: the entry grows to more than one line.
    expect(itemBox.height).toBeGreaterThan(30);
  }
  await page.keyboard.press("Escape");

  const popover = await openToolAccess(page);
  const row = popover.getByRole("listitem").filter({
    hasText: "internal-knowledge-base",
  });
  await expect(row).toHaveCount(1);
  const popoverBox = await box(popover);
  const control = row.getByRole("radiogroup");
  const [rowBox, controlBox, nameBox] = await Promise.all([
    box(row),
    box(control),
    box(row.locator("span > span").first()),
  ]);
  // The control keeps its full width inside the popover; the name gives way.
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
    popoverBox.x + popoverBox.width,
  );
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(controlBox.x);
  expect(rowBox.height).toBeLessThan(48);
  const [first] = await popover.getByRole("radiogroup").all();
  expect((await box(first)).width).toBeCloseTo(controlBox.width, 0);
});

test("the tool list sets, shows and resets rules without overflowing", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const popover = await openToolAccess(page);
  await expect(popover.getByRole("listitem")).toHaveCount(6);
  await expect(popover.getByRole("radio", { checked: true })).toHaveText(
    Array(6).fill("Ask"),
  );
  await expect(popover.getByRole("button", { name: "Reset all" })).toHaveCount(
    0,
  );
  expect(
    await popover.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  // The whole list is on screen above the composer row.
  const popoverBox = await box(popover);
  expect(popoverBox.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox.width).toBeLessThanOrEqual(330);

  const bash = popover.getByRole("radiogroup", { name: "Bash access" });
  await bash.getByRole("radio", { name: "Never" }).click();
  await expect(bash.getByRole("radio", { checked: true })).toHaveText("Never");
  await expect(page.locator("[data-summary]")).toHaveText("1 tool rule");
  await expect(popover).toContainText(
    "Never takes the tool away when the next turn starts.",
  );
  const write = popover.getByRole("radiogroup", { name: "Write access" });
  await write.getByRole("radio", { name: "Always" }).click();
  await expect(page.locator("[data-summary]")).toHaveText("2 tool rules");
  await expect(popover).toContainText("Always is not used in plan turns.");

  await popover.getByRole("button", { name: "Reset all" }).click();
  await expect(popover.getByRole("radio", { checked: true })).toHaveText(
    Array(6).fill("Ask"),
  );
  await expect(page.locator("[data-summary]")).toHaveText("");

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add files or choose a mode" }),
  ).toBeFocused();
});

test("the plus menu entry counts the rules in effect", async ({ page }) => {
  await page.goto(FIXTURE);
  const popover = await openToolAccess(page);
  await popover
    .getByRole("radiogroup", { name: "Edit access" })
    .getByRole("radio", { name: "Never" })
    .click();
  await page.mouse.click(500, 100);
  await expect(popover).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await expect(page.getByRole("button", { name: /Tool access/ })).toContainText(
    "1 rule",
  );
});

test("Codex lists its two kinds of request and says what never cannot do", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?harness=codex`);
  await expect(
    page.getByRole("button", { name: "Remember a choice for Commands" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remember a choice for File edits" })
    .click();
  await page
    .getByRole("menuitem", { name: "Never allow File edits in this chat" })
    .click();
  expect(await answers(page)).toEqual(["2:deny"]);

  const popover = await openToolAccess(page);
  await expect(popover.getByRole("listitem")).toHaveCount(2);
  await expect(
    popover
      .getByRole("radiogroup", { name: "File edits access" })
      .getByRole("radio", { checked: true }),
  ).toHaveText("Never");
  await expect(popover).toContainText(
    "Never declines when Codex asks. Codex runs safe commands without asking.",
  );
  expect(
    await popover.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

async function openSkills(page: Page) {
  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await page.getByRole("button", { name: /Skills/ }).click();
  const popover = page.getByRole("dialog", { name: "Skills" });
  await expect(popover).toBeVisible();
  await settled(popover);
  return popover;
}

test("the skill list switches a skill off for the chat and says what that covers", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const popover = await openSkills(page);
  await expect(popover.getByRole("listitem")).toHaveCount(4);
  await expect(popover.getByRole("switch", { checked: true })).toHaveCount(4);
  await expect(popover).not.toContainText("Off also stops Claude Code");

  await popover.getByRole("switch", { name: "deploy", exact: true }).click();
  await expect(
    popover.getByRole("switch", { name: "deploy", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(popover).toContainText(
    "Off also stops Claude Code from using the skill on its own.",
  );
  await expect(page.locator("[data-summary]")).toHaveText("1 skill off");

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add files or choose a mode" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Skills/ })).toContainText(
    "1 off",
  );
});

test("long skill names and descriptions are cut short, never the switch", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const popover = await openSkills(page);
  expect(
    await popover.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const popoverBox = await box(popover);
  const switches = await popover.getByRole("switch").all();
  const widths = new Set<number>();
  for (const toggle of switches) {
    const toggleBox = await box(toggle);
    widths.add(Math.round(toggleBox.width));
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(
      popoverBox.x + popoverBox.width,
    );
  }
  expect(widths.size).toBe(1);
  for (const row of await popover.getByRole("listitem").all()) {
    // Two lines of text at most: a name and a description.
    expect((await box(row)).height).toBeLessThan(48);
  }
  // The full description is still there to read.
  await expect(
    popover.getByTitle(/Ship the current branch to staging, wait/),
  ).toHaveCount(1);
});

test("Manage skills asks for the Skills settings page and closes the list", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const popover = await openSkills(page);
  await popover.getByRole("button", { name: "Manage skills" }).click();
  await expect(popover).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __chat: { opened: string[] } }).__chat.opened,
    ),
  ).toEqual(["skills-settings"]);
});

test("on Codex the skill list says the harness may still load the skill", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?harness=codex`);
  const popover = await openSkills(page);
  await popover.getByRole("switch", { name: "review-pr" }).click();
  await expect(popover).toContainText(
    "Off covers this chat's / menu. Codex may still load the skill on its own.",
  );
});
