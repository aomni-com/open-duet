# PDF Modification

Detailed patterns for modifying existing PDFs.

## Merging PDFs

### Basic Merge

```python
from pypdf import PdfWriter

def merge_pdfs(pdf_list, output_path):
    """Merge multiple PDFs into one."""
    writer = PdfWriter()

    for pdf_path in pdf_list:
        writer.append(pdf_path)

    writer.write(output_path)
    writer.close()
    print(f"Merged {len(pdf_list)} files into {output_path}")

# Usage
merge_pdfs(["doc1.pdf", "doc2.pdf", "doc3.pdf"], "merged.pdf")
```

### Merge Specific Pages

```python
from pypdf import PdfWriter, PdfReader

def merge_selected_pages(sources, output_path):
    """Merge specific pages from multiple PDFs.

    sources: list of (pdf_path, page_range) tuples
             page_range is (start, end) or None for all pages
    """
    writer = PdfWriter()

    for pdf_path, page_range in sources:
        reader = PdfReader(pdf_path)

        if page_range is None:
            # All pages
            for page in reader.pages:
                writer.add_page(page)
        else:
            start, end = page_range
            for page in reader.pages[start:end]:
                writer.add_page(page)

    writer.write(output_path)
    writer.close()

# Usage: First 5 pages from doc1, pages 10-15 from doc2
sources = [
    ("doc1.pdf", (0, 5)),
    ("doc2.pdf", (9, 15)),
]
merge_selected_pages(sources, "combined.pdf")
```

## Splitting PDFs

### Split into Individual Pages

```python
from pypdf import PdfReader, PdfWriter
from pathlib import Path

def split_to_pages(pdf_path, output_dir):
    """Split PDF into individual page files."""
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    reader = PdfReader(pdf_path)

    for i, page in enumerate(reader.pages, start=1):
        writer = PdfWriter()
        writer.add_page(page)

        page_file = output_path / f"page_{i:03d}.pdf"
        writer.write(page_file)
        writer.close()

    print(f"Split into {len(reader.pages)} files in {output_dir}")
```

### Split by Page Ranges

```python
from pypdf import PdfReader, PdfWriter

def split_by_ranges(pdf_path, ranges, output_dir):
    """Split PDF into multiple files by page ranges.

    ranges: list of (start, end, filename) tuples (1-indexed)
    """
    from pathlib import Path
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    reader = PdfReader(pdf_path)

    for start, end, filename in ranges:
        writer = PdfWriter()
        # Convert to 0-indexed
        for page in reader.pages[start-1:end]:
            writer.add_page(page)

        output_file = output_path / filename
        writer.write(output_file)
        writer.close()
        print(f"Created: {output_file}")

# Usage
ranges = [
    (1, 5, "intro.pdf"),
    (6, 20, "chapter1.pdf"),
    (21, 35, "chapter2.pdf"),
]
split_by_ranges("book.pdf", ranges, "chapters/")
```

### Extract Specific Pages

```python
from pypdf import PdfReader, PdfWriter

def extract_pages(pdf_path, page_numbers, output_path):
    """Extract specific pages (1-indexed) to new PDF."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page_num in page_numbers:
        if 1 <= page_num <= len(reader.pages):
            writer.add_page(reader.pages[page_num - 1])
        else:
            print(f"Warning: Page {page_num} out of range")

    writer.write(output_path)
    writer.close()

# Extract pages 1, 3, 5, and 10
extract_pages("document.pdf", [1, 3, 5, 10], "selected.pdf")
```

## Rotating Pages

### Rotate All Pages

```python
from pypdf import PdfReader, PdfWriter

def rotate_all_pages(pdf_path, rotation, output_path):
    """Rotate all pages. rotation: 90, 180, or 270 degrees clockwise."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        page.rotate(rotation)
        writer.add_page(page)

    writer.write(output_path)
    writer.close()
```

### Rotate Specific Pages

```python
def rotate_pages(pdf_path, rotations, output_path):
    """Rotate specific pages.

    rotations: dict of {page_number: degrees} (1-indexed)
    """
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for i, page in enumerate(reader.pages):
        page_num = i + 1
        if page_num in rotations:
            page.rotate(rotations[page_num])
        writer.add_page(page)

    writer.write(output_path)
    writer.close()

# Rotate page 2 by 90 degrees, page 5 by 180 degrees
rotate_pages("doc.pdf", {2: 90, 5: 180}, "rotated.pdf")
```

## Watermarks and Overlays

### Text Watermark

```python
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from io import BytesIO

def create_watermark(text, opacity=0.3):
    """Create a watermark PDF page."""
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)

    c.saveState()
    c.setFillAlpha(opacity)
    c.setFont("Helvetica", 60)
    c.translate(300, 400)
    c.rotate(45)
    c.drawCentredString(0, 0, text)
    c.restoreState()

    c.save()
    buffer.seek(0)
    return buffer

def add_watermark(pdf_path, watermark_text, output_path):
    """Add text watermark to all pages."""
    watermark_buffer = create_watermark(watermark_text)
    watermark_pdf = PdfReader(watermark_buffer)
    watermark_page = watermark_pdf.pages[0]

    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        page.merge_page(watermark_page)
        writer.add_page(page)

    writer.write(output_path)
    writer.close()

# Usage
add_watermark("document.pdf", "CONFIDENTIAL", "watermarked.pdf")
```

### Image Watermark

```python
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from io import BytesIO

def create_image_watermark(image_path, x, y, width, height, opacity=0.3):
    """Create watermark with image."""
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)

    c.saveState()
    c.setFillAlpha(opacity)
    c.drawImage(image_path, x, y, width, height, mask='auto')
    c.restoreState()

    c.save()
    buffer.seek(0)
    return buffer

def add_image_watermark(pdf_path, image_path, output_path):
    """Add image watermark to all pages."""
    watermark_buffer = create_image_watermark(image_path, 400, 600, 150, 150)
    watermark_pdf = PdfReader(watermark_buffer)
    watermark_page = watermark_pdf.pages[0]

    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        page.merge_page(watermark_page)
        writer.add_page(page)

    writer.write(output_path)
    writer.close()
```

### Page Numbers

```python
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from io import BytesIO

def add_page_numbers(pdf_path, output_path, position='bottom-center'):
    """Add page numbers to PDF."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()
    total_pages = len(reader.pages)

    for i, page in enumerate(reader.pages):
        page_num = i + 1

        # Create page number overlay
        buffer = BytesIO()
        c = canvas.Canvas(buffer, pagesize=letter)
        c.setFont("Helvetica", 10)

        if position == 'bottom-center':
            c.drawCentredString(306, 30, f"Page {page_num} of {total_pages}")
        elif position == 'bottom-right':
            c.drawRightString(570, 30, f"{page_num}")

        c.save()
        buffer.seek(0)

        # Merge overlay
        overlay = PdfReader(buffer)
        page.merge_page(overlay.pages[0])
        writer.add_page(page)

    writer.write(output_path)
    writer.close()
```

## Form Filling

### Fill Text Fields

```python
from pypdf import PdfReader, PdfWriter

def fill_form(pdf_path, field_values, output_path):
    """Fill form fields in a PDF.

    field_values: dict of {field_name: value}
    """
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    # Clone pages
    for page in reader.pages:
        writer.add_page(page)

    # Fill fields
    writer.update_page_form_field_values(
        writer.pages[0],  # Usually form is on first page
        field_values
    )

    writer.write(output_path)
    writer.close()

# Usage
field_values = {
    "name": "John Doe",
    "email": "john@example.com",
    "date": "2024-01-15",
}
fill_form("form.pdf", field_values, "filled_form.pdf")
```

### Fill Different Field Types

```python
def fill_form_all_types(pdf_path, field_values, output_path):
    """Fill various field types.

    field_values format:
    - Text fields: {"field_name": "text value"}
    - Checkboxes: {"field_name": "/Yes" or "/Off"}
    - Radio buttons: {"field_name": "/OptionValue"}
    """
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    # Update all pages with form fields
    for page in writer.pages:
        writer.update_page_form_field_values(page, field_values)

    writer.write(output_path)
    writer.close()

# Example with different field types
field_values = {
    "full_name": "Jane Smith",
    "agree_terms": "/Yes",        # Checkbox
    "payment_method": "/CreditCard",  # Radio button
}
fill_form_all_types("application.pdf", field_values, "completed.pdf")
```

### Flatten Form (Make Non-Editable)

```python
from pypdf import PdfReader, PdfWriter

def flatten_form(pdf_path, output_path):
    """Flatten form fields to make them non-editable."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    # Flatten all form fields
    for page in writer.pages:
        for annot in page.get("/Annots", []):
            annot_obj = annot.get_object()
            if annot_obj.get("/Subtype") == "/Widget":
                annot_obj.update({"/Ff": 1})  # Read-only flag

    writer.write(output_path)
    writer.close()
```

## Adding Content

### Insert Blank Page

```python
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter

def insert_blank_page(pdf_path, position, output_path):
    """Insert blank page at position (1-indexed)."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for i, page in enumerate(reader.pages):
        if i + 1 == position:
            writer.add_blank_page(width=letter[0], height=letter[1])
        writer.add_page(page)

    # If position is after last page
    if position > len(reader.pages):
        writer.add_blank_page(width=letter[0], height=letter[1])

    writer.write(output_path)
    writer.close()
```

### Insert PDF Pages

```python
from pypdf import PdfReader, PdfWriter

def insert_pages(base_pdf, insert_pdf, position, output_path):
    """Insert pages from another PDF at position (1-indexed)."""
    base_reader = PdfReader(base_pdf)
    insert_reader = PdfReader(insert_pdf)
    writer = PdfWriter()

    for i, page in enumerate(base_reader.pages):
        if i + 1 == position:
            for insert_page in insert_reader.pages:
                writer.add_page(insert_page)
        writer.add_page(page)

    writer.write(output_path)
    writer.close()

# Insert cover.pdf at the beginning of document.pdf
insert_pages("document.pdf", "cover.pdf", 1, "with_cover.pdf")
```

## Page Deletion

### Remove Pages

```python
from pypdf import PdfReader, PdfWriter

def remove_pages(pdf_path, pages_to_remove, output_path):
    """Remove specific pages (1-indexed)."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    pages_to_remove_set = set(pages_to_remove)

    for i, page in enumerate(reader.pages):
        if i + 1 not in pages_to_remove_set:
            writer.add_page(page)

    writer.write(output_path)
    writer.close()

# Remove pages 2, 4, and 6
remove_pages("document.pdf", [2, 4, 6], "trimmed.pdf")
```

## Password Protection

### Add Password

```python
from pypdf import PdfReader, PdfWriter

def encrypt_pdf(pdf_path, output_path, user_password, owner_password=None):
    """Add password protection to PDF."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    # If no owner password, use user password
    if owner_password is None:
        owner_password = user_password

    writer.encrypt(
        user_password=user_password,    # Required to open
        owner_password=owner_password,  # Required to edit
    )

    writer.write(output_path)
    writer.close()

encrypt_pdf("document.pdf", "protected.pdf", "userpass123", "ownerpass456")
```

### Remove Password

```python
from pypdf import PdfReader, PdfWriter

def decrypt_pdf(pdf_path, password, output_path):
    """Remove password from PDF."""
    reader = PdfReader(pdf_path)

    if reader.is_encrypted:
        reader.decrypt(password)

    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    writer.write(output_path)
    writer.close()

decrypt_pdf("protected.pdf", "password123", "unprotected.pdf")
```

## Complete Modification Example

```python
from pypdf import PdfReader, PdfWriter
from pathlib import Path

def batch_process_pdfs(input_dir, output_dir, operations):
    """Process multiple PDFs with specified operations.

    operations: dict with keys like 'rotate', 'watermark', 'password'
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    for pdf_file in input_path.glob("*.pdf"):
        print(f"Processing: {pdf_file.name}")

        reader = PdfReader(pdf_file)
        writer = PdfWriter()

        for page in reader.pages:
            # Apply rotation
            if 'rotate' in operations:
                page.rotate(operations['rotate'])

            writer.add_page(page)

        # Apply password
        if 'password' in operations:
            writer.encrypt(operations['password'])

        # Save
        output_file = output_path / pdf_file.name
        writer.write(output_file)
        writer.close()
        print(f"Saved: {output_file}")

# Usage
operations = {
    'rotate': 0,  # No rotation
    'password': 'secure123',
}
batch_process_pdfs("input_pdfs/", "output_pdfs/", operations)
```
