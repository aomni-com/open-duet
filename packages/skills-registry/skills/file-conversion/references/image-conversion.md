# Image Conversion

Detailed patterns for converting between image formats.

## Pillow Basics

### Basic Conversion

```python
from PIL import Image

def convert_image(input_path, output_path, quality=95):
    """Convert image to different format based on output extension."""
    img = Image.open(input_path)

    # Handle transparency for JPEG
    output_ext = output_path.lower().split('.')[-1]
    if output_ext in ('jpg', 'jpeg') and img.mode in ('RGBA', 'LA', 'P'):
        # Create white background
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
        img = background

    img.save(output_path, quality=quality, optimize=True)
    return output_path
```

### Format-Specific Options

```python
from PIL import Image

img = Image.open("input.png")

# JPEG - quality and optimization
img.save("output.jpg", quality=95, optimize=True, progressive=True)

# PNG - compression level (0-9, higher = smaller but slower)
img.save("output.png", optimize=True, compress_level=6)

# WEBP - quality and method
img.save("output.webp", quality=90, method=6)  # method 0-6, higher = slower/better

# WEBP lossless
img.save("output.webp", lossless=True)
```

## HEIC Handling

### Reading HEIC Files

```python
from PIL import Image
from pillow_heif import register_heif_opener

# Register HEIC support (do once at startup)
register_heif_opener()

# Now Pillow can open HEIC files
img = Image.open("photo.heic")
img.save("photo.jpg", quality=95)
```

### Batch Convert HEIC

```python
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener()

def convert_heic_directory(input_dir, output_format="jpg"):
    """Convert all HEIC files in directory."""
    input_path = Path(input_dir)
    converted = []

    for heic_file in input_path.glob("*.heic"):
        img = Image.open(heic_file)

        # Handle RGBA mode for JPEG
        if output_format.lower() in ('jpg', 'jpeg') and img.mode == 'RGBA':
            img = img.convert('RGB')

        output_file = heic_file.with_suffix(f".{output_format}")
        img.save(output_file, quality=95)
        converted.append(output_file)
        print(f"Converted: {heic_file.name} → {output_file.name}")

    return converted
```

### HEIC with EXIF Preservation

```python
from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener()

def convert_heic_preserve_exif(input_path, output_path):
    """Convert HEIC while preserving EXIF metadata."""
    img = Image.open(input_path)

    # Get EXIF data
    exif = img.getexif()

    if img.mode == 'RGBA':
        img = img.convert('RGB')

    # Save with EXIF
    img.save(output_path, quality=95, exif=exif)
```

## SVG Rasterization

### Basic SVG to PNG

```python
import cairosvg

# Simple conversion
cairosvg.svg2png(url="input.svg", write_to="output.png")

# With specific dimensions
cairosvg.svg2png(
    url="input.svg",
    write_to="output.png",
    output_width=800,
    output_height=600
)
```

### SVG to Other Formats

```python
import cairosvg
from PIL import Image
from io import BytesIO

def svg_to_format(svg_path, output_path, width=None, height=None):
    """Convert SVG to any raster format via PNG intermediate."""
    # First convert to PNG in memory
    png_data = cairosvg.svg2png(
        url=svg_path,
        output_width=width,
        output_height=height
    )

    # Then use Pillow to save as desired format
    img = Image.open(BytesIO(png_data))

    output_ext = output_path.lower().split('.')[-1]
    if output_ext in ('jpg', 'jpeg'):
        img = img.convert('RGB')

    img.save(output_path, quality=95)
    return output_path
```

### SVG with Scale Factor

```python
import cairosvg

def svg_to_png_scaled(svg_path, output_path, scale=2):
    """Convert SVG to PNG at specified scale (for retina/HiDPI)."""
    cairosvg.svg2png(
        url=svg_path,
        write_to=output_path,
        scale=scale
    )
```

### Handle SVG with External Resources

```python
import cairosvg
from pathlib import Path

def svg_to_png_with_base(svg_path, output_path):
    """Convert SVG that references external files."""
    svg_path = Path(svg_path).resolve()

    cairosvg.svg2png(
        url=str(svg_path),
        write_to=output_path,
        # Base URL for resolving relative paths
        base_url=str(svg_path.parent)
    )
```

## WEBP Conversion

### To WEBP (Lossy)

```python
from PIL import Image

def to_webp(input_path, output_path, quality=90):
    """Convert image to WEBP format."""
    img = Image.open(input_path)
    img.save(output_path, 'WEBP', quality=quality, method=6)
```

### To WEBP (Lossless)

```python
from PIL import Image

def to_webp_lossless(input_path, output_path):
    """Convert image to lossless WEBP."""
    img = Image.open(input_path)
    img.save(output_path, 'WEBP', lossless=True)
```

### From WEBP

```python
from PIL import Image

def webp_to_format(input_path, output_path):
    """Convert WEBP to other format."""
    img = Image.open(input_path)

    output_ext = output_path.lower().split('.')[-1]
    if output_ext in ('jpg', 'jpeg') and img.mode in ('RGBA', 'LA', 'P'):
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        background.paste(img, mask=img.split()[-1])
        img = background

    img.save(output_path, quality=95)
```

## Batch Conversion

### Convert Directory

```python
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener
import cairosvg
from io import BytesIO

register_heif_opener()

def batch_convert_images(input_dir, output_format, output_dir=None):
    """Convert all images in directory to specified format."""
    input_path = Path(input_dir)
    output_path = Path(output_dir) if output_dir else input_path
    output_path.mkdir(parents=True, exist_ok=True)

    supported = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.svg'}
    results = {'success': [], 'failed': []}

    for img_file in input_path.iterdir():
        if img_file.suffix.lower() not in supported:
            continue

        try:
            output_file = output_path / f"{img_file.stem}.{output_format}"

            if img_file.suffix.lower() == '.svg':
                # SVG needs special handling
                png_data = cairosvg.svg2png(url=str(img_file))
                img = Image.open(BytesIO(png_data))
            else:
                img = Image.open(img_file)

            # Handle transparency for JPEG
            if output_format.lower() in ('jpg', 'jpeg') and img.mode in ('RGBA', 'LA', 'P'):
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                if img.mode == 'RGBA':
                    background.paste(img, mask=img.split()[-1])
                else:
                    background.paste(img)
                img = background

            img.save(output_file, quality=95)
            results['success'].append(img_file.name)
            print(f"✓ {img_file.name} → {output_file.name}")

        except Exception as e:
            results['failed'].append((img_file.name, str(e)))
            print(f"✗ {img_file.name}: {e}")

    return results
```

### Parallel Batch Conversion

```python
from pathlib import Path
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed

def convert_single(args):
    """Convert single image (for use with ThreadPoolExecutor)."""
    input_path, output_path, quality = args
    try:
        img = Image.open(input_path)
        if output_path.suffix.lower() in ('.jpg', '.jpeg') and img.mode == 'RGBA':
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])
            img = background
        img.save(output_path, quality=quality)
        return (input_path.name, True, None)
    except Exception as e:
        return (input_path.name, False, str(e))

def batch_convert_parallel(input_dir, output_format, output_dir=None, max_workers=4):
    """Convert images in parallel for better performance."""
    input_path = Path(input_dir)
    output_path = Path(output_dir) if output_dir else input_path
    output_path.mkdir(parents=True, exist_ok=True)

    tasks = []
    for img_file in input_path.glob("*"):
        if img_file.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
            output_file = output_path / f"{img_file.stem}.{output_format}"
            tasks.append((img_file, output_file, 95))

    results = {'success': 0, 'failed': 0}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(convert_single, task) for task in tasks]
        for future in as_completed(futures):
            name, success, error = future.result()
            if success:
                results['success'] += 1
                print(f"✓ {name}")
            else:
                results['failed'] += 1
                print(f"✗ {name}: {error}")

    return results
```

## Image Optimization

### Resize During Conversion

```python
from PIL import Image

def convert_and_resize(input_path, output_path, max_size=(1920, 1080)):
    """Convert and resize image to fit within max dimensions."""
    img = Image.open(input_path)

    # Calculate new size maintaining aspect ratio
    img.thumbnail(max_size, Image.Resampling.LANCZOS)

    if output_path.lower().endswith(('.jpg', '.jpeg')) and img.mode == 'RGBA':
        background = Image.new('RGB', img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background

    img.save(output_path, quality=95, optimize=True)
```

### Strip Metadata

```python
from PIL import Image

def convert_strip_metadata(input_path, output_path):
    """Convert image and remove all metadata."""
    img = Image.open(input_path)

    # Create new image without metadata
    data = list(img.getdata())
    img_no_meta = Image.new(img.mode, img.size)
    img_no_meta.putdata(data)

    img_no_meta.save(output_path, quality=95)
```

## Error Handling

### Comprehensive Conversion Function

```python
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener
import cairosvg
from io import BytesIO

register_heif_opener()

def safe_convert_image(input_path, output_path, quality=95):
    """Convert image with comprehensive error handling."""
    input_path = Path(input_path)
    output_path = Path(output_path)

    # Validate input
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    supported = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.svg'}
    if input_path.suffix.lower() not in supported:
        raise ValueError(f"Unsupported input format: {input_path.suffix}")

    output_ext = output_path.suffix.lower()
    if output_ext not in {'.jpg', '.jpeg', '.png', '.webp'}:
        raise ValueError(f"Unsupported output format: {output_ext}")

    try:
        # Handle SVG specially
        if input_path.suffix.lower() == '.svg':
            png_data = cairosvg.svg2png(url=str(input_path))
            img = Image.open(BytesIO(png_data))
        else:
            img = Image.open(input_path)

        # Handle transparency
        if output_ext in ('.jpg', '.jpeg') and img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            if img.mode in ('RGBA', 'LA'):
                background.paste(img, mask=img.split()[-1])
            else:
                background.paste(img)
            img = background

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Save
        img.save(output_path, quality=quality, optimize=True)

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
