import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
export function SettingsDisclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`settings-disclosure ${open ? "open" : ""}`}>
      <button
        className="settings-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <ChevronDown size={17} />
      </button>
      {open && <div className="settings-content">{children}</div>}
    </section>
  );
}
