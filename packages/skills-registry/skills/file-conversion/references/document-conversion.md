# Document Conversion

Detailed patterns for converting between document formats.

## Pypandoc Basics

### Simple Conversions

```python
import pypandoc

# DOCX to Markdown
pypandoc.convert_file("input.docx", "markdown", outputfile="output.md")

# Markdown to DOCX
pypandoc.convert_file("input.md", "docx", outputfile="output.docx")

# DOCX to PDF (requires LaTeX)
pypandoc.convert_file("input.docx", "pdf", outputfile="output.pdf")

# String conversion
md_content = pypandoc.convert_file("input.docx", "markdown")
```

### Format Options

```python
import pypandoc

# With extra arguments
pypandoc.convert_file(
    "input.docx",
    "markdown",
    outputfile="output.md",
    extra_args=['--wrap=none']  # Don't wrap lines
)

# Standalone HTML
pypandoc.convert_file(
    "input.md",
    "html",
    outputfile="output.html",
    extra_args=['--standalone']
)
```

## DOCX to Markdown

### Basic Conversion

```python
import pypandoc

def docx_to_markdown(docx_path, output_path=None):
    """Convert DOCX to Markdown."""
    if output_path:
        pypandoc.convert_file(docx_path, 'markdown', outputfile=output_path)
        return output_path
    else:
        return pypandoc.convert_file(docx_path, 'markdown')
```

### With Image Extraction

```python
import pypandoc
from pathlib import Path

def docx_to_markdown_with_images(docx_path, output_dir):
    """Convert DOCX to Markdown, extracting images."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    media_dir = output_dir / "media"
    media_dir.mkdir(exist_ok=True)

    md_path = output_dir / "document.md"

    pypandoc.convert_file(
        docx_path,
        'markdown',
        outputfile=str(md_path),
        extra_args=[
            f'--extract-media={media_dir}',
            '--wrap=none'
        ]
    )

    return md_path
```

### Preserve Formatting

```python
import pypandoc

def docx_to_gfm(docx_path, output_path):
    """Convert DOCX to GitHub-Flavored Markdown."""
    pypandoc.convert_file(
        docx_path,
        'gfm',  # GitHub-Flavored Markdown
        outputfile=output_path,
        extra_args=[
            '--wrap=none',
            '--atx-headers'  # Use # style headers
        ]
    )
```

## Markdown to DOCX

### Basic Conversion

```python
import pypandoc

def markdown_to_docx(md_path, output_path):
    """Convert Markdown to DOCX."""
    pypandoc.convert_file(md_path, 'docx', outputfile=output_path)
```

### With Reference Template

```python
import pypandoc

def markdown_to_docx_styled(md_path, output_path, template_path=None):
    """Convert Markdown to DOCX with optional style template."""
    extra_args = []

    if template_path:
        extra_args.append(f'--reference-doc={template_path}')

    pypandoc.convert_file(
        md_path,
        'docx',
        outputfile=output_path,
        extra_args=extra_args
    )
```

### From String

```python
import pypandoc

def markdown_string_to_docx(md_content, output_path):
    """Convert Markdown string to DOCX file."""
    pypandoc.convert_text(
        md_content,
        'docx',
        format='markdown',
        outputfile=output_path
    )
```

## PPTX to Markdown

### Using python-pptx

```python
from pptx import Presentation
from pathlib import Path

def pptx_to_markdown(pptx_path, output_path):
    """Convert PowerPoint to Markdown."""
    prs = Presentation(pptx_path)
    md_lines = []

    for slide_num, slide in enumerate(prs.slides, 1):
        md_lines.append(f"\n## Slide {slide_num}\n")

        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if text:
                        # Detect if it's a title (usually first text box)
                        if shape == slide.shapes[0]:
                            md_lines.append(f"### {text}\n")
                        else:
                            md_lines.append(f"- {text}")

        md_lines.append("")  # Empty line between slides

    output_path = Path(output_path)
    output_path.write_text("\n".join(md_lines))
    return output_path
```

### With Image Extraction

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pathlib import Path
import io

def pptx_to_markdown_full(pptx_path, output_dir):
    """Convert PPTX to Markdown with images."""
    prs = Presentation(pptx_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    images_dir = output_dir / "images"
    images_dir.mkdir(exist_ok=True)

    md_lines = []
    image_count = 0

    for slide_num, slide in enumerate(prs.slides, 1):
        md_lines.append(f"\n---\n\n## Slide {slide_num}\n")

        for shape in slide.shapes:
            # Handle text
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if text:
                        md_lines.append(f"{text}\n")

            # Handle images
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                image_count += 1
                image = shape.image
                image_ext = image.ext
                image_path = images_dir / f"slide{slide_num}_img{image_count}.{image_ext}"

                with open(image_path, 'wb') as f:
                    f.write(image.blob)

                rel_path = f"images/{image_path.name}"
                md_lines.append(f"\n![Image]({rel_path})\n")

    md_path = output_dir / "presentation.md"
    md_path.write_text("\n".join(md_lines))

    return md_path
```

## Markdown to PPTX

### Basic Slide Generation

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pathlib import Path
import re

def markdown_to_pptx(md_path, output_path):
    """Convert Markdown to PowerPoint."""
    md_content = Path(md_path).read_text()

    # Parse markdown into slides (split on ## headers)
    slides_content = re.split(r'\n##\s+', md_content)

    prs = Presentation()

    for i, slide_content in enumerate(slides_content):
        if not slide_content.strip():
            continue

        lines = slide_content.strip().split('\n')
        title = lines[0].lstrip('#').strip()
        body = '\n'.join(lines[1:]).strip()

        # Use title slide for first, bullet slides for rest
        if i == 0:
            slide_layout = prs.slide_layouts[0]  # Title slide
        else:
            slide_layout = prs.slide_layouts[1]  # Title and content

        slide = prs.slides.add_slide(slide_layout)

        # Set title
        if slide.shapes.title:
            slide.shapes.title.text = title

        # Set body content
        if body and len(slide.placeholders) > 1:
            body_shape = slide.placeholders[1]
            tf = body_shape.text_frame
            tf.text = body

    prs.save(output_path)
    return output_path
```

### With Bullet Points

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pathlib import Path
import re

def markdown_to_pptx_bullets(md_path, output_path):
    """Convert Markdown with bullets to PowerPoint."""
    md_content = Path(md_path).read_text()

    # Split into slides by ## headers
    slides_raw = re.split(r'\n(?=##\s)', md_content)

    prs = Presentation()

    for slide_text in slides_raw:
        if not slide_text.strip():
            continue

        lines = slide_text.strip().split('\n')

        # Extract title (first ## line)
        title = ""
        bullets = []

        for line in lines:
            if line.startswith('## '):
                title = line[3:].strip()
            elif line.startswith('- ') or line.startswith('* '):
                bullets.append(line[2:].strip())
            elif line.strip() and not line.startswith('#'):
                bullets.append(line.strip())

        # Create slide
        slide_layout = prs.slide_layouts[1]  # Title and content
        slide = prs.slides.add_slide(slide_layout)

        if slide.shapes.title:
            slide.shapes.title.text = title

        if bullets and len(slide.placeholders) > 1:
            body = slide.placeholders[1]
            tf = body.text_frame
            tf.text = bullets[0] if bullets else ""

            for bullet in bullets[1:]:
                p = tf.add_paragraph()
                p.text = bullet
                p.level = 0

    prs.save(output_path)
    return output_path
```

## Document to PDF

### DOCX to PDF

```python
import pypandoc

def docx_to_pdf(docx_path, output_path):
    """Convert DOCX to PDF (requires LaTeX)."""
    pypandoc.convert_file(
        docx_path,
        'pdf',
        outputfile=output_path,
        extra_args=[
            '--pdf-engine=xelatex',  # Better Unicode support
            '-V', 'geometry:margin=1in'
        ]
    )
```

### Markdown to PDF

```python
import pypandoc

def markdown_to_pdf(md_path, output_path):
    """Convert Markdown to PDF."""
    pypandoc.convert_file(
        md_path,
        'pdf',
        outputfile=output_path,
        extra_args=[
            '--pdf-engine=xelatex',
            '-V', 'geometry:margin=1in',
            '--highlight-style=tango'  # Code highlighting
        ]
    )
```

### PPTX to PDF (via LibreOffice)

```python
import subprocess
from pathlib import Path

def pptx_to_pdf_libreoffice(pptx_path, output_dir):
    """Convert PPTX to PDF using LibreOffice."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # LibreOffice command
    cmd = [
        'soffice',
        '--headless',
        '--convert-to', 'pdf',
        '--outdir', str(output_dir),
        str(pptx_path)
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(f"Conversion failed: {result.stderr}")

    # Return path to created PDF
    pdf_name = Path(pptx_path).stem + ".pdf"
    return output_dir / pdf_name
```

## Batch Conversion

### Convert Directory

```python
import pypandoc
from pathlib import Path

def batch_convert_docs(input_dir, output_format, output_dir=None):
    """Batch convert documents in directory."""
    input_path = Path(input_dir)
    output_path = Path(output_dir) if output_dir else input_path
    output_path.mkdir(parents=True, exist_ok=True)

    # Map input formats to extensions
    format_map = {
        'markdown': '.md',
        'docx': '.docx',
        'pdf': '.pdf',
        'html': '.html'
    }

    output_ext = format_map.get(output_format, f'.{output_format}')
    results = {'success': [], 'failed': []}

    for doc_file in input_path.iterdir():
        if doc_file.suffix.lower() in {'.docx', '.md', '.markdown'}:
            try:
                output_file = output_path / f"{doc_file.stem}{output_ext}"
                pypandoc.convert_file(
                    str(doc_file),
                    output_format,
                    outputfile=str(output_file)
                )
                results['success'].append(doc_file.name)
                print(f"✓ {doc_file.name} → {output_file.name}")
            except Exception as e:
                results['failed'].append((doc_file.name, str(e)))
                print(f"✗ {doc_file.name}: {e}")

    return results
```

## Error Handling

### Safe Conversion Function

```python
import pypandoc
from pathlib import Path

def safe_convert_document(input_path, output_format, output_path=None):
    """Convert document with comprehensive error handling."""
    input_path = Path(input_path)

    # Validate input
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    supported_input = {'.docx', '.md', '.markdown', '.txt', '.html'}
    if input_path.suffix.lower() not in supported_input:
        raise ValueError(f"Unsupported input format: {input_path.suffix}")

    supported_output = {'markdown', 'docx', 'pdf', 'html', 'gfm'}
    if output_format not in supported_output:
        raise ValueError(f"Unsupported output format: {output_format}")

    # Determine output path
    if output_path is None:
        ext_map = {'markdown': '.md', 'gfm': '.md', 'docx': '.docx',
                   'pdf': '.pdf', 'html': '.html'}
        output_path = input_path.with_suffix(ext_map.get(output_format, f'.{output_format}'))

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        pypandoc.convert_file(
            str(input_path),
            output_format,
            outputfile=str(output_path)
        )

        return {
            'success': True,
            'input': str(input_path),
            'output': str(output_path),
            'size': output_path.stat().st_size
        }

    except Exception as e:
        return {
            'success': False,
            'input': str(input_path),
            'error': str(e)
        }
```

### Check Dependencies

```python
import shutil

def check_document_conversion_deps():
    """Check if required dependencies are installed."""
    deps = {
        'pandoc': shutil.which('pandoc'),
        'xelatex': shutil.which('xelatex'),
        'libreoffice': shutil.which('soffice'),
    }

    missing = [name for name, path in deps.items() if path is None]

    if missing:
        print("Missing dependencies:")
        for dep in missing:
            if dep == 'pandoc':
                print(f"  - {dep}: brew install pandoc (macOS) or apt install pandoc (Linux)")
            elif dep == 'xelatex':
                print(f"  - {dep}: brew install --cask mactex (macOS) or apt install texlive-xetex (Linux)")
            elif dep == 'libreoffice':
                print(f"  - {dep}: brew install --cask libreoffice (macOS)")

    return deps
```

## Complete Conversion Example

```python
from pathlib import Path
import pypandoc
from pptx import Presentation

def convert_document(input_path, output_path):
    """
    Universal document converter.

    Supported conversions:
    - DOCX ↔ Markdown
    - DOCX/MD → PDF
    - PPTX → Markdown
    - Markdown → PPTX
    """
    input_path = Path(input_path)
    output_path = Path(output_path)

    input_ext = input_path.suffix.lower()
    output_ext = output_path.suffix.lower()

    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # DOCX conversions (via pypandoc)
    if input_ext == '.docx':
        format_map = {'.md': 'markdown', '.pdf': 'pdf', '.html': 'html'}
        if output_ext in format_map:
            pypandoc.convert_file(str(input_path), format_map[output_ext],
                                  outputfile=str(output_path))
            return output_path

    # Markdown conversions
    if input_ext in ('.md', '.markdown'):
        if output_ext == '.docx':
            pypandoc.convert_file(str(input_path), 'docx', outputfile=str(output_path))
            return output_path
        elif output_ext == '.pdf':
            pypandoc.convert_file(str(input_path), 'pdf', outputfile=str(output_path),
                                  extra_args=['--pdf-engine=xelatex'])
            return output_path
        elif output_ext == '.pptx':
            # Custom Markdown → PPTX
            return markdown_to_pptx_bullets(input_path, output_path)

    # PPTX to Markdown
    if input_ext == '.pptx' and output_ext == '.md':
        return pptx_to_markdown(input_path, output_path)

    raise ValueError(f"Unsupported conversion: {input_ext} → {output_ext}")
```
