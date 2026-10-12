import { expect, test, type Locator, type Page } from "@playwright/test";

const SETTINGS = "/tests/browser/plugins.html?view=settings";
const CHAT = "/tests/browser/plugins.html";

type Call = { args: string[]; cwd?: string; accountId?: string };

function pluginCalls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __plugins: Call[] }).__plugins.map(
      (call) => `${call.args.join(" ")}${call.cwd ? ` @ ${call.cwd}` : ""}`,
    ),
  );
}

const row = (page: Page, id: string) =>
  page.locator(`[data-plugin-row="${id}"]`);

async function noSideScroll(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
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

test("Settings lists every plugin with its scope, project and contents", async ({
  page,
}) => {
  await page.goto(SETTINGS);
  const rows = page.locator("[data-plugin-row]");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toHaveAttribute(
    "data-plugin-row",
    "enterprise-security-review-and-compliance-toolkit@first-party-plugins",
  );

  const obsidian = row(page, "obsidian@obsidian-skills");
  await expect(obsidian).toContainText("obsidian-skills");
  await expect(obsidian).toContainText("1.0.1");
  await expect(obsidian).toContainText("User");
  await expect(obsidian).toContainText("3 skills · 1 command");
  await expect(row(page, "paper-desktop@paper")).toContainText("MCP: paper");
  await expect(row(page, "browser-use@synced")).toContainText("claude.ai");

  const stripe = row(page, "stripe@claude-plugins-official");
  await expect(stripe).toContainText("Only in resale-platform");
  // On in its own project, though the home folder's list says off.
  await expect(stripe).toHaveAttribute("data-plugin-state", "on");

  const managed = row(page, "policy@corp-marketplace");
  await expect(managed.getByRole("switch")).toHaveCount(0);
  await expect(managed).toContainText("managed settings");

  // A long name stays in its row, and the switch stays on the right.
  const long = row(
    page,
    "enterprise-security-review-and-compliance-toolkit@first-party-plugins",
  );
  const rowBox = (await long.boundingBox())!;
  const switchBox = (await long.getByRole("switch").boundingBox())!;
  expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(
    rowBox.x + rowBox.width,
  );
  expect(switchBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
  await noSideScroll(page);

  // The marketplace list is read on open too, for the Marketplaces section
  // (#41). Nothing is installed or fetched.
  expect(await pluginCalls(page)).toEqual([
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin list --json @ /Users/me/Projects/resale-platform",
  ]);
});

test("a switch runs the CLI at the plugin's scope, and a refusal stays on the row", async ({
  page,
}) => {
  await page.goto(SETTINGS);
  const obsidian = row(page, "obsidian@obsidian-skills");
  await expect(obsidian.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await obsidian.getByRole("switch").click();
  await expect(obsidian).toHaveAttribute("data-plugin-state", "off");
  await expect(obsidian.getByRole("switch")).toBeEnabled();
  expect(await pluginCalls(page)).toContain(
    "plugin disable --scope user --json obsidian@obsidian-skills",
  );

  const stripe = row(page, "stripe@claude-plugins-official");
  await stripe.getByRole("switch").click();
  await expect(stripe).toHaveAttribute("data-plugin-state", "off");
  expect(await pluginCalls(page)).toContain(
    "plugin disable --scope local --json stripe@claude-plugins-official @ /Users/me/Projects/resale-platform",
  );

  const synced = row(page, "browser-use@synced");
  await synced.getByRole("switch").click();
  await expect(synced.getByRole("alert")).toContainText(
    "required by your organization",
  );
  await expect(synced).toHaveAttribute("data-plugin-state", "on");
  expect(await pluginCalls(page)).toContain(
    "plugin disable --json browser-use@synced",
  );
});

test("the Settings list fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(SETTINGS);
  await expect(page.locator("[data-plugin-row]")).toHaveCount(6);
  await noSideScroll(page);
  const refresh = page.getByRole("button", { name: "Refresh plugins" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.locator("[data-plugin-row]")).toHaveCount(6);
});

test("the chat's plugins list switches a plugin off for this chat only", async ({
  page,
}) => {
  await page.goto(CHAT);
  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await page.getByRole("button", { name: /Plugins/ }).click();
  const popover = page.getByRole("dialog", { name: "Plugins" });
  await expect(popover).toBeVisible();
  await settled(popover);
  const items = popover.locator("[data-chat-plugin]");
  await expect(items).toHaveCount(5);
  expect(
    await items.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-chat-plugin")),
    ),
  ).toEqual([
    "browser-use@synced",
    "obsidian@obsidian-skills",
    "paper-desktop@paper",
    "policy@corp-marketplace",
    "stripe@claude-plugins-official",
  ]);
  // Managed settings win over a chat's --settings: no switch that does nothing.
  const policy = popover.locator(
    '[data-chat-plugin="policy@corp-marketplace"]',
  );
  await expect(policy).toContainText("Set by your organization");
  await expect(policy.getByRole("switch")).toHaveCount(0);
  // The popover sits above the plus button and inside the window.
  const box = (await popover.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

  await popover.getByRole("switch", { name: "paper-desktop" }).click();
  await expect(
    popover.getByRole("switch", { name: "paper-desktop" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(popover).toContainText("Off for this chat only.");
  await expect(page.locator("[data-summary]")).toHaveText("1 plugin off");
  // Only the list ran: the chat's switch never touches Claude Code's settings.
  expect(await pluginCalls(page)).toEqual([
    "plugin list --json @ /Users/me/Projects/resale-platform",
  ]);

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Add files or choose a mode" }),
  ).toBeFocused();

  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await expect(page.getByRole("button", { name: /Plugins/ })).toContainText(
    "1 off",
  );
  await page.getByRole("button", { name: /Plugins/ }).click();
  await popover.getByRole("button", { name: "Manage plugins" }).click();
  await expect(popover).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened,
    ),
  ).toEqual(["plugins-settings"]);
});
