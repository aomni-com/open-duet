---
name: file-conversion
target: both
description: Convert files between formats — images (JPG/PNG/WEBP/HEIC/SVG via Pillow, pillow-heif, cairosvg), video (clip extraction and video-to-GIF via moviepy/ffmpeg), and documents (DOCX/PPTX ↔ Markdown ↔ PDF via pypandoc, python-docx, python-pptx, libreoffice, markitdown). Use when the user asks to convert, transform, resize, rasterize, re-encode, or change the format of an image, video clip, or document file.
---

# File Conversion

Convert image, video, and document files between formats. Pick the library based on the conversion type, then load the matching reference for code patterns.

## Pick the right tool

| Need                              | Use                  | Reference                           |
| --------------------------------- | -------------------- | ----------------------------------- |
| JPG ↔ PNG ↔ WEBP                  | Pillow               | `references/image-conversion.md`    |
| HEIC → anything                   | pillow-heif + Pillow | `references/image-conversion.md`    |
| SVG → raster                      | cairosvg             | `references/image-conversion.md`    |
| Video → GIF, clip extraction      | moviepy              | `references/video-to-gif.md`        |
| DOCX/PPTX/Markdown/PDF interconv. | pypandoc + helpers   | `references/document-conversion.md` |

For raster → SVG: not supported. SVG can only be rasterized, not generated from a bitmap.

## When to load each reference

- **`references/image-conversion.md`** — load when converting any image. Includes the RGBA→RGB JPEG handling, HEIC registration, and SVG rasterization patterns.
- **`references/video-to-gif.md`** — load when extracting a clip from a video, generating a GIF, or optimizing a GIF for web (size targets, FPS, dimensions).
- **`references/document-conversion.md`** — load when touching DOCX, PPTX, Markdown, or PDF as a document (not as a generated artifact — for PDF generation/extraction use the `pdf` skill).

Do not load all three at once. Load only the one that matches the conversion direction.

## Defaults

- Images: write JPEG with `quality=95, optimize=True`. Convert RGBA → RGB before writing JPEG.
- GIFs: target ≤ 10 MB. Start at width 480, FPS 12. Drop FPS first if over budget, then width.
- Documents: prefer `pypandoc` for DOCX ↔ Markdown ↔ PDF. Use `python-pptx` for PPTX-specific work.

## Minimal example — image format conversion

```python
from PIL import Image

img = Image.open("input.png")
if img.mode == "RGBA":
    img = img.convert("RGB")
img.save("output.jpg", quality=95, optimize=True)
```

For HEIC, register `pillow-heif` first; for SVG input, use `cairosvg` to rasterize. See `references/image-conversion.md`.

## Dependencies

System packages are pre-installed (ffmpeg, libvips-tools, pandoc, poppler-utils). Python packages are installed on demand:

```bash
pip install Pillow pillow-heif cairosvg moviepy python-docx python-pptx pypandoc
```

If a conversion requires LaTeX (some pypandoc PDF paths), prefer the libreoffice route instead — LaTeX is not installed by default.

## Verify before reporting done

After every conversion, confirm:

1. The output file exists and is non-empty.
2. The output dimensions / page count / duration match what was asked.
3. For lossy formats, the result is visually acceptable — not just byte-valid.
