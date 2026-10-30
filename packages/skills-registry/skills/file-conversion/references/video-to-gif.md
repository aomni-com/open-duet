# Video to GIF Conversion

Detailed patterns for extracting GIF animations from video files.

## MoviePy Basics

### Simple Conversion

```python
from moviepy.editor import VideoFileClip

def video_to_gif(video_path, output_path, fps=10):
    """Convert entire video to GIF."""
    clip = VideoFileClip(video_path)
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Subclip Extraction

```python
from moviepy.editor import VideoFileClip

def video_to_gif_subclip(video_path, output_path, start=0, end=5, fps=10):
    """Convert portion of video to GIF."""
    clip = VideoFileClip(video_path).subclip(start, end)
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

## Video Analysis

### Get Video Information

```python
from moviepy.editor import VideoFileClip

def analyze_video(video_path):
    """Get video metadata for planning GIF conversion."""
    clip = VideoFileClip(video_path)

    info = {
        'duration': clip.duration,
        'size': clip.size,  # (width, height)
        'fps': clip.fps,
        'estimated_frames': int(clip.duration * clip.fps),
    }

    clip.close()
    return info

# Usage
info = analyze_video("video.mp4")
print(f"Duration: {info['duration']:.1f}s")
print(f"Resolution: {info['size'][0]}x{info['size'][1]}")
print(f"FPS: {info['fps']}")
```

## Quality Control

### Resolution Scaling

```python
from moviepy.editor import VideoFileClip

def video_to_gif_resized(video_path, output_path, width=480, fps=10):
    """Convert video to GIF with specific width (maintains aspect ratio)."""
    clip = VideoFileClip(video_path)

    # Resize to specific width
    clip = clip.resize(width=width)

    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Height-Based Scaling

```python
from moviepy.editor import VideoFileClip

def video_to_gif_height(video_path, output_path, height=320, fps=10):
    """Convert video to GIF with specific height."""
    clip = VideoFileClip(video_path)
    clip = clip.resize(height=height)
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Scale Factor

```python
from moviepy.editor import VideoFileClip

def video_to_gif_scaled(video_path, output_path, scale=0.5, fps=10):
    """Convert video to GIF at percentage of original size."""
    clip = VideoFileClip(video_path)
    clip = clip.resize(scale)  # 0.5 = 50% size
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

## Frame Rate Optimization

### FPS Guidelines

| Use Case           | Recommended FPS | Notes              |
| ------------------ | --------------- | ------------------ |
| Simple animation   | 8-10            | Smallest file size |
| Standard motion    | 12-15           | Good balance       |
| Smooth motion      | 20-24           | Larger files       |
| Near-video quality | 30              | Very large files   |

### Variable FPS Based on Content

```python
from moviepy.editor import VideoFileClip

def smart_gif_fps(video_path, output_path, target_size_mb=5):
    """Automatically adjust FPS to target file size."""
    clip = VideoFileClip(video_path)

    # Start with reasonable defaults
    fps = 15
    width = min(clip.size[0], 480)

    clip = clip.resize(width=width)

    # Estimate: 1 second of 480p GIF at 15fps ≈ 0.5-1MB
    duration = clip.duration
    estimated_size = duration * 0.75  # MB per second estimate

    if estimated_size > target_size_mb:
        # Reduce FPS to meet target
        fps = max(8, int(15 * target_size_mb / estimated_size))

    clip.write_gif(output_path, fps=fps)
    clip.close()

    return {'fps_used': fps, 'width': width}
```

## Clip Editing

### Subclip with Timestamps

```python
from moviepy.editor import VideoFileClip

# Using seconds
clip = VideoFileClip("video.mp4").subclip(10, 15)  # 10s to 15s

# Using (minutes, seconds)
clip = VideoFileClip("video.mp4").subclip((1, 30), (1, 35))  # 1:30 to 1:35

# From start
clip = VideoFileClip("video.mp4").subclip(0, 5)  # First 5 seconds

# To end
clip = VideoFileClip("video.mp4").subclip(10)  # From 10s to end
```

### Speed Adjustment

```python
from moviepy.editor import VideoFileClip

def video_to_gif_speed(video_path, output_path, speed=1.5, fps=12):
    """Create sped-up or slowed-down GIF."""
    clip = VideoFileClip(video_path)

    # Speed up (1.5 = 50% faster) or slow down (0.5 = half speed)
    clip = clip.speedx(speed)

    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Reverse Clip

```python
from moviepy.editor import VideoFileClip

def video_to_gif_reversed(video_path, output_path, fps=12):
    """Create reversed GIF."""
    clip = VideoFileClip(video_path)
    clip = clip.fx(lambda c: c.time_mirror())
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Loop (Boomerang Effect)

```python
from moviepy.editor import VideoFileClip, concatenate_videoclips

def video_to_boomerang(video_path, output_path, fps=12):
    """Create boomerang-style GIF (forward then backward)."""
    clip = VideoFileClip(video_path)

    # Create reversed version
    reversed_clip = clip.fx(lambda c: c.time_mirror())

    # Concatenate forward + reverse
    boomerang = concatenate_videoclips([clip, reversed_clip])

    boomerang.write_gif(output_path, fps=fps)
    clip.close()
```

## Cropping

### Crop to Region

```python
from moviepy.editor import VideoFileClip

def video_to_gif_cropped(video_path, output_path, x1, y1, x2, y2, fps=12):
    """Create GIF from cropped region of video."""
    clip = VideoFileClip(video_path)

    # Crop: (x1, y1) is top-left, (x2, y2) is bottom-right
    clip = clip.crop(x1=x1, y1=y1, x2=x2, y2=y2)

    clip.write_gif(output_path, fps=fps)
    clip.close()
```

### Center Crop to Square

```python
from moviepy.editor import VideoFileClip

def video_to_square_gif(video_path, output_path, fps=12):
    """Create square GIF from center of video."""
    clip = VideoFileClip(video_path)

    width, height = clip.size
    size = min(width, height)

    x1 = (width - size) // 2
    y1 = (height - size) // 2

    clip = clip.crop(x1=x1, y1=y1, x2=x1+size, y2=y1+size)
    clip.write_gif(output_path, fps=fps)
    clip.close()
```

## Size Optimization

### File Size Estimation

```python
from moviepy.editor import VideoFileClip
import os

def estimate_gif_size(duration, width, fps):
    """Rough estimate of GIF file size in MB."""
    # Very rough: ~50KB per frame for 480p
    frame_size_kb = (width / 480) ** 2 * 50
    total_frames = duration * fps
    return (frame_size_kb * total_frames) / 1024  # MB
```

### Optimize for Target Size

```python
from moviepy.editor import VideoFileClip
from pathlib import Path

def video_to_gif_optimized(video_path, output_path, max_size_mb=10):
    """Create GIF optimized for target file size."""
    clip = VideoFileClip(video_path)

    # Start with defaults
    width = 480
    fps = 12

    # Reduce quality if video is long
    if clip.duration > 10:
        fps = 10
    if clip.duration > 20:
        width = 320
        fps = 8

    clip = clip.resize(width=width)
    clip.write_gif(output_path, fps=fps)
    clip.close()

    # Check result and warn if too large
    result_size = Path(output_path).stat().st_size / (1024 * 1024)
    if result_size > max_size_mb:
        print(f"Warning: GIF is {result_size:.1f}MB (target: {max_size_mb}MB)")
        print("Consider: shorter clip, lower resolution, or fewer FPS")

    return {'size_mb': result_size, 'width': width, 'fps': fps}
```

## Color Optimization

### Limit Color Palette

```python
from moviepy.editor import VideoFileClip

def video_to_gif_limited_colors(video_path, output_path, fps=12, colors=128):
    """Create GIF with limited color palette for smaller size."""
    clip = VideoFileClip(video_path)

    # Use program argument for color limiting
    clip.write_gif(output_path, fps=fps, program='ffmpeg',
                   opt='nq', fuzz=10)  # nq = no quantize, fuzz for dithering
    clip.close()
```

## Complete Conversion Function

```python
from moviepy.editor import VideoFileClip
from pathlib import Path

def convert_video_to_gif(
    video_path,
    output_path,
    start=None,
    end=None,
    width=None,
    fps=12,
    speed=1.0
):
    """
    Full-featured video to GIF conversion.

    Args:
        video_path: Input video file
        output_path: Output GIF file
        start: Start time in seconds (None = beginning)
        end: End time in seconds (None = end of video)
        width: Output width (None = original)
        fps: Frames per second (default 12)
        speed: Playback speed multiplier (1.0 = normal)

    Returns:
        dict with conversion details
    """
    video_path = Path(video_path)
    output_path = Path(output_path)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    clip = VideoFileClip(str(video_path))
    original_duration = clip.duration

    # Apply subclip
    if start is not None or end is not None:
        start = start or 0
        end = end or clip.duration
        clip = clip.subclip(start, end)

    # Apply speed
    if speed != 1.0:
        clip = clip.speedx(speed)

    # Apply resize
    if width:
        clip = clip.resize(width=width)

    # Create output directory if needed
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write GIF
    clip.write_gif(str(output_path), fps=fps)

    result = {
        'input': str(video_path),
        'output': str(output_path),
        'original_duration': original_duration,
        'gif_duration': clip.duration,
        'size': clip.size,
        'fps': fps,
        'file_size_mb': output_path.stat().st_size / (1024 * 1024)
    }

    clip.close()
    return result
```

## Error Handling

### Safe Conversion with Cleanup

```python
from moviepy.editor import VideoFileClip
from pathlib import Path

def safe_video_to_gif(video_path, output_path, **kwargs):
    """Video to GIF with proper error handling and cleanup."""
    clip = None
    try:
        clip = VideoFileClip(str(video_path))

        # Validate duration
        if clip.duration < 0.1:
            raise ValueError("Video too short for GIF conversion")

        if clip.duration > 60:
            print("Warning: Long video will produce large GIF")

        # Apply settings
        if 'width' in kwargs:
            clip = clip.resize(width=kwargs['width'])
        if 'subclip' in kwargs:
            clip = clip.subclip(*kwargs['subclip'])

        fps = kwargs.get('fps', 12)
        clip.write_gif(str(output_path), fps=fps)

        return {'success': True, 'output': str(output_path)}

    except Exception as e:
        return {'success': False, 'error': str(e)}

    finally:
        if clip:
            clip.close()
```

## Batch Conversion

```python
from moviepy.editor import VideoFileClip
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

def batch_video_to_gif(video_dir, output_dir, width=480, fps=10):
    """Convert all videos in directory to GIFs."""
    video_path = Path(video_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.webm'}
    results = []

    for video_file in video_path.iterdir():
        if video_file.suffix.lower() not in video_extensions:
            continue

        gif_file = output_path / f"{video_file.stem}.gif"

        try:
            clip = VideoFileClip(str(video_file))
            clip = clip.resize(width=width)
            clip.write_gif(str(gif_file), fps=fps)
            clip.close()

            results.append({'file': video_file.name, 'success': True})
            print(f"✓ {video_file.name}")

        except Exception as e:
            results.append({'file': video_file.name, 'success': False, 'error': str(e)})
            print(f"✗ {video_file.name}: {e}")

    return results
```
