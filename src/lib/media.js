import path from "node:path";

// Mirrors the extension set from the original FastAPI app.
export const MEDIA_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
    ".mp4",
    ".webm",
    ".mov",
]);

export const VIDEO_EXTENSIONS = new Set([
    ".mp4",
    ".webm",
    ".mov",
]);

const CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
};

export function extensionOf(name) {
    return path.extname(name).toLowerCase();
}

export function isMedia(name) {
    return MEDIA_EXTENSIONS.has(extensionOf(name));
}

export function mediaType(name) {
    return VIDEO_EXTENSIONS.has(extensionOf(name))
        ? "video"
        : "image";
}

export function contentTypeOf(name) {
    return (
        CONTENT_TYPES[extensionOf(name)] ||
        "application/octet-stream"
    );
}

// Natural sort: "2.webp" < "10.webp" (matches the FastAPI version).
export function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

// Build a URL-safe, unique-ish slug from a (possibly non-ASCII) name.
export function slugify(name) {
    const base = name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

    const suffix = Math.random().toString(36).slice(2, 8);

    return base ? `${base}-${suffix}` : `gallery-${suffix}`;
}
