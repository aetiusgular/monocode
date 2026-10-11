import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/connectors.html";

type Call = { args: string[]; stdin?: boolean };

function dockerCalls(page: Page): Promise<Call[]> {
  return page.evaluate(
    () => (window as unknown as { __docker: Call[] }).__docker,
  );
}

const cards = (page: Page) => page.locator("[data-connector-card]");

test("Discover lays the catalog out in two columns and searches it", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await expect(
    page.getByRole("radio", { name: "Discover", checked: true }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(11);

  const first = await cards(page).nth(0).boundingBox();
  const second = await cards(page).nth(1).boundingBox();
  const third = await cards(page).nth(2).boundingBox();
  expect(first && second && third).toBeTruthy();
  // Two per row: the second card sits beside the first, the third below.
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1);
  expect(third!.y).toBeGreaterThan(first!.y + first!.height - 1);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByRole("textbox", { name: "Search connectors" }).fill("pay");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute(
    "data-connector-card",
    "stripe-remote",
  );
  await page.getByRole("textbox", { name: "Search connectors" }).fill("");

  await page.getByRole("radio", { name: "Runs in Docker" }).click();
  await expect(cards(page)).toHaveCount(6);
  await expect(cards(page).getByText("API key").first()).toBeVisible();
});

test("one column on a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await page.goto(FIXTURE);
  await expect(cards(page)).toHaveCount(11);
  const first = await cards(page).nth(0).boundingBox();
  const second = await cards(page).nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("adding a connector that needs a key opens its setup form, and the check waits for a passing test", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const opener = page.getByRole("button", { name: "GitHub details" });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "GitHub" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("create_issue")).toBeVisible();
  await sheet.getByRole("button", { name: "Add" }).click();

  const form = sheet.getByRole("form", { name: "Set up" });
  await expect(form).toBeVisible();
  const key = form.getByLabel("Value for github.personal_access_token");
  await expect(key).toHaveAttribute("type", "password");
  await expect(page.getByRole("img", { name: "GitHub works" })).toHaveCount(0);
  await expect(page.locator('[data-connector-card="github"]')).toHaveAttribute(
    "data-connector-state",
    "needs-setup",
  );

  await key.fill("ghp_fixture_value");
  await form.getByRole("button", { name: "Save and test" }).click();
  await expect(key).toHaveValue("");
  await expect(sheet.getByText(/^Works: 4 tools/)).toBeVisible();
  const set = (await dockerCalls(page)).find((call) => call.args[2] === "set");
  expect(set).toEqual({
    args: ["mcp", "secret", "set", "github.personal_access_token"],
    stdin: true,
  });

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(page.getByRole("img", { name: "GitHub works" })).toBeVisible();

  await page.getByRole("radio", { name: /Yours/ }).click();
  await expect(cards(page)).toHaveCount(1);
});

test("the setup form asks for required settings and keeps optional ones under More settings", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await page.getByRole("button", { name: "Add Gmail" }).click();
  const form = page
    .getByRole("dialog", { name: "Gmail" })
    .getByRole("form", { name: "Set up" });
  const email = form.getByRole("textbox", { name: "email_address" });
  await expect(email).toBeFocused();
  await expect(form.getByText("Your Gmail email address")).toBeVisible();
  await expect(form.getByRole("textbox", { name: "imap_host" })).toBeHidden();
  await form.getByText("More settings").click();
  await expect(form.getByRole("textbox", { name: "imap_host" })).toBeVisible();
});

test("card states: testing, works, failed, and waiting for a sign-in", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?time=fails&signin=hangs`);
  await page.getByRole("button", { name: "Add Hugging Face" }).click();
  await expect(
    page.locator('[data-connector-card="hugging-face"]'),
  ).toHaveAttribute("data-connector-state", "testing");
  await expect(
    page.getByRole("img", { name: "Hugging Face works" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add Time" }).click();
  const failed = page.getByRole("button", { name: "Failed: Time" });
  await expect(failed).toBeVisible();
  await expect(
    page
      .locator('[data-connector-card="time"]')
      .getByText("Failed: No build for Apple Silicon"),
  ).toBeVisible();
  await failed.click();
  const sheet = page.getByRole("dialog", { name: "Time" });
  await sheet.getByText("Details").click();
  await expect(sheet.getByText(/no matching manifest/)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Add Notion" }).click();
  const notion = page.locator('[data-connector-card="notion-remote"]');
  await expect(
    notion.getByText("Waiting for sign-in in your browser…"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in for Notion" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in: Notion" }),
  ).toBeVisible();
});

test("says Docker Desktop is not running", async ({ page }) => {
  await page.goto(`${FIXTURE}?docker=stopped`);
  await expect(
    page.getByText("Docker Desktop is not running. Open it to use connectors."),
  ).toBeVisible();
});
