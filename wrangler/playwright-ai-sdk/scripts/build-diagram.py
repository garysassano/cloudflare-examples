"""Build the architecture diagram, both themes.

    python3 scripts/build-diagram.py

Laid out like wrangler/playwright-stagehand's. User and Web page are the two Octicons in the picture, outside the boundary
at either end of the top row. Workers AI sits below the Worker, inside the
boundary: the Worker consults it on every step rather than passing traffic
through it. That connector is bidirectional because each step is a round
trip: the Worker sends the conversation and the last tool result, and the
model answers with the next tool call.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.home() / ".agents/skills/cloudflare-diagrams/assets"))

from cfdiagram import render_model  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "src/assets"

MODEL = {
    "title": "Workers AI browser agent on Browser Run",
    "description": (
        "A Worker runs an agent loop on Workers AI: the model picks each browser tool call, "
        "and the Worker performs it with Playwright on a Browser Run session."
    ),
    "nodes": [
        {"key": "user", "icon": "person", "title": "User", "inside": False, "external": True,
         "position": [0, 0]},
        {"key": "worker", "icon": "workers", "title": "Workers", "sub": "ai-sdk-example",
         "position": [1, 0]},
        {"key": "browser", "icon": "browser-run", "title": "Browser Run", "sub": "Headless Chrome",
         "position": [2, 0]},
        {"key": "page", "icon": "globe", "title": "Web page", "inside": False, "external": True,
         "position": [3, 0]},
        {"key": "ai", "icon": "workers-ai", "title": "Workers AI", "sub": "nemotron-3-120b-a12b",
         "position": [1, 1]},
    ],
    "flows": [
        {"from": "user", "to": "worker", "label": "GET /"},
        {"from": "worker", "to": "browser", "label": "Playwright", "sub": "over CDP"},
        {"from": "browser", "to": "page", "label": "navigates", "sub": ["snapshot, click,", "type"]},
        {"from": "worker", "to": "ai", "label": "picks each", "sub": "tool call", "arrow": "both"},
    ],
}

for theme in ("light", "dark"):
    path = OUT / f"arch-diagram{'' if theme == 'light' else '-dark'}.svg"
    path.write_text(render_model(MODEL, theme))
    print(f"  {path.name}")
