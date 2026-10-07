"""Build the architecture diagram, both themes.

    python3 scripts/build-diagram.py

Drawn like wrangler/playwright-stagehand's, so the sibling examples read the
same. User and Web page are the two Octicons in the picture, in ink and
outside the boundary, bracketing the flow at either end. Cloudflare services
take their product icons in brand orange inside it.

Workers AI is an off-path card: the Worker consults it to pick each tool
call, rather than passing traffic through it, so the generator draws it at
BRANCH_SCALE of the row height. Its connector is bidirectional because each
step is a round trip: the Worker sends the conversation and the last tool
result, and the model answers with the next tool call.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.home() / ".agents/skills/cloudflare-diagrams/assets"))

from cfdiagram import Diagram, Flow, Node  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "src/assets"


def build(theme):
    nodes = [
        Node("user", "person", "User", inside=False, external=True),
        Node("worker", "workers", "Workers", "ai-sdk-example"),
        Node("browser", "browser-run", "Browser Run"),
        Node("page", "globe", "Web page", inside=False, external=True),
    ]
    flows = [
        Flow(0, 1, "GET /"),
        Flow(1, 2, "drives Playwright", "over CDP"),
        Flow(2, 3, "navigates", ["snapshot, click,", "type"]),
    ]
    d = Diagram(nodes, flows, theme,
                branch=(1, Node("ai", "workers-ai", "Workers AI"), "picks each tool call", True))
    d.render()
    return d


for theme in ("light", "dark"):
    d = build(theme)
    path = OUT / f"arch-diagram{'' if theme == 'light' else '-dark'}.svg"
    path.write_text(d.finish())
    print(f"  {path.name}: {d.W:.0f}x{d.H:.0f} aspect {d.W / d.H:.2f}")
