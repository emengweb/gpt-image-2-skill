#!/usr/bin/env python3
"""
Background Removal Script using rembg (AI-based)
Removes backgrounds from images using the U2-Net model.

Features:
- AI-based background removal (U2-Net model)
- Built-in white-to-transparent conversion (fast fallback)
- Batch processing support
- Multiple output formats (PNG, WebP)
"""

import argparse
import os
import sys
import json
from pathlib import Path


JSON_ONLY = False
TRANSPARENT_ALPHA_MAX = 5


def log(message: str, *, error: bool = False):
    if JSON_ONLY:
        return
    print(message, file=sys.stderr if error else sys.stdout)


def load_env():
    """Load environment variables from .env file.

    Checks these locations in order:
    1. ~/.config/skills/.env (recommended)
    2. ~/.env (home directory)
    3. Walk up from script location (for local development)
    """

    def parse_env_file(env_file: Path):
        if env_file.exists():
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, _, value = line.partition("=")
                        key = key.strip()
                        value = value.strip().strip('"').strip("'")
                        if key and value and key not in os.environ:
                            os.environ[key] = value
            return True
        return False

    home = Path.home()
    if parse_env_file(home / ".config" / "skills" / ".env"):
        return
    if parse_env_file(home / ".env"):
        return

    current = Path(__file__).resolve().parent
    for _ in range(10):
        if parse_env_file(current / ".env"):
            return
        current = current.parent


load_env()


BG_REMOVAL_METHODS = {
    "rembg": "AI-based removal using rembg/U2-Net (high quality, runs locally)",
    "builtin": "Built-in white-to-transparent conversion (fast, may have artifacts)",
}


def scrub_transparent_pixels(image):
    """Zero RGB channels for fully transparent pixels to avoid halo artifacts."""
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    try:
        import numpy as np
        from PIL import Image

        data = np.array(image)
        transparent_mask = data[:, :, 3] <= TRANSPARENT_ALPHA_MAX
        if transparent_mask.any():
            data[transparent_mask, 0] = 0
            data[transparent_mask, 1] = 0
            data[transparent_mask, 2] = 0
            data[transparent_mask, 3] = 0
        return Image.fromarray(data, "RGBA")
    except ImportError:
        pixels = image.load()
        width, height = image.size
        for y in range(height):
            for x in range(width):
                r, g, b, a = pixels[x, y]
                if a <= TRANSPARENT_ALPHA_MAX:
                    pixels[x, y] = (0, 0, 0, 0)
        return image


def remove_background_rembg(image_path: str, output_path: str = None) -> dict:
    """Remove background using rembg (AI-based, runs locally)."""
    try:
        from rembg import remove
        from PIL import Image
    except ImportError:
        return {"error": "rembg not installed. Install with: pip install rembg[gpu] (or pip install rembg for CPU-only)"}

    if not Path(image_path).exists():
        return {"error": f"Image not found: {image_path}"}

    if not output_path:
        input_path = Path(image_path)
        output_path = str(input_path.parent / f"{input_path.stem}_nobg.png")

    try:
        input_img = Image.open(image_path)
        log("Removing background with rembg (AI model)...")
        output_img = remove(input_img)
        output_img = scrub_transparent_pixels(output_img)

        output_dir = Path(output_path).parent
        if output_dir and str(output_dir) != "." and not output_dir.exists():
            output_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(output_path).suffix.lower()
        if ext == ".webp":
            output_img.save(output_path, "WEBP")
        else:
            output_img.save(output_path, "PNG")

        log(f"Background removed: {output_path}")

        return {
            "success": True,
            "file": output_path,
            "method": "rembg",
        }

    except Exception as e:
        return {"error": f"rembg background removal failed: {str(e)}"}


def remove_background_builtin(image_path: str, output_path: str = None) -> dict:
    """Remove background using built-in white-to-transparent conversion."""
    try:
        from PIL import Image
    except ImportError:
        return {"error": "Pillow not installed. Install with: pip install Pillow"}

    if not Path(image_path).exists():
        return {"error": f"Image not found: {image_path}"}

    if not output_path:
        input_path = Path(image_path)
        output_path = str(input_path.parent / f"{input_path.stem}_nobg.png")

    try:
        img = Image.open(image_path)
        img = img.convert("RGBA")

        try:
            import numpy as np
            data = np.array(img)

            r, g, b, a = data[:, :, 0], data[:, :, 1], data[:, :, 2], data[:, :, 3]
            brightness = (r.astype(float) + g.astype(float) + b.astype(float)) / 3
            max_rgb = np.maximum(np.maximum(r, g), b).astype(float)
            min_rgb = np.minimum(np.minimum(r, g), b).astype(float)
            saturation = np.where(max_rgb > 0, (max_rgb - min_rgb) / max_rgb, 0)

            mask = (
                ((saturation < 0.30) & (brightness > 100)) |
                (brightness > 240)
            )

            data[:, :, 0] = np.where(mask, 0, r)
            data[:, :, 1] = np.where(mask, 0, g)
            data[:, :, 2] = np.where(mask, 0, b)
            data[:, :, 3] = np.where(mask, 0, a)
            img = Image.fromarray(data)

        except ImportError:
            pixels = img.load()
            width, height = img.size
            for y in range(height):
                for x in range(width):
                    r, g, b, a = pixels[x, y]
                    brightness = (r + g + b) / 3
                    max_rgb = max(r, g, b)
                    min_rgb = min(r, g, b)
                    saturation = (max_rgb - min_rgb) / max_rgb if max_rgb > 0 else 0

                    if (saturation < 0.30 and brightness > 100) or brightness > 240:
                        pixels[x, y] = (0, 0, 0, 0)

        img = scrub_transparent_pixels(img)

        output_dir = Path(output_path).parent
        if output_dir and str(output_dir) != "." and not output_dir.exists():
            output_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(output_path).suffix.lower()
        if ext == ".webp":
            img.save(output_path, "WEBP")
        else:
            img.save(output_path, "PNG")

        log(f"Background removed: {output_path}")

        return {
            "success": True,
            "file": output_path,
            "method": "builtin",
        }

    except Exception as e:
        return {"error": f"Built-in background removal failed: {str(e)}"}


def remove_background(image_path: str, output_path: str = None, method: str = "rembg") -> dict:
    """Remove background from an image."""
    if method == "rembg":
        result = remove_background_rembg(image_path, output_path)
        if "error" in result and "not installed" in result.get("error", ""):
            log("rembg not available, falling back to builtin method...")
            fallback_result = remove_background_builtin(image_path, output_path)
            if fallback_result.get("success"):
                fallback_result["fallback_from"] = "rembg"
            return fallback_result
        return result
    if method == "builtin":
        return remove_background_builtin(image_path, output_path)
    return {"error": f"Unknown method: {method}. Use 'rembg' or 'builtin'."}


def main():
    parser = argparse.ArgumentParser(
        description="Remove backgrounds from images using AI (rembg) or built-in methods",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Methods:
  rembg     AI-based using U2-Net model (high quality, default)
  builtin   Fast white-to-transparent conversion (good for clean backgrounds)

Examples:
  # Remove background from a single image
  python background_remove.py -i photo.jpg

  # Specify output path
  python background_remove.py -i photo.jpg -o photo_transparent.png

  # Use built-in method (faster, for white backgrounds)
  python background_remove.py -i icon.png -m builtin

  # Batch process multiple images
  python background_remove.py -i img1.jpg img2.png img3.webp

  # Output as WebP
  python background_remove.py -i photo.jpg -o result.webp
        """,
    )

    parser.add_argument("--input", "-i", nargs="+", required=True, help="Input image path(s)")
    parser.add_argument("--output", "-o", help="Output path (for single image) or directory (for batch)")
    parser.add_argument(
        "--method",
        "-m",
        default="rembg",
        choices=["rembg", "builtin"],
        help="Background removal method (default: rembg)",
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Suppress progress logs and emit only the final JSON payload",
    )

    args = parser.parse_args()

    global JSON_ONLY
    JSON_ONLY = args.json_only

    results = []

    for input_path in args.input:
        if args.output:
            if len(args.input) > 1:
                output_dir = Path(args.output)
                output_dir.mkdir(parents=True, exist_ok=True)
                input_name = Path(input_path).stem
                output_path = str(output_dir / f"{input_name}_nobg.png")
            else:
                output_path = args.output
        else:
            output_path = None

        log(f"Processing: {input_path}")
        result = remove_background(input_path, output_path, args.method)

        if "error" in result:
            log(f"  Error: {result['error']}", error=True)
        else:
            log(f"  Saved: {result['file']}")

        results.append(result)

    successful = [r for r in results if r.get("success")]
    failed = [r for r in results if "error" in r]

    if not JSON_ONLY:
        print()
        if successful:
            print(f"Successfully processed {len(successful)} image(s)")
        if failed:
            print(f"Failed: {len(failed)} image(s)", file=sys.stderr)

    payload = results[0] if len(results) == 1 else {"results": results}
    print(json.dumps(payload, indent=None if JSON_ONLY else 2))

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
