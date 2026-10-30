# PDF Extraction

Detailed patterns for reading content from PDFs.

## Text Extraction

### Basic Text Extraction

```python
import pdfplumber

def extract_all_text(pdf_path):
    """Extract text from all pages."""
    text_content = []

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                text_content.append(text)

    return "\n\n".join(text_content)
```

### Page-by-Page Extraction

```python
def extract_text_by_page(pdf_path):
    """Extract text with page tracking."""
    pages = {}

    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = page.extract_text()
            pages[i] = text if text else "[No extractable text]"

    return pages
```

### Extraction with Coordinates

```python
def extract_text_from_region(pdf_path, bbox):
    """Extract text from specific region (x0, y0, x1, y1)."""
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        cropped = page.crop(bbox)
        return cropped.extract_text()

# Example: Extract from top-left quadrant
text = extract_text_from_region("doc.pdf", (0, 0, 306, 396))
```

## Table Extraction

### Basic Table Extraction

```python
def extract_tables(pdf_path):
    """Extract all tables from PDF."""
    all_tables = []

    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            for table in tables:
                all_tables.append({
                    'page': page_num,
                    'data': table
                })

    return all_tables
```

### Table to DataFrame

```python
import pandas as pd
import pdfplumber

def tables_to_dataframes(pdf_path):
    """Convert PDF tables to pandas DataFrames."""
    dataframes = []

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if table and len(table) > 1:
                    # First row as headers
                    df = pd.DataFrame(table[1:], columns=table[0])
                    dataframes.append(df)

    return dataframes
```

### Table Extraction Settings

```python
def extract_tables_custom(pdf_path):
    """Extract tables with custom settings for better accuracy."""
    table_settings = {
        "vertical_strategy": "lines",    # or "text", "explicit"
        "horizontal_strategy": "lines",  # or "text", "explicit"
        "snap_tolerance": 3,
        "join_tolerance": 3,
        "edge_min_length": 3,
        "min_words_vertical": 3,
        "min_words_horizontal": 1,
    }

    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        tables = page.extract_tables(table_settings)
        return tables
```

### Export Tables to CSV

```python
import csv

def export_tables_to_csv(pdf_path, output_dir):
    """Export each table to a separate CSV file."""
    from pathlib import Path

    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    with pdfplumber.open(pdf_path) as pdf:
        table_count = 0
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            for table in tables:
                if table:
                    table_count += 1
                    csv_path = output_path / f"table_p{page_num}_{table_count}.csv"
                    with open(csv_path, 'w', newline='') as f:
                        writer = csv.writer(f)
                        writer.writerows(table)
                    print(f"Saved: {csv_path}")
```

## Image Extraction

### Extract Images with pdfplumber

```python
def extract_images(pdf_path, output_dir):
    """Extract images from PDF."""
    from pathlib import Path

    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            for img_num, img in enumerate(page.images, start=1):
                # Get image data
                x0, y0, x1, y1 = img['x0'], img['top'], img['x1'], img['bottom']
                cropped = page.crop((x0, y0, x1, y1))
                img_obj = cropped.to_image()

                # Save image
                img_path = output_path / f"page{page_num}_img{img_num}.png"
                img_obj.save(img_path)
                print(f"Saved: {img_path}")
```

### Extract Images with pypdf

```python
from pypdf import PdfReader

def extract_images_pypdf(pdf_path, output_dir):
    """Extract embedded images using pypdf."""
    from pathlib import Path

    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    reader = PdfReader(pdf_path)

    for page_num, page in enumerate(reader.pages, start=1):
        if '/XObject' in page['/Resources']:
            xobjects = page['/Resources']['/XObject'].get_object()
            for obj_name in xobjects:
                obj = xobjects[obj_name]
                if obj['/Subtype'] == '/Image':
                    # Determine format
                    if '/Filter' in obj:
                        if obj['/Filter'] == '/DCTDecode':
                            ext = 'jpg'
                        elif obj['/Filter'] == '/FlateDecode':
                            ext = 'png'
                        else:
                            ext = 'bin'
                    else:
                        ext = 'bin'

                    # Save image
                    img_path = output_path / f"page{page_num}_{obj_name[1:]}.{ext}"
                    with open(img_path, 'wb') as f:
                        f.write(obj._data)
                    print(f"Saved: {img_path}")
```

## Metadata Extraction

### Document Metadata

```python
from pypdf import PdfReader

def extract_metadata(pdf_path):
    """Extract PDF metadata."""
    reader = PdfReader(pdf_path)

    metadata = {
        'num_pages': len(reader.pages),
        'info': {}
    }

    if reader.metadata:
        metadata['info'] = {
            'title': reader.metadata.get('/Title', ''),
            'author': reader.metadata.get('/Author', ''),
            'subject': reader.metadata.get('/Subject', ''),
            'creator': reader.metadata.get('/Creator', ''),
            'producer': reader.metadata.get('/Producer', ''),
            'creation_date': reader.metadata.get('/CreationDate', ''),
            'modification_date': reader.metadata.get('/ModDate', ''),
        }

    return metadata
```

### Page-Level Information

```python
def get_page_info(pdf_path):
    """Get information about each page."""
    with pdfplumber.open(pdf_path) as pdf:
        pages_info = []
        for i, page in enumerate(pdf.pages, start=1):
            info = {
                'page_number': i,
                'width': page.width,
                'height': page.height,
                'has_images': len(page.images) > 0,
                'image_count': len(page.images),
                'has_tables': len(page.extract_tables()) > 0,
            }
            pages_info.append(info)
    return pages_info
```

## OCR for Scanned Documents

### Basic OCR

```python
import pytesseract
from pdf2image import convert_from_path

def ocr_pdf(pdf_path):
    """Extract text from scanned PDF using OCR."""
    # Convert PDF pages to images
    images = convert_from_path(pdf_path)

    text_content = []
    for i, image in enumerate(images, start=1):
        text = pytesseract.image_to_string(image)
        text_content.append(f"--- Page {i} ---\n{text}")

    return "\n\n".join(text_content)
```

### OCR with Preprocessing

```python
import pytesseract
from pdf2image import convert_from_path
from PIL import Image, ImageEnhance, ImageFilter

def ocr_pdf_enhanced(pdf_path):
    """OCR with image preprocessing for better accuracy."""
    images = convert_from_path(pdf_path, dpi=300)  # Higher DPI

    text_content = []
    for i, image in enumerate(images, start=1):
        # Preprocessing
        image = image.convert('L')  # Grayscale
        enhancer = ImageEnhance.Contrast(image)
        image = enhancer.enhance(2)  # Increase contrast
        image = image.filter(ImageFilter.SHARPEN)

        # OCR
        text = pytesseract.image_to_string(image, config='--psm 1')
        text_content.append(text)

    return "\n\n".join(text_content)
```

### Detect if OCR is Needed

```python
def needs_ocr(pdf_path):
    """Check if PDF needs OCR (is scanned/image-based)."""
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages[:3]:  # Check first 3 pages
            text = page.extract_text()
            if text and len(text.strip()) > 50:
                return False  # Has extractable text
    return True  # Likely needs OCR
```

## Form Field Extraction

### Read Form Fields

```python
from pypdf import PdfReader

def extract_form_fields(pdf_path):
    """Extract form field names and values."""
    reader = PdfReader(pdf_path)

    if '/AcroForm' not in reader.trailer['/Root']:
        return {}

    fields = {}
    if reader.get_fields():
        for field_name, field in reader.get_fields().items():
            fields[field_name] = {
                'value': field.get('/V', ''),
                'type': field.get('/FT', ''),
            }

    return fields
```

## Complete Extraction Example

```python
import pdfplumber
from pypdf import PdfReader
from pathlib import Path

def comprehensive_extract(pdf_path, output_dir):
    """Extract all content from a PDF."""
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    results = {
        'metadata': {},
        'text': [],
        'tables': [],
        'form_fields': {},
    }

    # Metadata
    reader = PdfReader(pdf_path)
    results['metadata'] = {
        'pages': len(reader.pages),
        'title': reader.metadata.get('/Title', '') if reader.metadata else '',
        'author': reader.metadata.get('/Author', '') if reader.metadata else '',
    }

    # Text and tables
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            # Text
            text = page.extract_text()
            if text:
                results['text'].append({
                    'page': page_num,
                    'content': text
                })

            # Tables
            tables = page.extract_tables()
            for table in tables:
                if table:
                    results['tables'].append({
                        'page': page_num,
                        'data': table
                    })

    # Form fields
    if reader.get_fields():
        results['form_fields'] = {
            name: str(field.get('/V', ''))
            for name, field in reader.get_fields().items()
        }

    # Save text to file
    text_file = output_path / "extracted_text.txt"
    with open(text_file, 'w') as f:
        for item in results['text']:
            f.write(f"=== Page {item['page']} ===\n")
            f.write(item['content'])
            f.write("\n\n")

    print(f"Extraction complete. Text saved to {text_file}")
    return results
```
