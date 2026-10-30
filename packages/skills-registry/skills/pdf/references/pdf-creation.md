# PDF Creation with ReportLab

Detailed patterns for generating PDFs from scratch.

## Document Setup

### Basic Canvas (Low-Level)

For simple, single-page documents:

```python
from reportlab.lib.pagesizes import letter, A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch

c = canvas.Canvas("output.pdf", pagesize=letter)
width, height = letter  # 612 x 792 points

# Coordinate system: (0,0) is bottom-left
c.drawString(1*inch, height - 1*inch, "Title at top")
c.save()
```

### Platypus (High-Level)

For multi-page documents with automatic flow:

```python
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch

doc = SimpleDocTemplate(
    "output.pdf",
    pagesize=letter,
    leftMargin=1*inch,
    rightMargin=1*inch,
    topMargin=1*inch,
    bottomMargin=1*inch
)

styles = getSampleStyleSheet()
story = []  # Elements flow into this list
```

## Text and Paragraphs

### Styled Text

```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY

styles = getSampleStyleSheet()

# Use built-in styles
story.append(Paragraph("Main Title", styles['Title']))
story.append(Paragraph("Section Heading", styles['Heading1']))
story.append(Paragraph("Body text goes here.", styles['Normal']))

# Custom style
custom_style = ParagraphStyle(
    'CustomStyle',
    parent=styles['Normal'],
    fontSize=12,
    leading=16,  # Line height
    alignment=TA_JUSTIFY,
    spaceAfter=12
)
story.append(Paragraph("Custom styled text.", custom_style))
```

### Inline Formatting

```python
# HTML-like tags within paragraphs
text = """
<b>Bold text</b>, <i>italic text</i>, and <u>underlined text</u>.
<font color="red">Colored text</font> and <font size="14">larger text</font>.
<a href="https://example.com">Hyperlink</a>.
"""
story.append(Paragraph(text, styles['Normal']))
```

## Tables

### Basic Table

```python
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors

data = [
    ['Name', 'Age', 'City'],
    ['Alice', '30', 'New York'],
    ['Bob', '25', 'Los Angeles'],
    ['Charlie', '35', 'Chicago'],
]

table = Table(data)
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),      # Header background
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke), # Header text color
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),             # Center all cells
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),   # Header font
    ('FONTSIZE', (0, 0), (-1, -1), 10),                # All cells font size
    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),            # Header padding
    ('BACKGROUND', (0, 1), (-1, -1), colors.beige),    # Body background
    ('GRID', (0, 0), (-1, -1), 1, colors.black),       # Grid lines
]))
story.append(table)
```

### Table with Column Widths

```python
from reportlab.lib.units import inch

table = Table(data, colWidths=[2*inch, 1*inch, 2*inch])
```

### Alternating Row Colors

```python
style_commands = [
    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#4472C4')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
]

# Add alternating colors for data rows
for i in range(1, len(data)):
    bg_color = colors.HexColor('#D9E2F3') if i % 2 == 0 else colors.white
    style_commands.append(('BACKGROUND', (0, i), (-1, i), bg_color))

table.setStyle(TableStyle(style_commands))
```

## Images

### Adding Images

```python
from reportlab.platypus import Image
from reportlab.lib.units import inch

# Basic image
img = Image("photo.jpg", width=3*inch, height=2*inch)
story.append(img)

# Maintain aspect ratio
img = Image("photo.jpg", width=3*inch)
img._restrictSize(3*inch, 5*inch)  # Max dimensions
story.append(img)
```

### Image from URL or Bytes

```python
from reportlab.platypus import Image
from io import BytesIO
import requests

# From URL
response = requests.get("https://example.com/image.png")
img = Image(BytesIO(response.content), width=200, height=150)
story.append(img)
```

## Charts

### Pie Chart

```python
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.charts.piecharts import Pie
from reportlab.lib import colors

drawing = Drawing(400, 200)
pie = Pie()
pie.x = 150
pie.y = 50
pie.width = 100
pie.height = 100
pie.data = [30, 25, 20, 15, 10]
pie.labels = ['A', 'B', 'C', 'D', 'E']
pie.slices.strokeWidth = 0.5
pie.slices[0].fillColor = colors.red
pie.slices[1].fillColor = colors.blue
pie.slices[2].fillColor = colors.green
drawing.add(pie)
story.append(drawing)
```

### Bar Chart

```python
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.charts.barcharts import VerticalBarChart

drawing = Drawing(400, 200)
bc = VerticalBarChart()
bc.x = 50
bc.y = 50
bc.height = 125
bc.width = 300
bc.data = [[10, 20, 30, 40], [15, 25, 35, 45]]
bc.categoryAxis.categoryNames = ['Q1', 'Q2', 'Q3', 'Q4']
bc.valueAxis.valueMin = 0
bc.valueAxis.valueMax = 50
drawing.add(bc)
story.append(drawing)
```

## Forms (Interactive Fields)

### Creating Fillable Forms

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfform

c = canvas.Canvas("form.pdf", pagesize=letter)
c.acroForm.textfield(
    name='name_field',
    x=100,
    y=700,
    width=200,
    height=20,
    borderColor=None,
    fillColor=None,
    textColor=None,
    forceBorder=True
)

c.acroForm.checkbox(
    name='agree_checkbox',
    x=100,
    y=650,
    size=20,
    checked=False
)

c.drawString(130, 652, "I agree to the terms")
c.save()
```

### Form Field Types

```python
# Text field
c.acroForm.textfield(name='text', x=100, y=700, width=200, height=20)

# Multi-line text
c.acroForm.textfield(name='comments', x=100, y=600, width=200, height=100,
                     multiline=True)

# Checkbox
c.acroForm.checkbox(name='check', x=100, y=550, size=20)

# Radio buttons
c.acroForm.radio(name='choice', value='option1', x=100, y=500, size=20)
c.acroForm.radio(name='choice', value='option2', x=100, y=470, size=20)

# Dropdown
c.acroForm.choice(name='dropdown', x=100, y=420, width=200, height=20,
                  options=['Option 1', 'Option 2', 'Option 3'])
```

## Page Headers and Footers

### Using Canvas Callbacks

```python
from reportlab.platypus import SimpleDocTemplate, Paragraph
from reportlab.lib.pagesizes import letter

def header_footer(canvas, doc):
    canvas.saveState()

    # Header
    canvas.setFont('Helvetica', 9)
    canvas.drawString(inch, letter[1] - 0.5*inch, "Company Name")
    canvas.drawRightString(letter[0] - inch, letter[1] - 0.5*inch, "Report Title")

    # Footer
    canvas.drawString(inch, 0.5*inch, f"Page {doc.page}")
    canvas.drawRightString(letter[0] - inch, 0.5*inch, "Confidential")

    canvas.restoreState()

doc = SimpleDocTemplate("output.pdf", pagesize=letter)
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
```

## Complete Report Example

```python
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib import colors

def generate_report(output_path, title, data):
    doc = SimpleDocTemplate(output_path, pagesize=letter)
    styles = getSampleStyleSheet()
    story = []

    # Title
    story.append(Paragraph(title, styles['Title']))
    story.append(Spacer(1, 0.5*inch))

    # Introduction
    story.append(Paragraph("Executive Summary", styles['Heading1']))
    story.append(Paragraph(
        "This report provides an overview of quarterly performance metrics.",
        styles['Normal']
    ))
    story.append(Spacer(1, 0.25*inch))

    # Data table
    story.append(Paragraph("Performance Data", styles['Heading2']))
    table = Table(data)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#4472C4')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('GRID', (0, 0), (-1, -1), 1, colors.black),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ]))
    story.append(table)

    # Build PDF
    doc.build(story)
    print(f"Report saved to {output_path}")

# Usage
data = [
    ['Metric', 'Q1', 'Q2', 'Q3', 'Q4'],
    ['Revenue', '$100K', '$120K', '$115K', '$140K'],
    ['Users', '1000', '1200', '1400', '1800'],
]
generate_report("quarterly_report.pdf", "Q4 Performance Report", data)
```
