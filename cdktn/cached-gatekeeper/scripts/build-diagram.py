"""Build the architecture diagram, both themes.

Geometry, palette and type come from the shared cfdiagram generator, so this
repo's diagram matches the rest of the Cloudflare set. Only the content of the
diagram lives here.

    python3 scripts/build-diagram.py

What the picture claims, and why:

* One `WorkersScript`, `cached-gatekeeper`, is deployed. `Gatekeeper` and
  `Upstream` are its two `exports`, not two Workers, which is what the
  `export:` sub-lines and the boundary note say. Titling both cards `Workers`
  would claim two.
* Workers Cache is `cache: { enabled: true }` on the `Upstream` export, not a
  separate resource. It is drawn dashed because it is configuration on the hop
  rather than a thing that gets created.
* The caller is deliberately not a card. Over RPC it must be a Worker; over the
  explorer it is a browser. Any icon would claim one of those, so the call
  arrives as a labelled arrow instead and claims neither.
"""

import pathlib
import sys

SKILL = pathlib.Path.home() / ".agents/skills/cloudflare-diagrams/assets"
sys.path.insert(0, str(SKILL))

from cfdiagram import ANNOT_PX, LABEL_PX, Diagram, Flow, Node  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "src/assets"
GK, CACHE, UP = 0, 1, 2


def nodes():
    return [
        Node("gk", "workers", "Gatekeeper", "export: default",
             badge="cache: off", badge_kind="ink"),
        Node("cache", "cache", "Workers Cache", dashed=True),
        Node("up", "workers", "Upstream", "export: Upstream",
             badge="cache: on", badge_kind="ok"),
        Node("gh", "github", "GitHub API", inside=False, external=True),
    ]


FLOWS = [
    Flow(GK, CACHE, "loopback", "props: digest"),
    Flow(CACHE, UP, "MISS only", "1 of 25"),
    Flow(UP, 3, "fetch", "+ token"),
]



def build(theme):
    d = Diagram(nodes(), FLOWS, theme, boundary_note="cached-gatekeeper",
                band_top=34, band_bot=32, per_row=4)
    d.render()
    T = d.T
    gk, ca, up = d.cx[GK], d.cx[CACHE], d.cx[UP]
    top, bot = d.ny, d.ny + d.nh

    # A hit returns from the cache without Upstream ever executing.
    d.parts.append(
        f'<path d="M{ca:.1f} {top:.1f} L{ca:.1f} {top - 20:.1f} L{gk:.1f} {top - 20:.1f} '
        f'L{gk:.1f} {top - 11.2:.1f}" fill="none" stroke="{T["OK"]}" stroke-width="1.6" '
        f'stroke-dasharray="6 4" marker-end="url(#ok-{d.uid})"/>')
    d.parts.append(d.text((gk + ca) / 2, top - 27,
                          "HIT: Upstream never runs, the token is never touched",
                          ANNOT_PX, T["OK"], "600"))

    # A write purges by tag from inside Upstream, over RPC so it is never cached.
    d.parts.append(
        f'<path d="M{up:.1f} {bot:.1f} L{up:.1f} {bot + 18:.1f} L{ca:.1f} {bot + 18:.1f} '
        f'L{ca:.1f} {bot + 9.8:.1f}" fill="none" stroke="{T["INK"]}" stroke-width="1.4" '
        f'stroke-dasharray="4 4" marker-end="url(#ar-{d.uid})"/>')
    d.parts.append(d.text((ca + up) / 2, bot + 32,
                          "purge by tag, from inside Upstream", ANNOT_PX, T["MUTE"]))

    # Both ways in: the service binding it is designed for, and the explorer.
    d.entry(GK, "RPC", "listIssues(…)", dy=-24)
    d.entry(GK, "HTTP", "GET /v1/repos/…", dy=24)
    return d


for theme in ("light", "dark"):
    d = build(theme)
    path = OUT / f"arch-diagram{'' if theme == 'light' else '-dark'}.svg"
    path.write_text(d.finish())
    print(f"  {path.name}: {d.W:.0f}x{d.H:.0f} aspect {d.W / d.H:.2f} "
          f"label {LABEL_PX * 830 / d.W:.1f}px at README width")
