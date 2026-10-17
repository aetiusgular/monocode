import { useEffect, useState, type ReactNode } from "react";
import {
  setHarnessTelemetry,
  useHarnessTelemetry,
} from "../model/telemetrySettings";
import {
  harnessTelemetryStatus,
  type TelemetryStatus,
} from "../model/telemetryBridge";

/**
 * Settings, Telemetry. SettingsView passes its own Group, Row and Toggle so
 * the rows look like every other setting.
 */
export type TelemetrySettingsParts = {
  Group: (props: {
    id?: string;
    title: ReactNode;
    description?: string;
    children: ReactNode;
  }) => ReactNode;
  Row: (props: {
    id?: string;
    label: ReactNode;
    description?: string;
    children?: ReactNode;
  }) => ReactNode;
  Toggle: (props: {
    label: string;
    on: boolean;
    onChange: (on: boolean) => void;
  }) => ReactNode;
};

export const TELEMETRY_GROUP_DESCRIPTION =
  "Claude Code and Codex report what they do (tool calls, approvals, model requests) to a receiver inside MonoCode on this Mac. Nothing is sent anywhere else. Other harnesses are recorded from MonoCode's own view of their turns. A change applies from each chat's next turn.";

export const TELEMETRY_PROMPTS_DESCRIPTION =
  "Off: the harnesses send a redaction mark in place of your prompt text, and MonoCode drops it. On: your prompts are kept in the activity log on this Mac. Tool details (commands, file paths, arguments) are always kept.";

export function telemetryStatusLine(status: TelemetryStatus | null): string {
  if (!status) return "Not available in this build.";
  if (!status.listening) return "Not started yet. It starts with the first Claude Code or Codex chat.";
  const refused = status.refusedToken + status.refusedOther;
  return `Receiving: ${status.events} events from ${status.requests} requests${refused ? `, ${refused} refused` : ""}.`;
}

export function TelemetrySettings({ Group, Row, Toggle }: TelemetrySettingsParts) {
  const settings = useHarnessTelemetry();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void harnessTelemetryStatus().then((s) => {
        if (live) setStatus(s);
      });
    read();
    const timer = setInterval(read, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <Group id="harness-telemetry" title="Harness telemetry" description={TELEMETRY_GROUP_DESCRIPTION}>
      <Row
        id="telemetry-enabled"
        label="Record harness telemetry"
        description="Claude Code and Codex export their own events to MonoCode's receiver on 127.0.0.1."
      >
        <Toggle
          label="Record harness telemetry"
          on={settings.enabled}
          onChange={(on) => setHarnessTelemetry({ enabled: on })}
        />
      </Row>
      <Row id="telemetry-prompts" label="Include prompt text" description={TELEMETRY_PROMPTS_DESCRIPTION}>
        <Toggle
          label="Include prompt text"
          on={settings.enabled && settings.logPrompts}
          onChange={(on) => setHarnessTelemetry({ logPrompts: on })}
        />
      </Row>
      <Row id="telemetry-status" label="Receiver" description={telemetryStatusLine(status)} />
    </Group>
  );
}
