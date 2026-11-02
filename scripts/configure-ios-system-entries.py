#!/usr/bin/env python3
"""Create a local XcodeGen overlay for a provisioned WidgetKit App Group.

This does not create a developer identity, enable capabilities on Apple's
portal, sign an application, or modify the checked-in default configuration.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess


def configure(project: Path, group: str, base_entitlements: Path | None = None) -> Path:
    if not re.fullmatch(r"group\.[A-Za-z0-9.-]{1,194}", group):
        raise ValueError("Use the App Group identifier registered for both app targets (group.…).")
    folder = project / ".system-entry"
    folder.mkdir(mode=0o700, exist_ok=True)
    source = base_entitlements or project / "steamguard_iOS/steamguard_iOS.entitlements"
    with source.open("rb") as file:
        main = plistlib.load(file)
    if not isinstance(main, dict):
        raise ValueError("Main application entitlements must contain a dictionary.")
    groups = main.get("com.apple.security.application-groups", [])
    if not isinstance(groups, list) or not all(isinstance(value, str) for value in groups):
        raise ValueError("Existing App Group entitlements are invalid.")
    main["com.apple.security.application-groups"] = list(dict.fromkeys([*groups, group]))
    widget = {"com.apple.security.application-groups": [group]}
    for name, value in (("app.entitlements", main), ("widget.entitlements", widget)):
        target = folder / name
        target.write_bytes(plistlib.dumps(value, sort_keys=True))
        target.chmod(0o600)
    # JSON string syntax is also valid YAML and cannot introduce YAML keys.
    overlay = project / "system-entry.generated.yml"
    overlay.write_text(
        "include:\n  - project.yml\ntargets:\n"
        + "".join(
            f"  {name}:\n    settings:\n      base:\n        STEAMGUARD_APP_GROUP: {json.dumps(group)}\n"
            f"    entitlements:\n      path: .system-entry/{entitlements}.entitlements\n"
            for name, entitlements in (("steamguard_iOS", "app"), ("SteamGuardWidgets", "widget"))
        )
    )
    overlay.chmod(0o600)
    return overlay


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-group", default=os.environ.get("STEAMGUARD_APP_GROUP", ""))
    parser.add_argument("--app-entitlements", type=Path, help="Optional main app entitlements to preserve (for example iCloud).")
    parser.add_argument("--generate", action="store_true", help="Also regenerate the Xcode project from the local overlay.")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1] / "src-tauri/gen/apple"
    try:
        overlay = configure(project, args.app_group, args.app_entitlements)
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        parser.error(str(error))
    if args.generate:
        subprocess.run(["xcodegen", "generate", "--spec", str(overlay)], check=True)
    print(f"Created local App Group configuration: {overlay}")
    print("Use signing profiles that authorize this App Group for both the app and widget extension.")


if __name__ == "__main__":
    main()
