import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/browser/voice-input.html";

type Probe = {
  transcribed: number[];
  opened: number;
  canceled: number;
};

function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const { transcribed, opened, canceled } = (
      window as unknown as { __voice: Probe }
    ).__voice;
    return { transcribed, opened, canceled };
  });
}

const mic = (page: Page) => page.locator("[data-voice-input] button");
const state = (page: Page) =>
  page.locator("[data-voice-input]").getAttribute("data-voice-input");

test("the mic button records, shows elapsed time, transcribes and inserts at the caret", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const field = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByRole("button", { name: "Voice input" })).toBeVisible();

  // It sits just left of Send, the same size.
  const micBox = await mic(page).boundingBox();
  const sendBox = await page
    .getByRole("button", { name: "Send" })
    .boundingBox();
  expect(micBox && sendBox).toBeTruthy();
  expect(Math.abs(micBox!.width - sendBox!.width)).toBeLessThan(1);
  expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(sendBox!.x);

  await field.click();
  await field.press("End");
  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(
    page.getByRole("button", { name: "Stop and transcribe" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("timer")).toHaveText("0:01", { timeout: 3000 });
  // The caret stayed in the composer.
  await expect(field).toBeFocused();

  await page.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(
    page.getByRole("button", { name: "Transcribing" }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Transcribing…");
  expect(await state(page)).toBe("transcribing");

  const sent = await probe(page);
  // 16 kHz mono 16-bit: 32,000 bytes a second, plus the 44 byte header.
  expect(sent.transcribed).toHaveLength(1);
  expect(sent.transcribed[0]).toBeGreaterThan(44 + 32_000);
  expect((sent.transcribed[0] - 44) % 2).toBe(0);

  await page.evaluate(() =>
    (
      window as unknown as {
        __voice: { finishTranscription: (text: string) => void };
      }
    ).__voice.finishTranscription("the login bug"),
  );
  await expect(page.getByRole("button", { name: "Voice input" })).toBeVisible();
  await expect(field).toHaveValue("Fix the login bug");
  await expect(field).toBeFocused();
});

test("Escape cancels a recording and the shortcut toggles it", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const field = page.getByRole("textbox", { name: "Message" });
  await field.click();
  await page.keyboard.press("Meta+Shift+M");
  await expect(
    page.getByRole("button", { name: "Stop and transcribe" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Voice input" })).toBeVisible();
  const after = await probe(page);
  expect(after.canceled).toBe(1);
  expect(after.transcribed).toHaveLength(0);
  await expect(field).toHaveValue("Fix ");

  await page.keyboard.press("Meta+Shift+M");
  await expect(page.getByRole("timer")).toHaveText("0:01", { timeout: 3000 });
  await page.keyboard.press("Meta+Shift+M");
  await expect(
    page.getByRole("button", { name: "Transcribing" }),
  ).toBeVisible();
});

test("the mic button is hidden until whisper-cli and the model are installed", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?setup=missing`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.locator("[data-voice-input]")).toHaveCount(0);
});

test("Settings, Voice shows what is missing and downloads the model with progress", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?page=settings&setup=missing`);
  await expect(page.getByText("brew install whisper-cpp")).toBeVisible();
  await expect(page.getByText("Not found")).toBeVisible();
  await page.getByRole("button", { name: "Download model" }).click();
  await page.evaluate(() =>
    (
      window as unknown as {
        __voice: {
          reportProgress: (p: { received: number; total: number }) => void;
        };
      }
    ).__voice.reportProgress({ received: 36_991_053, total: 147_964_211 }),
  );
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  await expect(page.getByText("25%")).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { __voice: { finishDownload: () => void } }
    ).__voice.finishDownload(),
  );
  await expect(page.getByText("Downloaded, 141.1 MB.")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Test microphone" }).click();
  await expect(page.getByText("Heard you. Peak level 10%.")).toBeVisible();
});
