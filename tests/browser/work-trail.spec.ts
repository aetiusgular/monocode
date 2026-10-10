import { expect, test } from "@playwright/test";

// The session-panel fixture is a running Claude Code turn with twenty calls.
const FIXTURE = "/tests/browser/session-panel.html";

test("a running turn's work opens from its status line, call by call", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const transcript = page.locator(".agent-transcript");

  // Folded: one status line with the clock, and none of the commands.
  const show = page.getByRole("button", { name: "Show the work" });
  await expect(show).toBeVisible();
  await expect(show).toContainText("working");
  await expect(transcript.getByText("npm run typecheck")).toHaveCount(0);

  await show.click();
  await expect(transcript.getByText("npm run typecheck")).toBeVisible();
  await expect(transcript.getByText("git diff --stat")).toBeVisible();

  // A command that printed something opens onto its request and response.
  const open = page.getByRole("button", {
    name: "Show details for git diff --stat",
  });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-tool-call-detail]")).toHaveCount(0);
  await open.click();
  const detail = page.locator("[data-tool-call-detail]");
  await expect(detail).toHaveAttribute("data-tool-call-detail", "settled");
  await expect(detail.getByRole("region", { name: "Request" })).toContainText(
    "git diff --stat",
  );
  await expect(detail.getByRole("region", { name: "Response" })).toContainText(
    "2 files changed, 5 insertions(+), 3 deletions(-)",
  );

  await page
    .getByRole("button", { name: "Hide details for git diff --stat" })
    .click();
  await expect(detail).toHaveCount(0);

  // The row itself opens it too, not only the chevron.
  await transcript.getByText("npm run typecheck").click();
  await expect(detail.getByRole("region", { name: "Response" })).toContainText(
    "tsc --noEmit",
  );

  await page.getByRole("button", { name: "Hide the work" }).click();
  await expect(transcript.getByText("npm run typecheck")).toHaveCount(0);
});

test("the status line names the command in flight and shows its output so far", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?running=1`);
  const doing = page.locator("[data-live-doing]");
  await expect(doing).toContainText(
    "Running npm test -- retry-timeout --runInBand",
  );
  await expect(doing).toContainText("working");

  const open = page.getByRole("button", {
    name: "Show details for npm test -- retry-timeout --runInBand",
  });
  // A call in flight under the agent's last words is in view without unfolding.
  await expect(open).toBeVisible();
  await open.click();
  const detail = page.locator('[data-tool-call-detail="running"]');
  await expect(
    detail.getByRole("region", { name: "Output so far" }),
  ).toContainText("retries once on a timeout");
  await expect(detail.getByRole("region", { name: "Request" })).toContainText(
    "npm test -- retry-timeout --runInBand",
  );
});
