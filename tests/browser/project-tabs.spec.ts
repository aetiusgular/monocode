import { expect, test, type Locator, type Page } from "@playwright/test";

const PAGE = "/tests/browser/project-tabs.html";
const ALPHA = "/Users/me/Projects/alpha";
const BETA = "/Users/me/Projects/beta";
const GAMMA = "/Users/me/Projects/gamma";

// On Linux the strip shares the title bar with the window title, so give the
// five tabs and their gaps room to lay out without scrolling.
test.use({ viewport: { width: 1800, height: 800 } });

const stub = (page: Page, key: string) =>
  page.locator(`[data-project-stub="${key}"]`);
const titleTab = (page: Page, id: string) =>
  page.locator(`[data-title-tab-id="${id}"]`);
const tabButton = (page: Page, id: string) =>
  titleTab(page, id).locator("button").first();

/** Gaps, stubs and tabs as the strip lays them out, left to right. */
function stripOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-title-tab-strip] [data-project-gap], [data-title-tab-strip] [data-project-stub], [data-title-tab-strip] [data-title-tab-id]",
      ),
      (node) =>
        node.dataset.titleTabId ??
        (node.dataset.projectStub
          ? `stub:${node.dataset.projectStub.split("/").pop()}`
          : "gap"),
    ),
  );
}

function tabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-title-tab-strip] [data-title-tab-id]",
      ),
      (node) => node.dataset.titleTabId!,
    ),
  );
}

const background = (locator: Locator) =>
  locator.evaluate((node) => getComputedStyle(node).backgroundColor);

/** Fold a project from one of its tabs' context menus. */
async function foldFromTab(page: Page, id: string, project: string) {
  await titleTab(page, id).click({ button: "right" });
  await page
    .locator('[role="menu"]')
    .getByRole("menuitem", { name: `Collapse ${project}` })
    .click();
}

/** Press on a tab, move the pointer to `x`, and leave the button down. */
async function dragTo(page: Page, id: string, x: number) {
  const box = (await titleTab(page, id).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, y, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  // The hook paints on the next frame.
  await page.waitForTimeout(80);
}

test("tints each project's tabs and sets projects apart with a gap", async ({
  page,
}) => {
  await page.goto(PAGE);
  expect(await stripOrder(page)).toEqual([
    "a1",
    "a2",
    "gap",
    "b1",
    "gap",
    "g1",
    "g2",
  ]);
  await expect(page.locator("[data-project-stub]")).toHaveCount(0);

  // The tint is the project's colour; the project is named in the tooltip.
  await expect(page.locator("[data-project-tint]")).toHaveCount(5);
  expect(
    await background(titleTab(page, "b1").locator("[data-project-tint]")),
  ).toBe("rgb(255, 136, 0)");
  await expect(tabButton(page, "b1")).toHaveAttribute(
    "title",
    /^beta · Migrate the schema/,
  );
  await expect(page.locator("[data-title-tab-strip]")).not.toContainText(
    "beta",
  );

  // The gap is real space between the last tab of one project and the first
  // of the next, wider than the space between two tabs of one project.
  const a1 = (await titleTab(page, "a1").boundingBox())!;
  const a2 = (await titleTab(page, "a2").boundingBox())!;
  const b1 = (await titleTab(page, "b1").boundingBox())!;
  expect(b1.x - (a2.x + a2.width)).toBeGreaterThanOrEqual(12);
  expect(a2.x - (a1.x + a1.width)).toBeLessThan(6);

  // Working and finished tabs read from the strip itself.
  await expect(
    titleTab(page, "b1").locator('[data-harness-status="busy"]'),
  ).toHaveCount(1);
  await expect(
    titleTab(page, "g1").locator('[data-harness-status="done"]'),
  ).toHaveCount(1);
  await expect(tabButton(page, "g1")).toHaveClass(/text-content\/80/);

  // The worktree tab names its branch under its title.
  await expect(titleTab(page, "g2")).toContainText("feature-x · Second chat");
  await expect(titleTab(page, "g1")).not.toContainText("feature-x");

  // Everything sits inside the title bar, with no strip overflow.
  const header = (await page.locator("header").boundingBox())!;
  expect(header.height).toBe(40);
  await expect(
    page.getByRole("button", { name: "Scroll tabs right" }),
  ).toHaveCount(0);
  for (const id of ["a1", "b1", "g2"]) {
    const box = (await titleTab(page, id).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(header.y);
    expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
  }
});

test("folds a project to a stub from a tab's menu, keeps the active tab, and remembers it across a reload", async ({
  page,
}) => {
  await page.goto(PAGE);
  const gammaTint = await background(
    titleTab(page, "g1").locator("[data-project-tint]"),
  );
  await foldFromTab(page, "g1", "gamma");
  await expect(stub(page, GAMMA)).toHaveAttribute("aria-expanded", "false");
  await expect(
    stub(page, GAMMA).locator("[data-project-stub-count]"),
  ).toHaveText("2");
  expect(await tabOrder(page)).toEqual(["a1", "a2", "b1"]);

  // Gamma's finished tab shows on the stub; beta's working tab would too.
  await expect(stub(page, GAMMA)).toHaveAttribute("data-project-done", "true");
  await expect(stub(page, GAMMA)).not.toHaveAttribute("data-project-busy");
  await expect(
    stub(page, GAMMA).locator("[data-project-stub-done]"),
  ).toHaveCount(1);
  await expect(stub(page, GAMMA)).toHaveAttribute(
    "title",
    "gamma: 2 tabs, one finished. Click to expand.",
  );
  // The stub keeps the project's colour under it.
  expect(
    await background(stub(page, GAMMA).locator("[data-project-tint]")),
  ).toBe(gammaTint);

  // The active tab stays on screen when its own group folds.
  await foldFromTab(page, "a2", "alpha");
  expect(await stripOrder(page)).toEqual([
    "stub:alpha",
    "a1",
    "gap",
    "b1",
    "gap",
    "stub:gamma",
  ]);
  await expect(
    stub(page, ALPHA).locator("[data-project-stub-count]"),
  ).toHaveText("2");

  await page.goto(`${PAGE}?keep=1`);
  await expect(stub(page, GAMMA)).toHaveCount(1);
  await expect(stub(page, ALPHA)).toHaveCount(1);
  expect(await tabOrder(page)).toEqual(["a1", "b1"]);

  await stub(page, GAMMA).click();
  await expect(stub(page, GAMMA)).toHaveCount(0);
  expect(await tabOrder(page)).toEqual(["a1", "b1", "g1", "g2"]);

  // Switching to another project leaves the folded one folded.
  await tabButton(page, "g1").click();
  await expect(page.locator("[data-active]")).toHaveText("Active: g1");
  await expect(stub(page, ALPHA)).toHaveCount(1);
  expect(await tabOrder(page)).toEqual(["b1", "g1", "g2"]);
});

test("a working tab keeps its project's stub spinning, and an option-click folds", async ({
  page,
}) => {
  await page.goto(PAGE);
  await tabButton(page, "b1").click({ modifiers: ["Alt"] });
  await expect(page.locator("[data-active]")).toHaveText("Active: a1");
  await expect(stub(page, BETA)).toHaveAttribute("data-project-busy", "true");
  await expect(
    stub(page, BETA).locator("[data-project-stub-count]"),
  ).toHaveText("1");
  await expect(stub(page, BETA)).toHaveAttribute(
    "title",
    "beta: 1 tab, working. Click to expand.",
  );
  expect(await stripOrder(page)).toEqual([
    "a1",
    "a2",
    "gap",
    "stub:beta",
    "gap",
    "g1",
    "g2",
  ]);
});

test("the stub's menu closes the project's tabs and lands outside the group", async ({
  page,
}) => {
  await page.goto(PAGE);
  await tabButton(page, "b1").click();
  await expect(page.locator("[data-active]")).toHaveText("Active: b1");

  await foldFromTab(page, "a1", "alpha");
  await stub(page, ALPHA).click({ button: "right" });
  const menu = page.locator('[role="menu"]');
  await expect(menu.locator('[role="menuitem"]')).toHaveText([
    "Expand alpha",
    "Close alpha Tabs2 tabs",
  ]);
  await menu.getByRole("menuitem", { name: "Close alpha Tabs" }).click();

  await expect(stub(page, ALPHA)).toHaveCount(0);
  expect(await tabOrder(page)).toEqual(["b1", "g1", "g2"]);
  await expect(page.locator("[data-active]")).toHaveText("Active: b1");
});

test("drags reorder inside a project and stop at the group's edge", async ({
  page,
}) => {
  await page.goto(PAGE);

  // Within gamma: the main tab moves past the worktree tab.
  const g2 = (await titleTab(page, "g2").boundingBox())!;
  await dragTo(page, "g1", g2.x + g2.width - 4);
  await page.mouse.up();
  await expect
    .poll(() => tabOrder(page))
    .toEqual(["a1", "a2", "b1", "g2", "g1"]);

  // Past alpha's edge: the drag is held at the edge and beta never moves.
  const a2 = (await titleTab(page, "a2").boundingBox())!;
  const strip = (await page.locator("[data-title-tab-strip]").boundingBox())!;
  await dragTo(page, "a1", strip.x + strip.width - 8);
  const handle = titleTab(page, "a1").locator(".reorder-item");
  const handleBox = (await handle.boundingBox())!;
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(
    a2.x + a2.width + 1,
  );
  const betaShift = await titleTab(page, "b1")
    .locator(".reorder-item")
    .evaluate((node) => node.style.transform);
  expect(betaShift === "" || /translate3d\(0px/.test(betaShift)).toBe(true);
  await page.mouse.up();
  await expect
    .poll(() => tabOrder(page))
    .toEqual(["a2", "a1", "b1", "g2", "g1"]);
  expect(await stripOrder(page)).toEqual([
    "a2",
    "a1",
    "gap",
    "b1",
    "gap",
    "g2",
    "g1",
  ]);
});

test("one project shows plain tabs that still reorder freely", async ({
  page,
}) => {
  await page.goto(`${PAGE}?single=1`);
  await expect(page.locator("[data-project-stub]")).toHaveCount(0);
  await expect(page.locator("[data-project-gap]")).toHaveCount(0);
  await expect(page.locator("[data-project-tint]")).toHaveCount(0);
  expect(await tabOrder(page)).toEqual(["a1", "a2", "a3"]);

  const strip = (await page.locator("[data-title-tab-strip]").boundingBox())!;
  await dragTo(page, "a1", strip.x + strip.width - 8);
  await page.mouse.up();
  await expect.poll(() => tabOrder(page)).toEqual(["a2", "a3", "a1"]);
});
