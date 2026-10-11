import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/record-skill.html";

type Recorded = {
  prompts: string[];
  expected: (input: {
    name: string;
    description: string;
    file: string;
  }) => string;
};

function prompts(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __record: Recorded }).__record.prompts,
  );
}

function expected(
  page: Page,
  input: { name: string; description: string; file: string },
): Promise<string> {
  return page.evaluate(
    (args) =>
      (window as unknown as { __record: Recorded }).__record.expected(args),
    input,
  );
}

async function openDialog(page: Page) {
  await page
    .getByRole("button", { name: "Add files or choose a mode" })
    .click();
  await page.getByRole("button", { name: /Record a skill/ }).click();
  const dialog = page.getByRole("dialog", { name: "Record a skill" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("opens from the plus menu with the name field focused", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  await expect(dialog.getByPlaceholder("fix-flaky-test")).toBeFocused();
  await expect(dialog.getByTestId("record-skill-path")).toHaveText(
    "/home/dev/storefront/.claude/skills/<name>/SKILL.md",
  );
});

test("validates the name", async ({ page }) => {
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  const name = dialog.getByPlaceholder("fix-flaky-test");
  const alert = dialog.getByRole("alert");

  await name.fill("Fix Checkout");
  await expect(alert).toHaveText(/Use lowercase letters/);
  await expect(dialog.getByTestId("record-skill-path")).toHaveText(
    "/home/dev/storefront/.claude/skills/<name>/SKILL.md",
  );
  await name.fill("deploy");
  await expect(alert).toHaveText("A skill named deploy already exists.");
  await name.fill("review-pr");
  await expect(alert).toHaveText("A skill named review-pr already exists.");
  await name.fill("fix-checkout");
  await expect(alert).toHaveCount(0);

  // No description yet: nothing is sent.
  await dialog.getByRole("button", { name: "Record" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Say when the skill should be used.",
  );
  expect(await prompts(page)).toEqual([]);
});

test("shows the exact path for each place to save", async ({ page }) => {
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  await dialog.getByPlaceholder("fix-flaky-test").fill("fix-checkout");
  const path = dialog.getByTestId("record-skill-path");
  await expect(path).toHaveText(
    "/home/dev/storefront/.claude/skills/fix-checkout/SKILL.md",
  );
  await dialog.getByRole("button", { name: /Just me/ }).click();
  await expect(path).toHaveText(
    "/home/dev/.claude/skills/fix-checkout/SKILL.md",
  );
  await expect(dialog).toContainText("the agent may ask before writing");
});

test("uses the Codex folders on Codex", async ({ page }) => {
  await page.goto(`${FIXTURE}?harness=codex`);
  const dialog = await openDialog(page);
  await dialog.getByPlaceholder("fix-flaky-test").fill("fix-checkout");
  await expect(dialog.getByTestId("record-skill-path")).toHaveText(
    "/home/dev/storefront/.agents/skills/fix-checkout/SKILL.md",
  );
});

test("Record sends the expected prompt once and closes", async ({ page }) => {
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  await dialog.getByPlaceholder("fix-flaky-test").fill("fix-checkout");
  await dialog
    .getByPlaceholder("Use when a test fails only on CI.")
    .fill("Use when checkout tests fail on CI.");
  await dialog
    .getByPlaceholder("Use when a test fails only on CI.")
    .press("Enter");
  await expect(dialog).toBeHidden();

  const sent = await prompts(page);
  expect(sent).toHaveLength(1);
  const file = "/home/dev/storefront/.claude/skills/fix-checkout/SKILL.md";
  expect(sent[0]).toBe(
    await expected(page, {
      name: "fix-checkout",
      description: "Use when checkout tests fail on CI.",
      file,
    }),
  );
  expect(sent[0]).toContain(`Write exactly one file: \`${file}\``);
  expect(sent[0]).toContain(
    "---\nname: fix-checkout\ndescription: Use when checkout tests fail on CI.\n---",
  );
  expect(sent[0]).toContain(
    "> 1. The checkout test fails on CI only. Find out why and fix it.",
  );
  expect(sent[0]).toMatch(/> - `[^`]*npm test -- checkout[^`]*` \(x2\)/);
  expect(sent[0]).toContain("> - `src/checkout/charge.ts`");
  // Focus goes back to the opener.
  await expect(
    page.getByRole("button", { name: "Add files or choose a mode" }),
  ).toBeFocused();
});

test("Escape closes without sending", async ({ page }) => {
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  await dialog.getByPlaceholder("fix-flaky-test").fill("fix-checkout");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await prompts(page)).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Add files or choose a mode" }),
  ).toBeFocused();
});

test("the dialog fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 640 });
  await page.goto(FIXTURE);
  const dialog = await openDialog(page);
  await dialog
    .getByPlaceholder("fix-flaky-test")
    .fill("a-rather-long-skill-name-for-the-checkout-retry-flow");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  const path = await dialog.getByTestId("record-skill-path").boundingBox();
  expect(path!.x + path!.width).toBeLessThanOrEqual(box!.x + box!.width);
});
