# Extension focus visual review

Date: 2026-08-13

## Target

The 1440x900 desktop frame should show the exact requested Chrome window restored
and unambiguously foreground, with its unique oracle title readable. Existing
desktop framing should remain coherent; this probe does not judge page design.

## Comparison

Compared with the prior VM Desktop agent-browser capture at the same 1440x900
frame. The fixed-pair distance was `0.63946` (`mae 147.72662`, `rmse 175.39915`,
`edgeEnergyRatio 0.34399`). Those high distances are diagnostic: the page content,
wallpaper generation, and prior evidence overlay intentionally differ. Both retain
the full desktop frame and a single correctly bounded Chrome window. The candidate
is less wrong for this gate because it carries the unique focus title and has no
overlay obscuring the native-window evidence.

## Fresh critique

An unprimed reviewer found no high-confidence defect: Chrome is clearly restored
and foreground, the full title is readable, and there is no overlap, blur, or
artifact. Medium confidence: the active tab truncates the token, but the native
title bar and address bar both retain it. Low confidence: the raw data URL is dense
and the zoom crop alone cannot prove the full bounds. Those are evidence-presentation
limits, not focus failures; the full frame and independent X11 transcript answer
both questions.

## Verdict

Accepted for Gate B. The exact intended Chrome window is visibly foreground and
the current desktop composition is coherent at 1440x900.
