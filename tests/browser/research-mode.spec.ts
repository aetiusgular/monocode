import { expect, test, type Locator, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/research-mode.html";

type Asked = { prompts: string[]; opened: string[] };

function asked(page: Page): Promise<Asked> {
  return page.evaluate(
    () => (window as unknown as { __research: Asked }).__research,
  );
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("not laid out");
  return bounds;
}

const plusButton = (page: Page) =>
  page.getByRole("button", { name: "Add files or choose a mode" });
const researchRow = (page: Page) =>
  page
    .locator("[data-composer-plus]")
    .getByRole("button", { name: /Research/ });
const chip = (page: Page) => page.locator("[data-research-chip]");

test("the plus menu turns research on, the chip shows above the input, and X turns it off", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await plusButton(page).click();
  const row = researchRow(page);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Search the web and write a cited report");
  await expect(row).toHaveAttribute("aria-pressed", "false");

  await row.click();
  await expect(page.locator("[data-composer-plus]")).toHaveCount(0);
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveText(/Research/);
  await expect(
    page.getByRole("textbox", { name: "Message input" }),
  ).toBeFocused();

  // The chip sits above the input, inside the composer.
  const [chipBox, inputBox, composerBox] = await Promise.all([
    box(chip(page).locator("> div")),
    box(page.getByRole("textbox", { name: "Message input" })),
    box(page.locator("[data-composer]")),
  ]);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(inputBox.y + 1);
  expect(chipBox.x).toBeGreaterThanOrEqual(composerBox.x);
  expect(chipBox.height).toBeLessThan(30);

  await plusButton(page).click();
  await expect(researchRow(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composer-plus]")).toHaveCount(0);

  await page.getByRole("button", { name: "Turn off Research" }).click();
  await expect(chip(page)).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message input" }),
  ).toBeFocused();
});

test("a research message shows the user's words with a Research label and sends the wrapper", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await plusButton(page).click();
  await researchRow(page).click();
  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Which zstd levels suit log archives?");
  await page.keyboard.press("Enter");

  await expect(chip(page)).toHaveCount(0);
  const label = page.locator("[data-research-label]");
  await expect(label).toHaveCount(1);
  await expect(label).toHaveText("Research");
  await expect(
    page.getByText("Which zstd levels suit log archives?"),
  ).toBeVisible();
  await expect(page.getByText("Research mode is on")).toHaveCount(0);

  const [prompt] = (await asked(page)).prompts;
  expect(prompt).toContain("Research mode is on for this message.");
  expect(prompt).toContain(
    "Search tools in this chat: WebSearch and the exa connector (web_search_exa).",
  );
  expect(prompt).toMatch(
    /research\/\d{4}-\d{2}-\d{2}-which-zstd-levels-suit-log-archives\.md/,
  );
  expect(prompt).toContain("subagents (the Task or Agent tool)");

  // Research is per message: the next one goes out plain.
  await page.getByRole("textbox", { name: "Message input" }).fill("Thanks");
  await page.keyboard.press("Enter");
  await expect(label).toHaveCount(1);
  expect((await asked(page)).prompts[1]).toBe("Thanks");
});

test("a chat with no search tool says so and links to Connectors", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?search=none`);
  await plusButton(page).click();
  const row = researchRow(page);
  await expect(row).toContainText("No search tool in this chat");
  await expect(row).toContainText("Connectors");
  await expect(row).not.toHaveAttribute("aria-pressed", /.*/);
  // The note fits the menu row without wrapping out of it.
  const [rowBox, menuBox] = await Promise.all([
    box(row),
    box(page.locator("[data-composer-plus]")),
  ]);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
    menuBox.x + menuBox.width + 1,
  );
  expect(rowBox.height).toBeLessThan(60);

  await row.click();
  await expect(page.locator("[data-composer-plus]")).toHaveCount(0);
  await expect(chip(page)).toHaveCount(0);
  expect((await asked(page)).opened).toEqual(["connectors:discover"]);

  await page
    .getByRole("textbox", { name: "Message input" })
    .fill("Plain question");
  await page.keyboard.press("Enter");
  expect((await asked(page)).prompts).toEqual(["Plain question"]);
  await expect(page.locator("[data-research-label]")).toHaveCount(0);
});
