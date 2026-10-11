import { useState } from "react";

/**
 * A connector's catalog icon, or its first letter when there is none or it
 * does not load. The app's content policy allows images from a few hosts
 * only (GitHub avatars among them); every other icon shows the letter.
 */
export function ConnectorIcon({
  title,
  icon,
  size = "md",
}: {
  title: string;
  icon?: string;
  size?: "md" | "lg";
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const box = size === "lg" ? "size-10 rounded-xl" : "size-8 rounded-lg";
  if (icon && failed !== icon) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailed(icon)}
        className={`${box} shrink-0 border border-content/10 bg-white object-contain p-1`}
        data-connector-icon
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-connector-icon="letter"
      className={`${box} grid shrink-0 place-items-center border border-content/10 bg-content/8 font-medium text-content/70 ${size === "lg" ? "text-[16px]" : "text-[13px]"}`}
    >
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
