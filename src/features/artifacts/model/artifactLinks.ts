import { ask } from "@tauri-apps/plugin-dialog";

/** Longest link a visual may hand over; anything longer is dropped. */
export const MAX_ARTIFACT_LINK = 2048;
/** Longest stretch of a link the question shows before it cuts the middle. */
const SHOWN_LINK = 300;

/**
 * The link a visual's frame asked to open, or null. Only http and https, and
 * only a well-formed address, so a page cannot hand the app a file path or a
 * custom scheme.
 */
export function artifactLinkTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ARTIFACT_LINK)
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/**
 * The question shown before the link opens. The site is always named whole;
 * a long address shows both ends and says how much is left out (security
 * review K6).
 */
export function artifactLinkQuestion(url: string): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  const hidden = url.length - SHOWN_LINK;
  const shown =
    hidden > 0
      ? `${url.slice(0, SHOWN_LINK / 2)}…${url.slice(-SHOWN_LINK / 2)}\n(${hidden.toLocaleString("en-US")} characters not shown)`
      : url;
  return `Open this link in your browser?\n\nSite: ${host}\n${shown}\n\nIt comes from a page an agent wrote.`;
}

type Ask = (message: string, options: { title: string; kind: "warning" }) => Promise<boolean>;

/**
 * Asks in the native dialog before a visual's link opens. A page's own script
 * can post a link at any time, so a click inside the frame is not enough on
 * its own: the address is shown and you decide. A failed dialog reads as No.
 */
export async function confirmArtifactLink(
  url: string,
  askUser: Ask = ask,
): Promise<boolean> {
  try {
    return await askUser(artifactLinkQuestion(url), {
      title: "MonoCode",
      kind: "warning",
    });
  } catch {
    return false;
  }
}
