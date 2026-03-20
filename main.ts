import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, base64ToArrayBuffer, normalizePath } from 'obsidian';

interface ConvertBase64ToPNGSettings {
	outputFolder: string;
	autoConvert: boolean;
	filenameFormat: string;
}

interface Base64ImageMatch {
	start: number;
	end: number;
	altText: string;
	mimeType: string;
	imageType: string;
	base64Payload: string;
	originalText: string;
}

type ConversionPhase = 'scan' | 'convert' | 'write' | 'complete';

interface ConversionProgress {
	phase: ConversionPhase;
	processedFiles: number;
	totalFiles: number;
	processedImages: number;
	totalImages: number;
	currentFile: string | null;
}

interface ConversionError {
	filePath: string;
	message: string;
	match?: Base64ImageMatch;
}

interface FileConversionResult {
	newContent: string;
	convertedCount: number;
	skippedCount: number;
	errors: ConversionError[];
	totalMatches: number;
}

interface FilesConversionResult {
	processedFiles: number;
	totalFiles: number;
	convertedCount: number;
	skippedCount: number;
	totalMatches: number;
	errors: ConversionError[];
}

const DEFAULT_SETTINGS: ConvertBase64ToPNGSettings = {
	outputFolder: 'attachments',
	autoConvert: false,
	filenameFormat: 'image-{{date}}-{{index}}'
};

const BASE64_IMAGE_REGEX = /!\[(.*?)\]\((data:(image\/([a-zA-Z0-9.+-]+));base64,([^)]+))\)/g;

class ConversionNoticeReporter {
	private notice: Notice | null = null;

	update(progress: ConversionProgress) {
		const message = this.formatProgress(progress);
		if (!this.notice) {
			this.notice = new Notice(message, 0);
			return;
		}

		this.notice.setMessage(message);
	}

	finish(message: string) {
		if (this.notice) {
			this.notice.hide();
			this.notice = null;
		}

		new Notice(message);
	}

	private formatProgress(progress: ConversionProgress): string {
		const fileLabel = progress.currentFile ? ` (${progress.currentFile})` : '';

		switch (progress.phase) {
			case 'scan':
				return `Scanning files ${progress.processedFiles}/${progress.totalFiles}${fileLabel}`;
			case 'convert':
				return `Converting images ${progress.processedImages}/${progress.totalImages}; files ${progress.processedFiles}/${progress.totalFiles}${fileLabel}`;
			case 'write':
				return `Writing updates for ${progress.currentFile ?? 'file'} (${progress.processedFiles}/${progress.totalFiles})`;
			case 'complete':
				return `Completed ${progress.processedFiles}/${progress.totalFiles} files and ${progress.processedImages}/${progress.totalImages} images`;
		}
	}
}

export default class ConvertBase64ToPNGPlugin extends Plugin {
	settings: ConvertBase64ToPNGSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'convert-base64-to-png-current-file',
			name: 'Convert Base64 images to PNG for current file',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.runCurrentFileConversion(editor, view.file);
			}
		});

		this.addCommand({
			id: 'convert-base64-to-png-all-files',
			name: 'Convert Base64 images to PNG for all files',
			callback: async () => {
				await this.runAllFilesConversion();
			}
		});

		this.addSettingTab(new ConvertBase64ToPNGSettingTab(this.app, this));

		if (this.settings.autoConvert) {
			this.registerEvent(
				this.app.workspace.on('editor-paste', (_: ClipboardEvent, editor: Editor) => {
					setTimeout(() => {
						const content = editor.getValue();
						if (this.containsBase64Image(content)) {
							void this.runCurrentFileConversion(editor, this.app.workspace.getActiveFile());
						}
					}, 100);
				})
			);
		}
	}

	onunload() {
		// Clean up any resources
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	containsBase64Image(content: string): boolean {
		return this.findBase64Images(content).length > 0;
	}

	findBase64Images(content: string): Base64ImageMatch[] {
		const matches: Base64ImageMatch[] = [];
		let match: RegExpExecArray | null;

		BASE64_IMAGE_REGEX.lastIndex = 0;
		while ((match = BASE64_IMAGE_REGEX.exec(content)) !== null) {
			matches.push({
				start: match.index,
				end: match.index + match[0].length,
				altText: match[1],
				mimeType: match[2],
				imageType: match[3],
				base64Payload: match[4],
				originalText: match[0]
			});
		}

		return matches;
	}

	async convertCurrentFileBase64ToPNG() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice('No active markdown file');
			return;
		}

		await this.runCurrentFileConversion(activeView.editor, activeView.file);
	}

	private async runCurrentFileConversion(editor: Editor, file: TFile | null) {
		if (!file) {
			new Notice('No file is currently open');
			return;
		}

		const reporter = new ConversionNoticeReporter();
		const result = await this.convertFiles([file], (progress) => reporter.update(progress), async ({ newContent }) => {
			editor.setValue(newContent);
		});

		reporter.finish(this.buildCompletionMessage(result, true));
	}

	private async runAllFilesConversion() {
		const files = this.app.vault.getMarkdownFiles();
		const reporter = new ConversionNoticeReporter();
		const result = await this.convertFiles(files, (progress) => reporter.update(progress));

		reporter.finish(this.buildCompletionMessage(result, false));
	}

	private buildCompletionMessage(result: FilesConversionResult, isCurrentFile: boolean): string {
		if (result.totalMatches === 0) {
			return isCurrentFile ? 'No base64 images found in the current file' : 'No base64 images found in markdown files';
		}

		const baseMessage = isCurrentFile
			? `Converted ${result.convertedCount} base64 image${result.convertedCount !== 1 ? 's' : ''}`
			: `Completed! Converted ${result.convertedCount} base64 image${result.convertedCount !== 1 ? 's' : ''} across ${result.totalFiles} file${result.totalFiles !== 1 ? 's' : ''}`;

		const details: string[] = [];
		if (result.skippedCount > 0) {
			details.push(`skipped ${result.skippedCount}`);
		}
		if (result.errors.length > 0) {
			details.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
		}

		return details.length > 0 ? `${baseMessage} (${details.join(', ')})` : baseMessage;
	}

	private async convertFiles(
		files: TFile[],
		onProgress: (progress: ConversionProgress) => void,
		onFileConverted?: (result: FileConversionResult, file: TFile) => Promise<void>
	): Promise<FilesConversionResult> {
		const fileEntries = await Promise.all(files.map(async (file) => {
			const content = await this.app.vault.read(file);
			const matches = this.findBase64Images(content);
			return { file, content, matches };
		}));

		const totalImages = fileEntries.reduce((sum, entry) => sum + entry.matches.length, 0);
		const totalFiles = files.length;
		let processedFiles = 0;
		let processedImages = 0;
		let convertedCount = 0;
		let skippedCount = 0;
		const errors: ConversionError[] = [];

		for (const entry of fileEntries) {
			onProgress({
				phase: 'scan',
				processedFiles,
				totalFiles,
				processedImages,
				totalImages,
				currentFile: entry.file.path
			});

			if (entry.matches.length === 0) {
				processedFiles++;
				continue;
			}

			const result = await this.convertMatchesInContent(entry.content, entry.file, this.settings, (progress) => {
				onProgress({
					...progress,
					processedFiles,
					totalFiles,
					processedImages: processedImages + progress.processedImages,
					totalImages,
					currentFile: entry.file.path
				});
			});

			if (result.convertedCount > 0) {
				onProgress({
					phase: 'write',
					processedFiles,
					totalFiles,
					processedImages: processedImages + result.convertedCount + result.skippedCount,
					totalImages,
					currentFile: entry.file.path
				});

				if (onFileConverted) {
					await onFileConverted(result, entry.file);
				} else {
					await this.app.vault.modify(entry.file, result.newContent);
				}
			}

			processedFiles++;
			processedImages += result.totalMatches;
			convertedCount += result.convertedCount;
			skippedCount += result.skippedCount;
			errors.push(...result.errors);
		}

		onProgress({
			phase: 'complete',
			processedFiles,
			totalFiles,
			processedImages,
			totalImages,
			currentFile: null
		});

		return {
			processedFiles,
			totalFiles,
			convertedCount,
			skippedCount,
			totalMatches: totalImages,
			errors
		};
	}

	private async convertMatchesInContent(
		content: string,
		file: TFile,
		settings: ConvertBase64ToPNGSettings,
		onProgress: (progress: ConversionProgress) => void
	): Promise<FileConversionResult> {
		const matches = this.findBase64Images(content);
		if (matches.length === 0) {
			return {
				newContent: content,
				convertedCount: 0,
				skippedCount: 0,
				errors: [],
				totalMatches: 0
			};
		}

		const outputFolderPath = this.getOutputFolderPath(file, settings.outputFolder);
		await this.ensureFolderExists(outputFolderPath);

		const replacements: Array<{ start: number; end: number; replacement: string }> = [];
		const errors: ConversionError[] = [];
		let convertedCount = 0;
		let skippedCount = 0;
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		for (let index = 0; index < matches.length; index++) {
			const match = matches[index];
			onProgress({
				phase: 'convert',
				processedFiles: 0,
				totalFiles: 0,
				processedImages: index,
				totalImages: matches.length,
				currentFile: file.path
			});

			try {
				const filename = this.buildImageFilename(settings.filenameFormat, timestamp, index + 1, match.imageType);
				const imagePath = normalizePath(`${outputFolderPath}/${filename}`);
				const relativeImagePath = normalizePath(`${settings.outputFolder}/${filename}`);
				const binaryData = base64ToArrayBuffer(match.base64Payload);

				await this.app.vault.adapter.writeBinary(imagePath, binaryData);
				replacements.push({
					start: match.start,
					end: match.end,
					replacement: `![${match.altText}](${relativeImagePath})`
				});
				convertedCount++;
			} catch (error) {
				skippedCount++;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Error converting image in file ${file.path}:`, error);
				errors.push({
					filePath: file.path,
					message,
					match
				});
			}
		}

		const newContent = this.applyReplacements(content, replacements);
		onProgress({
			phase: 'convert',
			processedFiles: 0,
			totalFiles: 0,
			processedImages: matches.length,
			totalImages: matches.length,
			currentFile: file.path
		});

		return {
			newContent,
			convertedCount,
			skippedCount,
			errors,
			totalMatches: matches.length
		};
	}

	private buildImageFilename(format: string, timestamp: string, index: number, imageType: string): string {
		return format
			.replace('{{date}}', timestamp)
			.replace('{{index}}', index.toString())
			.replace('{{type}}', imageType) + '.png';
	}

	private getOutputFolderPath(file: TFile, outputFolder: string): string {
		const lastSlashIndex = file.path.lastIndexOf('/');
		const fileDir = lastSlashIndex === -1 ? '' : file.path.substring(0, lastSlashIndex);
		return normalizePath(fileDir ? `${fileDir}/${outputFolder}` : outputFolder);
	}

	private async ensureFolderExists(folderPath: string) {
		if (await this.app.vault.adapter.exists(folderPath)) {
			return;
		}

		await this.app.vault.adapter.mkdir(folderPath);
	}

	private applyReplacements(content: string, replacements: Array<{ start: number; end: number; replacement: string }>): string {
		if (replacements.length === 0) {
			return content;
		}

		const orderedReplacements = [...replacements].sort((left, right) => left.start - right.start);
		let cursor = 0;
		let result = '';

		for (const replacement of orderedReplacements) {
			result += content.slice(cursor, replacement.start);
			result += replacement.replacement;
			cursor = replacement.end;
		}

		result += content.slice(cursor);
		return result;
	}
}

class ConvertBase64ToPNGSettingTab extends PluginSettingTab {
	plugin: ConvertBase64ToPNGPlugin;

	constructor(app: App, plugin: ConvertBase64ToPNGPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Output folder')
			.setDesc('Folder where PNG files will be saved (relative to the note)')
			.addText(text => text
				.setPlaceholder('attachments')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto convert')
			.setDesc('Automatically convert base64 images when pasting')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoConvert)
				.onChange(async (value) => {
					this.plugin.settings.autoConvert = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Filename format')
			.setDesc('Format for generated filenames. Available placeholders: {{date}}, {{index}}, {{type}}')
			.addText(text => text
				.setPlaceholder('image-{{date}}-{{index}}')
				.setValue(this.plugin.settings.filenameFormat)
				.onChange(async (value) => {
					this.plugin.settings.filenameFormat = value;
					await this.plugin.saveSettings();
				}));

		// Sponsor section
		containerEl.createEl('hr');

		const sponsorDiv = containerEl.createDiv('sponsor-container');

		const sponsorText = sponsorDiv.createDiv('sponsor-text');
		sponsorText.setText('If you like this Plugin, consider donating to support continued development.');

		const buttonsDiv = sponsorDiv.createDiv('sponsor-buttons');

		// Ko-fi button
		const kofiLink = buttonsDiv.createEl('a', {
			href: 'https://ko-fi.com/nykkolin'
		});
		kofiLink.setAttribute('target', '_blank');
		kofiLink.setAttribute('rel', 'noopener');

		// Embed SVG directly instead of using external file
		kofiLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="38" viewBox="0 0 82.25 28" role="img" aria-label="KO-FI" class="sponsor-image"><title>KO-FI</title><g shape-rendering="crispEdges"><rect width="82.25" height="28" fill="#f16061"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100"><image x="9" y="7" width="14" height="14" href="data:image/svg+xml;base64,PHN2ZyBmaWxsPSJ3aGl0ZSIgcm9sZT0iaW1nIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPktvLWZpPC90aXRsZT48cGF0aCBkPSJNMTEuMzUxIDIuNzE1Yy0yLjcgMC00Ljk4Ni4wMjUtNi44My4yNkMyLjA3OCAzLjI4NSAwIDUuMTU0IDAgOC42MWMwIDMuNTA2LjE4MiA2LjEzIDEuNTg1IDguNDkzIDEuNTg0IDIuNzAxIDQuMjMzIDQuMTgyIDcuNjYyIDQuMTgyaC44M2M0LjIwOSAwIDYuNDk0LTIuMjM0IDcuNjM3LTRhOS41IDkuNSAwIDAgMCAxLjA5MS0yLjMzOEMyMS43OTIgMTQuNjg4IDI0IDEyLjIyIDI0IDkuMjA4di0uNDE1YzAtMy4yNDctMi4xMy01LjUwNy01Ljc5Mi01Ljg3LTEuNTU4LS4xNTYtMi42NS0uMjA4LTYuODU3LS4yMDhtMCAxLjk0N2M0LjIwOCAwIDUuMDkuMDUyIDYuNTcxLjE4MiAyLjYyNC4zMTEgNC4xMyAxLjU4NCA0LjEzIDR2LjM5YzAgMi4xNTYtMS43OTIgMy44NDQtMy44NyAzLjg0NGgtLjkzNWwtLjE1Ni42NDljLS4yMDggMS4wMTMtLjU5NyAxLjgxOC0xLjAzOSAyLjU0Ni0uOTA5IDEuNDI4LTIuNTQ1IDMuMDY0LTUuOTIyIDMuMDY0aC0uODA1Yy0yLjU3MSAwLTQuODMxLS44ODMtNi4wNzgtMy4xOTUtMS4wOS0yLTEuMjk4LTQuMTU1LTEuMjk4LTcuNTA2IDAtMi4xODEuODU3LTMuNDAyIDMuMDEyLTMuNzE0IDEuNTMzLS4yMzMgMy41NTktLjI2IDYuMzktLjI2bTYuNTQ3IDIuMjg3Yy0uNDE2IDAtLjY1LjIzNC0uNjUuNTQ2djIuOTM1YzAgLjMxMS4yMzQuNTQ1LjY1LjU0NSAxLjMyNCAwIDIuMDUxLS43NTQgMi4wNTEtMnMtLjcyNy0yLjAyNi0yLjA1Mi0yLjAyNm0tMTAuMzkuMTgyYy0xLjgxOCAwLTMuMDEzIDEuNDgtMy4wMTMgMy4xNDIgMCAxLjUzMy44NTggMi44NTcgMS45NDkgMy44OTcuNzI3LjcwMSAxLjg3IDEuNDI5IDIuNjQ5IDEuODk2YTEuNDcgMS40NyAwIDAgMCAxLjUwNyAwYy43OC0uNDY3IDEuOTIyLTEuMTk1IDIuNjIzLTEuODk2IDEuMTE3LTEuMDM5IDEuOTc0LTIuMzY0IDEuOTc0LTMuODk3IDAtMS42NjItMS4yNDctMy4xNDItMy4wMzktMy4xNDItMS4wNjUgMC0xLjc5Mi41NDUtMi4zMzggMS4yOTgtLjQ5My0uNzUzLTEuMjQ2LTEuMjk4LTIuMzEyLTEuMjk4Ii8+PC9zdmc+"/><text transform="scale(.1)" x="511.25" y="175" textLength="382.5" fill="#fff" font-weight="bold">KO-FI</text></g></svg>`;

		// Buy Me a Coffee button
		const bmcLink = buttonsDiv.createEl('a', {
			href: 'https://www.buymeacoffee.com/xmasterdev'
		});
		bmcLink.setAttribute('target', '_blank');
		bmcLink.setAttribute('rel', 'noopener');

		// Embed SVG directly instead of using external file
		bmcLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="38" viewBox="0 0 217 60" class="sponsor-image">
  <!-- Background -->
  <rect width="217" height="60" rx="12" fill="#FFDD00"/>
  <!-- Coffee cup emoji -->
  <text x="19" y="42" font-size="30">☕️</text>
  <!-- "Buy me a coffee" text -->
  <text x="59" y="39" font-family="'Brush Script MT', 'Comic Sans MS', cursive" font-size="28" font-weight="normal" fill="#000000" font-style="italic">Buy me a coffee</text>
</svg>`;
	}
}
