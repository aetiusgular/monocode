import type { ReactNode } from "react";
import {
  OUTBOUND_CALLS,
  useOutboundCalls,
  type OutboundCall,
} from "../../settings/model/outboundCalls";
import { setOutboundCall } from "../model/outboundSwitch";

/**
 * The Settings group for MonoCode's own outbound calls. SettingsView passes
 * its own Group, Row and Toggle so the rows look like every other setting.
 */
export type OutboundCallsSettingsParts = {
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

export function outboundCallRowDescription(call: OutboundCall): string {
  return `Reaches ${call.hosts.join(", ")}. ${call.description}`;
}

export function OutboundCallsSettings({
  Group,
  Row,
  Toggle,
}: OutboundCallsSettingsParts) {
  const settings = useOutboundCalls();
  return (
    <Group
      id="outbound-calls"
      title="Outbound calls"
      description="Calls MonoCode makes on its own, outside any agent. Off means the call is not made at all. Agents and their harnesses are not covered here."
    >
      {OUTBOUND_CALLS.map((call) => (
        <Row
          key={call.id}
          id={`outbound-${call.id}`}
          label={call.label}
          description={outboundCallRowDescription(call)}
        >
          <Toggle
            label={call.label}
            on={settings[call.id]}
            onChange={(next) => setOutboundCall(call.id, next)}
          />
        </Row>
      ))}
    </Group>
  );
}
