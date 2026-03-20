# Convert Base64 to PNG

This plugin for [Obsidian](https://obsidian.md) converts inline base64-encoded image data in your notes to local image files. It keeps the original image bytes, preserves the source file extension inferred from the data URI, and rewrites your note to point at the extracted file instead of the embedded base64 payload.

## Demo
![Demo](screenshots/demo.gif)

## Features

- **Base64 Detection**: Automatically detects base64-encoded images in your notes
- **Local Extraction**: Converts base64 images to local image files without transcoding the original bytes
- **Batch Processing**: Process individual files or all files in your vault
- **Customizable Storage**: Configure where and how extracted image files are stored
- **Flexible Output Links**: Generate standard Markdown image links or Obsidian wikilink embeds
- **Automatic Conversion**: Option to automatically convert pasted inline base64 image markdown
- **Idempotent File Reuse**: Reuses previously generated files for identical image content instead of creating duplicates on repeated runs

## How It Works

When you run the plugin:

1. It scans your notes for base64-encoded images
2. Decodes the base64 data to binary
3. Saves the binary data as a local file in your configured folder, using an extension that matches the source MIME subtype when possible
4. Updates the links in your notes to point to the extracted local image files

This makes your notes smaller, more portable, and easier to work with.

The plugin does **not** transcode non-PNG images into PNG. For example:

- `data:image/png;base64,...` is written as `.png`
- `data:image/jpeg;base64,...` is written as `.jpg`
- `data:image/webp;base64,...` is written as `.webp`

If explicit transcoding is added later, it would need to be implemented as a separate processing step. The current behavior is to preserve the original image data exactly as provided in the note.

When auto-convert is enabled, the paste handler is optimized for pasted inline base64 image markdown. It inspects the clipboard payload first and only converts the newly inserted pasted range when that payload actually contains inline base64 image markdown.

## Output examples

The plugin can rewrite converted images using either Markdown image syntax or Obsidian wikilinks:

- **Markdown output**: `![alt](attachments/image-3f2a1c9b.png)`
- **Wikilink output**: `![[attachments/image-3f2a1c9b.png]]`
- **Wikilink with default size**: `![[attachments/image-3f2a1c9b.png|300]]`

Alt text is preserved only for Markdown output. In wikilink mode the plugin currently ignores alt text because Obsidian embeds do not expose a separate alt-text field in the generated syntax.



## Settings

### General Settings

- **Auto Convert**: Automatically convert pasted inline base64 image markdown, optimized to inspect pasted text first and avoid full-note rescans for ordinary paste operations
- **Output Folder**: Folder where extracted image files will be saved (relative to the note)
- **Filename Format**: Format for generated filenames with placeholders for date, index, and image type
- **Link Style**: Choose between Markdown image links and Obsidian wikilink embeds
- **Default Image Size**: Optional size used for wikilink embeds, such as `300` for `![[attachments/image.png|300]]`
- **Preserve Alt Text in Markdown**: Keep original alt text in Markdown output; wikilink mode ignores alt text for now

### File naming and extension behavior

- Generated filenames are sanitized so invalid path characters and awkward whitespace do not leak into output file names
- `{{type}}` is derived from the source MIME subtype and sanitized for filenames
- The plugin preserves the source file extension inferred from the base64 image MIME subtype; it does not force every file to `.png`
- A content hash is appended to each generated filename so repeated runs can reuse the same file when the embedded image data has not changed
- Notes stored at the vault root are supported; extracted files still resolve correctly into the configured output folder

### Link style behavior

- **Markdown image link**
  - Example output: `![Diagram](attachments/image-3f2a1c9b.png)`
  - Uses the original image alt text by default
  - Ignores the default image size setting
- **Obsidian wikilink embed**
  - Example output without size: `![[attachments/image-3f2a1c9b.png]]`
  - Example output with size: `![[attachments/image-3f2a1c9b.png|300]]`
  - Ignores alt text because wikilinks do not have a direct alt-text slot in this plugin yet

## Commands

- **Convert Base64 images to PNG for current file**: Process the currently active file
- **Convert Base64 images to PNG for all files**: Process all markdown files in the vault

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "Convert Base64 to PNG"
4. Click Install, then Enable

## Use Cases

- **Reduce File Size**: Base64-encoded images can make your markdown files very large
- **Improve Portability**: Local image files are more portable and can be used outside of Obsidian
- **Better Organization**: Keep your images in a dedicated folder instead of embedded in your notes
- **Easier Editing**: Smaller markdown files are easier to edit and work with

---

<div align="center">
  <p>If you find this plugin useful, consider supporting me:</p>
  <a href="https://www.buymeacoffee.com/xmasterdev" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;">
  </a>
  <p>or</p>
  <a href="https://ko-fi.com/nykkolin" target="_blank">
    <img src="https://img.shields.io/badge/Support%20me%20on-Ko--fi-blue?style=for-the-badge&logo=ko-fi" alt="Support me on Ko-fi">
  </a>
</div>
