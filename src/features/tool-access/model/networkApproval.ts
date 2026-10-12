import type { Block } from "../../sessions/model/session";

/** Extra choices sent with an approval answer. Only Codex reads them. */
export type ApprovalOptions = {
  networkAmendment?: { host: string; action: "allow" };
  /** "Allow for this chat": the chat's rule is saved, and Codex may keep the grant. */
  forChat?: boolean;
};

const PROTOCOL_LABEL: Record<string, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks5Tcp: "SOCKS5 TCP",
  socks5Udp: "SOCKS5 UDP",
};

/**
 * What a network approval card shows: the host, a protocol label and, when
 * the harness proposed an `allow` rule for that exact host, the host the
 * "Always allow" choice names. Null for an approval that is not about the
 * network. The host is untrusted text: callers render it as plain text.
 */
export function networkApprovalView(
  approval: Block["approval"] | undefined,
): { host: string; protocol: string; alwaysAllowHost?: string } | null {
  const network = approval?.network;
  if (!network) return null;
  const allow = network.amendments?.some(
    (item) => item.action === "allow" && item.host === network.host,
  );
  return {
    host: network.host,
    protocol: PROTOCOL_LABEL[network.protocol] ?? network.protocol,
    ...(allow ? { alwaysAllowHost: network.host } : {}),
  };
}

/** The options for the "Always allow <host>" choice. */
export function alwaysAllowHostOptions(host: string): ApprovalOptions {
  return { networkAmendment: { host, action: "allow" } };
}
