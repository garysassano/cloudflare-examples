"""Build the architecture diagram, both themes.

    python3 scripts/build-diagram.py

The Claude API and the web page are both outside Cloudflare, and the boundary
is a rectangle, so they take the two ends of one row: the Worker consults the
Claude API on its left and drives the browser toward the page on its right.
That leaves no free end for the caller: an entry arrow would cross the Claude
connector in the same gap, and a note above the Worker meets the boundary
lockup, so the README names the GET / trigger instead.

The Claude API is a round trip on every turn: the Worker sends the
conversation and each tool result, and Claude answers with the next browser
calls. Its connector is therefore bidirectional. Anthropic has no icon in the
pinned kits, so it takes the neutral globe Octicon used for external services.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.home() / ".agents/skills/cloudflare-diagrams/assets"))

from cfdiagram import render_model  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "src/assets"

MODEL = {
    "title": "Claude browser toolset on Browser Run",
    "description": (
        "A Worker runs Claude's browser toolset loop: Claude chooses each browser call, "
        "and the Worker performs it with Playwright on a Browser Run session."
    ),
    "nodes": [
        {"key": "claude", "icon": "globe", "title": "Claude API", "sub": "claude-opus-5-5",
         "inside": False, "external": True, "position": [0, 0]},
        {"key": "worker", "icon": "workers", "title": "Workers", "sub": "anthropic-sdk-example",
         "position": [1, 0]},
        {"key": "browser", "icon": "browser-run", "title": "Browser Run", "sub": "Headless Chrome",
         "position": [2, 0]},
        {"key": "page", "icon": "globe", "title": "Web page", "inside": False, "external": True,
         "position": [3, 0]},
    ],
    "flows": [
        {"from": "worker", "to": "claude", "label": "browser toolset", "sub": ["calls, results"],
         "arrow": "both"},
        {"from": "worker", "to": "browser", "label": "Playwright", "sub": "over CDP"},
        {"from": "browser", "to": "page", "label": "navigates", "sub": ["read_page, click,", "type"]},
    ],
}

for theme in ("light", "dark"):
    path = OUT / f"arch-diagram{'' if theme == 'light' else '-dark'}.svg"
    path.write_text(render_model(MODEL, theme))
    print(f"  {path.name}")
