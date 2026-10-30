# Rehearsal desktop review

The desktop must keep a readable, unclipped browser, toolbar and dock, with the
existing window placement and wallpaper. The full 1440×900 capture and enlarged
toolbar/dock crops were directly inspected and independently reviewed by a fresh
agent with no implementation history. Neither review found a confirmed defect.
The independent reviewer noted low-confidence softness in enlarged crops; it is
not visible at the actual desktop scale.

Against the approved desktop capture in `specs/done/vm-desktop/assets/`, the
grayscale mean absolute difference was 0.15123; 0.1405% of pixels differed and
0.11235% differed by more than 32. Differences occupy the clock/NTP indicator
region. Browser geometry, dock and wallpaper retain their intended presentation.
These metrics locate differences; the readable, unclipped desktop determines
acceptance.

This accepts only the local rehearsal capture. It does not certify the final
strict runtime image or a published digest.
