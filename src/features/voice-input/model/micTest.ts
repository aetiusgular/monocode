import type { OpenCapture } from "./recorder";

export type MicTestResult = { heard: boolean; peak: number };

/** A peak under this is room noise, not someone talking. */
const HEARD_PEAK = 0.02;

/**
 * Listens for `seconds` and reports the loudest sample. The audio is dropped
 * right away; nothing is transcribed or kept.
 */
export async function testMicrophone(
  open: OpenCapture,
  seconds = 2,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<MicTestResult> {
  const capture = await open(seconds);
  try {
    await wait(seconds * 1000);
  } catch (error) {
    capture.cancel();
    throw error;
  }
  const { chunks } = capture.finish();
  let peak = 0;
  for (const chunk of chunks) {
    for (const value of chunk) peak = Math.max(peak, Math.abs(value));
  }
  chunks.length = 0;
  return { heard: peak >= HEARD_PEAK, peak: Math.min(1, peak) };
}
