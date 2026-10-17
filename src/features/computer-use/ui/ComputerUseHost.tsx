import { useComputerUseEvents } from "../model/client";

/** Mounted once per window: keeps computer-use state in step with the app. */
export function ComputerUseHost() {
  useComputerUseEvents();
  return null;
}
