# Shell candidate evidence

The controlled shell was captured from `/playground/drive-shell` at 1440×900
and 390×844 after exercising Arrow keys, Home, End, and pointer selection.

| Viewport | Candidate                                            | SHA-256                                                            |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| desktop  | [`drive-shell-desktop.png`](drive-shell-desktop.png) | `8d02c900590469a2f1ee556fe7d08fcfe6adeed77598bb4a9279e2e590da0f7c` |
| mobile   | [`drive-shell-mobile.png`](drive-shell-mobile.png)   | `8997e24b21e90af8d2cd7149079c8ea3ec2621f9c50726c8c010852cec380c6c` |

These are local Chromium review captures, not blessed Docker baselines. The
required Docker command was attempted, but the local daemon did not answer
even `docker info`; the gate remains a closeout retry rather than being marked
green.

The only committed source screenshots named `drive-v2-overview` were compared
at matched crop dimensions. Desktop distance was `0.07727` and mobile distance
was `0.09521`, but independent review proved the pixels are different
components: the source images show the dormant Overview campaign surface, not
the mounted Drive V2 top bar. They are therefore negative scope evidence, not
parity targets.

Unprimed critique confirmed that the tab group is geometrically centered and
the captures have no clipping, overflow, blur, or rendering artifacts. The
first mobile candidate used 36px controls; this was corrected to the
reference's 44px mobile tab height. Icon-only mobile labels, the neutral
selected card, and a stronger focus ring intentionally follow the pinned
source contract; accessible names remain present. Discoverability and final
utility-control balance stay on slice 12's narrow-width review list.
