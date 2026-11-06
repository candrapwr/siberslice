import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runPython } from "../python-runner.js";
import { safePath } from "./shared.js";

const CROP_SCRIPT = String.raw`
import json, math, os, shutil, sys, zipfile
try:
    import numpy as np
except ImportError:
    print(json.dumps({"validationError": "Auto-slicing membutuhkan NumPy. Jalankan python3 -m pip install numpy."}))
    sys.exit(0)
from PIL import Image, ImageDraw

payload = json.load(sys.stdin)
source = payload["source"]
out_dir = payload["outDir"]
zip_path = payload["zipPath"]
names = payload["names"]
expected_count = payload["expectedCount"]

class CropValidationError(Exception):
    pass

def connected_components(mask):
    """Label 8-connected foreground runs and return their bounding boxes."""
    height, width = mask.shape
    parent = []
    rank = []
    stats = {}

    def make_label(y, left, right):
        label = len(parent)
        parent.append(label)
        rank.append(0)
        stats[label] = {
            "left": int(left), "top": int(y), "right": int(right), "bottom": int(y + 1),
            "area": int(right - left),
        }
        return label

    def find(label):
        root = label
        while parent[root] != root:
            root = parent[root]
        while parent[label] != label:
            next_label = parent[label]
            parent[label] = root
            label = next_label
        return root

    def union(first, second):
        first = find(first)
        second = find(second)
        if first == second:
            return first
        if rank[first] < rank[second]:
            first, second = second, first
        parent[second] = first
        if rank[first] == rank[second]:
            rank[first] += 1
        keep = stats[first]
        merged = stats.pop(second)
        keep["left"] = min(keep["left"], merged["left"])
        keep["top"] = min(keep["top"], merged["top"])
        keep["right"] = max(keep["right"], merged["right"])
        keep["bottom"] = max(keep["bottom"], merged["bottom"])
        keep["area"] += merged["area"]
        return first

    previous = []
    for y in range(height):
        row = mask[y]
        padded = np.empty(width + 2, dtype=np.int8)
        padded[0] = 0
        padded[-1] = 0
        padded[1:-1] = row
        edges = np.flatnonzero(np.diff(padded))
        current = []
        previous_cursor = 0
        for left, right in zip(edges[::2], edges[1::2]):
            left = int(left)
            right = int(right)
            label = make_label(y, left, right)
            while previous_cursor < len(previous) and previous[previous_cursor][1] < left:
                previous_cursor += 1
            cursor = previous_cursor
            while cursor < len(previous) and previous[cursor][0] <= right:
                if previous[cursor][1] >= left:
                    label = union(label, previous[cursor][2])
                cursor += 1
            current.append((left, right, find(label)))
        previous = current

    return list(stats.values())

def box_gap(first, second):
    dx = max(first["left"] - second["right"], second["left"] - first["right"], 0)
    dy = max(first["top"] - second["bottom"], second["top"] - first["bottom"], 0)
    return math.hypot(dx, dy)

def merge_fragments(components, expected, max_gap):
    count = len(components)
    if count < expected:
        return None
    if count == expected:
        return [dict(component) for component in components], 0.0
    if count > max(2000, expected * 40):
        return None

    ordered = sorted(range(count), key=lambda index: components[index]["top"])
    edges = []
    for order_index, first_index in enumerate(ordered):
        first = components[first_index]
        for second_index in ordered[order_index + 1:]:
            second = components[second_index]
            if second["top"] > first["bottom"] + max_gap:
                break
            distance = box_gap(first, second)
            if distance <= max_gap:
                edges.append((distance, first_index, second_index))
    edges.sort(key=lambda edge: edge[0])

    parent = list(range(count))
    rank = [0] * count
    boxes = [dict(component) for component in components]

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    clusters = count
    used_gap = 0.0
    for distance, first_index, second_index in edges:
        first_root = find(first_index)
        second_root = find(second_index)
        if first_root == second_root:
            continue
        if rank[first_root] < rank[second_root]:
            first_root, second_root = second_root, first_root
        parent[second_root] = first_root
        if rank[first_root] == rank[second_root]:
            rank[first_root] += 1
        first = boxes[first_root]
        second = boxes[second_root]
        first["left"] = min(first["left"], second["left"])
        first["top"] = min(first["top"], second["top"])
        first["right"] = max(first["right"], second["right"])
        first["bottom"] = max(first["bottom"], second["bottom"])
        first["area"] += second["area"]
        clusters -= 1
        used_gap = distance
        if clusters == expected:
            roots = [index for index in range(count) if find(index) == index]
            return [boxes[index] for index in roots], used_gap
    return None

def row_major(groups):
    if not groups:
        return groups
    heights = sorted(group["bottom"] - group["top"] for group in groups)
    median_height = heights[len(heights) // 2]
    row_tolerance = max(8, median_height * 0.42)
    by_center = sorted(groups, key=lambda group: ((group["top"] + group["bottom"]) / 2, group["left"]))
    rows = []
    for group in by_center:
        center_y = (group["top"] + group["bottom"]) / 2
        if not rows or center_y - rows[-1]["center"] > row_tolerance:
            rows.append({"center": center_y, "items": [group]})
        else:
            row = rows[-1]
            row["items"].append(group)
            row["center"] = sum((item["top"] + item["bottom"]) / 2 for item in row["items"]) / len(row["items"])
    result = []
    for row in rows:
        result.extend(sorted(row["items"], key=lambda group: group["left"]))
    return result

os.makedirs(os.path.dirname(out_dir), exist_ok=True)
shutil.rmtree(out_dir, ignore_errors=True)
if os.path.exists(zip_path):
    os.remove(zip_path)
os.makedirs(out_dir, exist_ok=True)

image_file = Image.open(source)
image = image_file.convert("RGBA")
width, height = image.size
if expected_count < 1 or len(names) != expected_count:
    print(json.dumps({"validationError": "Jumlah nama aset tidak cocok dengan jumlah aset yang diminta."}))
    sys.exit(0)

alpha = np.asarray(image.getchannel("A"), dtype=np.uint8)
if np.any(alpha < 255):
    source_type = "alpha"
    thresholds = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 192]
    mask_for_threshold = lambda threshold: alpha > threshold
else:
    source_type = "near-white-background"
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    thresholds = [245]
    mask_for_threshold = lambda threshold: np.any(rgb <= threshold, axis=2)

image_area = width * height
min_component_area = max(6, int(image_area * 0.000005))
max_gap = max(12, min(80, int(math.sqrt(image_area / expected_count) * 0.22)))
component_counts = []
selected = None
selected_threshold = None

for threshold in thresholds:
    components = connected_components(mask_for_threshold(threshold))
    components = [component for component in components if component["area"] >= min_component_area]
    component_counts.append(len(components))
    grouped = merge_fragments(components, expected_count, max_gap)
    if grouped is not None:
        selected, selected_gap = grouped
        selected_threshold = threshold
        break

if selected is None:
    closest = min(component_counts, key=lambda value: abs(value - expected_count)) if component_counts else 0
    detail = "; ".join("%s:%s" % (threshold, count) for threshold, count in zip(thresholds, component_counts))
    shutil.rmtree(out_dir, ignore_errors=True)
    print(json.dumps({
        "validationError": (
            "Deteksi komponen menemukan %d kelompok pada pengaturan terdekat (butuh %d). Jumlah per ambang: %s. "
            "Pastikan tiap aset terpisah dan objek dekoratif yang terlepas tidak terlalu jauh."
        ) % (closest, expected_count, detail)
    }))
    sys.exit(0)

groups = row_major(selected)
padding = max(6, min(64, int(math.sqrt(image_area / expected_count) * 0.08)))
boxes = []
for index, group in enumerate(groups):
    distances = [box_gap(group, other) for other_index, other in enumerate(groups) if other_index != index]
    local_padding = padding if not distances else min(padding, max(2, int(min(distances) / 2) - 1))
    left = max(0, int(group["left"]) - local_padding)
    top = max(0, int(group["top"]) - local_padding)
    right = min(width, int(group["right"]) + local_padding)
    bottom = min(height, int(group["bottom"]) + local_padding)
    boxes.append((left, top, right, bottom))

assets = []
try:
    for index, (box, name_entry) in enumerate(zip(boxes, names), start=1):
        left, top, right, bottom = box
        asset_image = image.crop((left, top, right, bottom))
        if source_type == "near-white-background":
            rgb_crop = np.asarray(asset_image.convert("RGB"), dtype=np.uint8)
            near_white = np.all(rgb_crop > 245, axis=2)
            background_mask = Image.fromarray(np.where(near_white, 255, 0).astype(np.uint8), mode="L")
            edge_points = (
                [(x, 0) for x in range(asset_image.width)]
                + [(x, asset_image.height - 1) for x in range(asset_image.width)]
                + [(0, y) for y in range(1, asset_image.height - 1)]
                + [(asset_image.width - 1, y) for y in range(1, asset_image.height - 1)]
            )
            for point in edge_points:
                if background_mask.getpixel(point) == 255:
                    ImageDraw.floodfill(background_mask, point, 128)
            background = np.asarray(background_mask) == 128
            alpha_crop = np.where(background, 0, 255).astype(np.uint8)
            asset_image.putalpha(Image.fromarray(alpha_crop, mode="L"))

        alpha_crop = np.asarray(asset_image.getchannel("A"), dtype=np.uint8)
        visible = alpha_crop > 64
        if not np.any(visible):
            raise CropValidationError("Hasil crop aset nomor %d kosong atau seluruhnya transparan." % index)
        edge_counts = [
            int(visible[0, :].sum()), int(visible[-1, :].sum()),
            int(visible[:, 0].sum()), int(visible[:, -1].sum()),
        ]
        visible_pixels = int(visible.sum())
        edge_limit = max(16, int(visible_pixels * 0.005))
        if max(edge_counts) > edge_limit:
            raise CropValidationError("Terlalu banyak piksel aset menyentuh tepi crop nomor %d; artwork mungkin terpotong oleh batas gambar." % index)

        name = name_entry["name"]
        filename = name + ".png"
        path = os.path.join(out_dir, filename)
        asset_image.save(path, "PNG", optimize=True)
        assets.append({
            "index": index,
            "name": filename,
            "label": name_entry["label"],
            "width": asset_image.width,
            "height": asset_image.height,
            "path": path,
            "sourceBox": {"x": left, "y": top, "width": right - left, "height": bottom - top},
        })
except CropValidationError as error:
    shutil.rmtree(out_dir, ignore_errors=True)
    print(json.dumps({"validationError": str(error)}))
    sys.exit(0)

if len(assets) != expected_count:
    raise ValueError("Validasi crop tidak menghasilkan jumlah aset yang diminta.")

with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.write(source, "sprite-sheet.png")
    for asset in assets:
        archive.write(asset["path"], "assets/" + asset["name"])

print(json.dumps({
    "width": width,
    "height": height,
    "assets": assets,
    "zipPath": zip_path,
    "detection": {
        "method": "connected-components",
        "source": source_type,
        "threshold": selected_threshold,
        "assetGroups": len(selected),
        "mergeGap": round(selected_gap, 2),
        "padding": padding,
    },
}))
`;

function safeAssetBaseName(value, index) {
  const slug = typeof value === "string"
    ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\.png$/i, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "")
    : "";
  const name = slug || `asset-${String(index).padStart(2, "0")}`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return `asset-${name}`;
  return name;
}

function uniqueAssetNames(names, expectedCount) {
  const used = new Set();
  return Array.from({ length: expectedCount }, (_, index) => {
    const original = typeof names?.[index] === "string" ? names[index].trim() : "";
    const base = safeAssetBaseName(original, index + 1);
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${String(index + 1).padStart(2, "0")}${suffix > 2 ? `-${suffix}` : ""}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    const label = original
      ? original.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
      : name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return { name, label };
  });
}

export async function cropAssets({ imagePath, assetNames, expectedCount, workDir }) {
  const source = safePath(workDir, imagePath);
  const names = uniqueAssetNames(assetNames, expectedCount);
  const assetsDir = join(workDir, "assets");
  const zipPath = join(workDir, "assets.zip");
  await mkdir(dirname(zipPath), { recursive: true });
  return runPython(CROP_SCRIPT, { source, outDir: assetsDir, zipPath, names, expectedCount }, workDir);
}
