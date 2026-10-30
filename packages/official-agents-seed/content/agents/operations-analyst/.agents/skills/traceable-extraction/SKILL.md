---
name: traceable-extraction
description: Build an auditable field ledger and structured records from business documents. Use when extracting fields or tables, normalizing document values, assigning extraction confidence, or checking totals and cross-document consistency.
---

# Traceable Extraction

The field ledger is the source of the structured dataset, not a log added after extraction. A value enters `records.csv` only through an accepted ledger row.

## Workflow

1. Freeze the schema before opening the batch. Give every field a type, required status, normalization rule, and rule for what counts as direct evidence. Record the schema version.
2. Register every source before extracting it. Assign the stable document id, hash it, count its pages, and record whether it needs direct text extraction, OCR, or conversion.
3. Extract raw text and geometry with the matching shared skill. Keep page boundaries and table structure. Do not flatten a document into prose when row or column association carries meaning.
4. Create one ledger row per document and requested field. Record the raw text and trace locator before writing a normalized value.
5. Apply the confidence gate character by character and association by association. If any material part is ambiguous, set `review-required`, explain the ambiguity, and leave normalized value blank.
6. Derive `records.csv` only from `accepted` ledger rows. Missing, unreadable, and not-applicable fields remain explicit statuses rather than disappearing.
7. Run structural and arithmetic checks. Write discrepancies to the review queue without changing the extracted rows.
8. Sample accepted records against the source and verify every review-required locator. The handoff is done only when source counts, field-status counts, and delivered record counts reconcile.

## Evidence row

Each `fields.csv` row carries:

| Column | Rule |
| --- | --- |
| `document_id` | Stable id from `sources.csv` |
| `schema_version` | Version used for this extraction |
| `field` | Exact schema field name |
| `normalized_value` | Blank unless status is `accepted` |
| `raw_text` | Verbatim source text; never cleaned in place |
| `status` | `accepted`, `review-required`, `missing`, or `not-applicable` |
| `confidence` | Field-level `0.00–1.00`, not a page average |
| `locator` | Page plus bounding box/lines, or sheet plus cell range |
| `method` | Direct text, table extraction, OCR, form field, or conversion |
| `note` | Why review is required or normalization was lossless |

The locator must let another person reopen the document and find the value without repeating the extraction. A page number alone is insufficient when the page contains more than one candidate value.

## Confidence gate

Confidence covers both recognition and association. Perfectly recognized digits in the wrong row are still wrong.

Set `review-required` when any of these is true:

- a character, sign, separator, decimal place, currency, date component, or unit is unclear;
- merged cells, wrapped rows, page breaks, or missing rules make the field-to-value association uncertain;
- OCR alternatives differ on a material character;
- a handwritten, struck-through, overwritten, cropped, or smudged region supplies the value;
- the value is supported by arithmetic or repetition rather than legible source text;
- the trace locator cannot isolate the evidence.

Never use a document-level OCR score as field confidence. Never average a weak character into a strong field score. One material ambiguity gates the whole normalized field.

## Checks are observations

Recalculate with exact decimal arithmetic, but keep printed and calculated values in separate columns. A mismatch creates an exception containing the formula, operands, printed result, calculated result, delta, and traces for each operand.

Cross-document conflicts are also exceptions, not tie-breakers. If a purchase order, invoice, and packing list disagree, preserve each sourced value under its own document id. Do not select a winner unless a human corrects the source record and records that review.

## Completion test

Before handoff, all of these must be true:

- every registered document has a terminal extraction status;
- every requested field has a ledger row for every applicable document;
- every populated normalized value has raw text and a precise locator;
- no `review-required` row has a normalized value;
- `records.csv` contains no value absent from accepted ledger rows;
- exception counts and status counts match `checks.md`.

If any condition fails, the batch is not ready for downstream use.
