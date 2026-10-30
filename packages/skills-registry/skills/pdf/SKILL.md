---
name: pdf
target: both
description: Create, extract from, and modify PDF files. Generate PDFs with ReportLab (reports, forms, tables, charts), extract text/tables/images with pdfplumber (with pytesseract OCR fallback for scanned documents), and merge/split/rotate/watermark/fill PDFs with pypdf. Use when the user asks to create, generate, build, extract from, parse, OCR, merge, split, rotate, watermark, or fill a PDF.
---

# PDF

Create, extract from, or modify PDFs. Three workflows; pick one and load only the matching reference.

## Pick a workflow

| Goal                                         | Library     | Reference                                    |
| -------------------------------------------- | ----------- | -------------------------------------------- |
| Generate a PDF from scratch (reports, forms) | ReportLab   | `references/pdf-creation.md`                 |
| Read text/tables/fields from an existing PDF | pdfplumber  | `references/pdf-extraction.md`               |
| Merge, split, rotate, watermark, fill forms  | pypdf       | `references/pdf-modification.md`             |
| Extract from a scanned/image-only PDF        | pytesseract | `references/pdf-extraction.md` (OCR section) |

## When to load each reference

- **`references/pdf-creation.md`** — load when generating a new PDF. Covers `SimpleDocTemplate`, `Paragraph`, `Table`/`TableStyle`, charts, page breaks, page sizes.
- **`references/pdf-extraction.md`** — load when reading from an existing PDF. Covers `pdfplumber.open()`, table extraction, OCR fallback with `pdf2image` + `pytesseract`, password-protected and form PDFs.
- **`references/pdf-modification.md`** — load when altering an existing PDF. Covers `PdfReader`/`PdfWriter`, merging, splitting, rotation, watermarking, and form filling.

Do not load all three. Pick the one matching the request.

## Defaults

- **Creating:** ReportLab `SimpleDocTemplate`, A4 page size, default margins. Use `getSampleStyleSheet()` rather than crafting styles from scratch unless asked.
- **Extracting:** `pdfplumber` first. Only fall back to OCR if `extract_text()` returns empty or near-empty text on multiple pages — that's the signal the PDF is scanned.
- **Modifying:** `pypdf` for everything except form filling on PDFs with complex AcroForm widgets, where the references show a fallback approach.

## Gotchas

- `pdfplumber.extract_text()` returning `None` or an empty string is normal for scanned PDFs. Don't assume the file is corrupt — try OCR before reporting failure.
- Merging PDFs with mismatched page sizes is allowed but the output will not be uniform. Mention this in your output if the user expects a single consistent layout.
- pypdf form field names are case-sensitive and must match exactly. Print the existing field names with `reader.get_fields()` before writing values, or the write silently no-ops.
- Password-protected PDFs need `reader.decrypt(password)` before any read or write operation.

## Minimal example — extract text

```python
import pdfplumber

with pdfplumber.open("input.pdf") as pdf:
    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
```

If `text` is empty across all pages, fall back to OCR — see `references/pdf-extraction.md`.

## Dependencies

```bash
pip install reportlab pypdf pdfplumber
# Optional, for OCR on scanned PDFs:
pip install pytesseract pdf2image pillow
```

System binaries (`tesseract-ocr`, `poppler-utils`, `qpdf`, `ghostscript`) are pre-installed.

## Verify before reporting done

1. Output file exists and opens without errors (`pdfplumber.open(path)` round-trip).
2. Page count matches expectation.
3. For form filling, re-open and confirm field values were written.
4. For extraction, sanity-check the first and last extracted page — empty text on either is a red flag.
