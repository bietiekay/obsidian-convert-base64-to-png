import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, base64ToArrayBuffer, normalizePath } from 'obsidian';

interface ConvertBase64ToPNGSettings {
	outputFolder: string;
	autoConvert: boolean;
	filenameFormat: string;
	linkStyle: 'markdown' | 'wikilink';
	defaultImageSize: string;
	preserveAltText: boolean;
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

type ConversionPhase = 'scan' | 'convert' | 'write' | 'complete' | 'cancelled';

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
	changed: boolean;
}

interface FilesConversionResult {
	processedFiles: number;
	totalFiles: number;
	convertedCount: number;
	skippedCount: number;
	totalMatches: number;
	errors: ConversionError[];
	cancelled: boolean;
}

interface ScannedFileEntry {
	file: TFile;
	content: string;
	matches: Base64ImageMatch[];
	outputFolderPath: string;
	relativeOutputFolderPath: string;
	filenameMetadata: FileFilenameMetadata;
}

interface PendingFileWrite {
	file: TFile;
	result: FileConversionResult;
}

interface FileFilenameMetadata {
	readonly needsDate: boolean;
	getTimestamp(): string;
}

const DEFAULT_SETTINGS: ConvertBase64ToPNGSettings = {
	outputFolder: 'attachments',
	autoConvert: false,
	filenameFormat: 'image-{{date}}-{{index}}',
	linkStyle: 'markdown',
	defaultImageSize: '',
	preserveAltText: true
};

const BASE64_IMAGE_REGEX = /!\[(.*?)\]\((data:(image\/([a-zA-Z0-9.+-]+));base64,([^)]+))\)/g;
const DATE_PLACEHOLDER = '{{date}}';
const INDEX_PLACEHOLDER = '{{index}}';
const TYPE_PLACEHOLDER = '{{type}}';
const FINAL_STATUS_TIMEOUT_MS = 10000;

function normalizeImageSize(size?: string): string | undefined {
	const normalizedSize = size?.trim();
	return normalizedSize ? normalizedSize : undefined;
}

function formatImageReference(
	relativePath: string,
	altText: string,
	linkStyle: ConvertBase64ToPNGSettings['linkStyle'],
	size?: string,
	preserveAltText = true
): string {
	const normalizedPath = normalizePath(relativePath);
	const normalizedSize = normalizeImageSize(size);

	if (linkStyle === 'wikilink') {
		return normalizedSize ? `![[${normalizedPath}|${normalizedSize}]]` : `![[${normalizedPath}]]`;
	}

	const markdownAltText = preserveAltText ? altText : '';
	return `![${markdownAltText}](${normalizedPath})`;
}

class ConversionCancellationController {
	private cancellationRequested = false;

	requestCancel() {
		this.cancellationRequested = true;
	}

	get isCancellationRequested(): boolean {
		return this.cancellationRequested;
	}
}

class ConversionProgressDisplay {
	private readonly statusBarEl: HTMLElement;
	private readonly messageEl: HTMLSpanElement;
	private readonly cancelButtonEl: HTMLButtonElement | null;
	private finalStatusTimeoutId: number | null = null;
	private cancellationRequested = false;

	constructor(
		plugin: Plugin,
		private readonly options: {
			allowCancel: boolean;
			onCancel?: () => void;
			label: string;
		}
	) {
		this.statusBarEl = plugin.addStatusBarItem();
		this.statusBarEl.addClass('convert-base64-to-png-status');
		this.statusBarEl.style.display = 'flex';
		this.statusBarEl.style.alignItems = 'center';
		this.statusBarEl.style.gap = '0.5rem';

		this.messageEl = this.statusBarEl.createEl('span');
		this.messageEl.setText(`${this.options.label}: Preparing…`);

		if (this.options.allowCancel) {
			this.cancelButtonEl = this.statusBarEl.createEl('button', { text: 'Cancel' });
			this.cancelButtonEl.type = 'button';
			this.cancelButtonEl.addEventListener('click', () => {
				if (this.cancellationRequested) {
					return;
				}

				this.cancellationRequested = true;
				this.cancelButtonEl?.setText('Cancelling…');
				this.cancelButtonEl?.setAttribute('disabled', 'true');
				this.options.onCancel?.();
				this.renderSuffix();
			});
		} else {
			this.cancelButtonEl = null;
		}
	}

	update(progress: ConversionProgress) {
		this.clearFinalStatusTimeout();
		this.messageEl.setText(this.formatProgress(progress));
		this.renderSuffix();
	}

	finish(summary: string, cancelled: boolean) {
		this.clearFinalStatusTimeout();
		this.messageEl.setText(summary);

		if (this.cancelButtonEl) {
			if (cancelled) {
				this.cancelButtonEl.setText('Cancelled');
			} else {
				this.cancelButtonEl.setText('Done');
			}
			this.cancelButtonEl.setAttribute('disabled', 'true');
		}

		this.finalStatusTimeoutId = window.setTimeout(() => {
			this.destroy();
		}, FINAL_STATUS_TIMEOUT_MS);
	}

	destroy() {
		this.clearFinalStatusTimeout();
		this.statusBarEl.remove();
	}

	private renderSuffix() {
		if (!this.cancellationRequested) {
			return;
		}

		const currentText = this.messageEl.getText();
		if (!currentText.includes('Stopping after current file…')) {
			this.messageEl.setText(`${currentText} • Stopping after current file…`);
		}
	}

	private clearFinalStatusTimeout() {
		if (this.finalStatusTimeoutId !== null) {
			window.clearTimeout(this.finalStatusTimeoutId);
			this.finalStatusTimeoutId = null;
		}
	}

	private formatProgress(progress: ConversionProgress): string {
		const fileSummary = `files ${progress.processedFiles}/${progress.totalFiles}`;
		const imageSummary = `images ${progress.processedImages}/${progress.totalImages}`;
		const currentFile = progress.currentFile ? ` • ${progress.currentFile}` : '';

		switch (progress.phase) {
			case 'scan':
				return `${this.options.label}: Scanning… • ${fileSummary} • ${imageSummary}${currentFile}`;
			case 'convert':
				return `${this.options.label}: Converting… • ${fileSummary} • ${imageSummary}${currentFile}`;
			case 'write':
				return `${this.options.label}: Saving… • ${fileSummary} • ${imageSummary}${currentFile}`;
			case 'complete':
				return `${this.options.label}: Complete • ${fileSummary} • ${imageSummary}${currentFile}`;
			case 'cancelled':
				return `${this.options.label}: Cancelled • ${fileSummary} • ${imageSummary}${currentFile}`;
		}
	}
}

export default class ConvertBase64ToPNGPlugin extends Plugin {
	settings: ConvertBase64ToPNGSettings;
	private isHandlingPasteConversion = false;

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

		this.registerEvent(
			this.app.workspace.on('editor-paste', (event: ClipboardEvent, editor: Editor, info: MarkdownView) => {
				void this.handleEditorPaste(event, editor, info);
			})
		);
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

	private async handleEditorPaste(event: ClipboardEvent, editor: Editor, info: MarkdownView) {
		if (!this.settings.autoConvert || this.isHandlingPasteConversion) {
			return;
		}

		const file = info.file ?? this.app.workspace.getActiveFile();
		if (!file) {
			return;
		}

		const pastedText = this.getPastedText(event);
		if (!pastedText || !this.containsBase64Image(pastedText)) {
			return;
		}

		const selectionStart = editor.getCursor('from');
		const selectionEnd = editor.getCursor('to');
		const selectionStartOffset = editor.posToOffset(selectionStart);
		const selectionEndOffset = editor.posToOffset(selectionEnd);
		const previousContent = editor.getValue();

		window.setTimeout(() => {
			void this.convertPastedRangeIfNeeded(editor, file, previousContent, selectionStartOffset, selectionEndOffset);
		}, 0);
	}

	private getPastedText(event: ClipboardEvent): string {
		const clipboardData = event.clipboardData;
		if (!clipboardData) {
			return '';
		}

		return clipboardData.getData('text/plain')
			|| clipboardData.getData('text/markdown')
			|| clipboardData.getData('text/html')
			|| '';
	}

	private async convertPastedRangeIfNeeded(
		editor: Editor,
		file: TFile,
		previousContent: string,
		selectionStartOffset: number,
		selectionEndOffset: number
	) {
		const currentContent = editor.getValue();
		const insertedRange = this.getInsertedRange(previousContent, currentContent, selectionStartOffset, selectionEndOffset);
		if (!insertedRange) {
			return;
		}

		const pastedContent = currentContent.slice(insertedRange.start, insertedRange.end);
		const matches = this.findBase64Images(pastedContent);
		if (matches.length === 0) {
			return;
		}

		this.isHandlingPasteConversion = true;
		const display = new ConversionProgressDisplay(this, {
			allowCancel: false,
			label: 'Base64 → PNG'
		});

		try {
			const result = await this.convertMatchesInContent(
				this.createScannedFileEntry(file, pastedContent, matches),
				this.settings,
				new Map<string, Promise<void>>(),
				(progress) => display.update(progress)
			);

			if (!result.changed) {
				display.finish('No base64 images found in pasted content', false);
				return;
			}

			const rangeStart = editor.offsetToPos(insertedRange.start);
			const rangeEnd = editor.offsetToPos(insertedRange.end);
			editor.replaceRange(result.newContent, rangeStart, rangeEnd);

			const summary = `Converted ${result.convertedCount} pasted base64 image${result.convertedCount !== 1 ? 's' : ''} (${result.skippedCount} skipped, ${result.errors.length} failed)`;
			display.finish(summary, false);
			new Notice(summary);
		} catch (error) {
			display.destroy();
			throw error;
		} finally {
			this.isHandlingPasteConversion = false;
		}
	}

	private getInsertedRange(
		previousContent: string,
		currentContent: string,
		selectionStartOffset: number,
		selectionEndOffset: number
	): { start: number; end: number } | null {
		const replacedLength = selectionEndOffset - selectionStartOffset;
		const insertedLength = currentContent.length - (previousContent.length - replacedLength);
		if (insertedLength <= 0) {
			return null;
		}

		const start = selectionStartOffset;
		const end = selectionStartOffset + insertedLength;
		if (start < 0 || end > currentContent.length) {
			return null;
		}

		return { start, end };
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

		const display = new ConversionProgressDisplay(this, {
			allowCancel: false,
			label: 'Base64 → PNG'
		});

		try {
			const result = await this.convertFiles([file], (progress) => display.update(progress), async ({ newContent }, writtenFile) => {
				if (this.app.workspace.getActiveFile()?.path === writtenFile.path) {
					editor.setValue(newContent);
				}
			});

			const summary = this.buildCompletionMessage(result, true);
			display.finish(summary, result.cancelled);
			new Notice(summary);
		} catch (error) {
			display.destroy();
			throw error;
		}
	}

	private async runAllFilesConversion() {
		const files = this.app.vault.getMarkdownFiles();
		const cancellationController = new ConversionCancellationController();
		const display = new ConversionProgressDisplay(this, {
			allowCancel: true,
			onCancel: () => cancellationController.requestCancel(),
			label: 'Base64 → PNG'
		});

		try {
			const result = await this.convertFiles(files, (progress) => display.update(progress), undefined, cancellationController);
			const summary = this.buildCompletionMessage(result, false);
			display.finish(summary, result.cancelled);
			new Notice(summary);
		} catch (error) {
			display.destroy();
			throw error;
		}
	}

	private buildCompletionMessage(result: FilesConversionResult, isCurrentFile: boolean): string {
		if (result.totalMatches === 0) {
			if (result.cancelled) {
				return isCurrentFile
					? 'Conversion cancelled before any base64 images were processed'
					: `Vault-wide conversion cancelled after scanning ${result.processedFiles}/${result.totalFiles} files; no base64 images were processed`;
			}

			return isCurrentFile ? 'No base64 images found in the current file' : 'No base64 images found in markdown files';
		}

		const failedImageCount = result.errors.length;
		const failedFileCount = new Set(result.errors.map((error) => error.filePath)).size;
		const baseMessage = result.cancelled
			? `Conversion cancelled after processing ${result.processedFiles}/${result.totalFiles} file${result.totalFiles !== 1 ? 's' : ''}`
			: isCurrentFile
				? `Converted ${result.convertedCount} base64 image${result.convertedCount !== 1 ? 's' : ''} in the current file`
				: `Completed vault-wide conversion across ${result.processedFiles}/${result.totalFiles} file${result.totalFiles !== 1 ? 's' : ''}`;

		const details = [
			`${result.convertedCount} converted image${result.convertedCount !== 1 ? 's' : ''}`,
			`${result.skippedCount} skipped image${result.skippedCount !== 1 ? 's' : ''}`,
			`${failedImageCount} failed image${failedImageCount !== 1 ? 's' : ''}`,
			`${failedFileCount} failed file${failedFileCount !== 1 ? 's' : ''}`
		];

		return `${baseMessage} (${details.join(', ')})`;
	}

	private async convertFiles(
		files: TFile[],
		onProgress: (progress: ConversionProgress) => void,
		onFileConverted?: (result: FileConversionResult, file: TFile) => Promise<void>,
		cancellationController?: ConversionCancellationController
	): Promise<FilesConversionResult> {
		const totalFiles = files.length;
		const scannedEntries: ScannedFileEntry[] = [];
		let scannedFiles = 0;

		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			onProgress({
				phase: 'scan',
				processedFiles: index,
				totalFiles,
				processedImages: 0,
				totalImages: 0,
				currentFile: file.path
			});

			const content = await this.app.vault.read(file);
			const matches = this.findBase64Images(content);
			if (matches.length > 0) {
				scannedEntries.push(this.createScannedFileEntry(file, content, matches));
			}

			scannedFiles = index + 1;
			if (cancellationController?.isCancellationRequested) {
				break;
			}
		}

		const totalImages = scannedEntries.reduce((sum, entry) => sum + entry.matches.length, 0);
		onProgress({
			phase: cancellationController?.isCancellationRequested ? 'cancelled' : 'scan',
			processedFiles: scannedFiles,
			totalFiles,
			processedImages: 0,
			totalImages,
			currentFile: null
		});

		let processedFiles = 0;
		let processedImages = 0;
		let convertedCount = 0;
		let skippedCount = 0;
		const errors: ConversionError[] = [];
		const folderCache = new Map<string, Promise<void>>();
		const pendingWrites: PendingFileWrite[] = [];
		let cancelled = cancellationController?.isCancellationRequested ?? false;

		for (const entry of scannedEntries) {
			const result = await this.convertMatchesInContent(entry, this.settings, folderCache, (progress) => {
				onProgress({
					...progress,
					processedFiles,
					totalFiles,
					processedImages: processedImages + progress.processedImages,
					totalImages,
					currentFile: entry.file.path
				});
			});

			if (result.changed) {
				pendingWrites.push({
					file: entry.file,
					result
				});
			}

			processedFiles++;
			processedImages += result.totalMatches;
			convertedCount += result.convertedCount;
			skippedCount += result.skippedCount;
			errors.push(...result.errors);

			if (cancellationController?.isCancellationRequested) {
				cancelled = true;
				break;
			}
		}

		for (let index = 0; index < pendingWrites.length; index++) {
			const pendingWrite = pendingWrites[index];
			onProgress({
				phase: 'write',
				processedFiles,
				totalFiles,
				processedImages,
				totalImages,
				currentFile: pendingWrite.file.path
			});

			await this.app.vault.modify(pendingWrite.file, pendingWrite.result.newContent);
			if (onFileConverted) {
				await onFileConverted(pendingWrite.result, pendingWrite.file);
			}
		}

		onProgress({
			phase: cancelled ? 'cancelled' : 'complete',
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
			errors,
			cancelled
		};
	}

	private createScannedFileEntry(file: TFile, content: string, matches: Base64ImageMatch[]): ScannedFileEntry {
		return {
			file,
			content,
			matches,
			outputFolderPath: this.getOutputFolderPath(file, this.settings.outputFolder),
			relativeOutputFolderPath: this.getRelativeOutputFolderPath(this.settings.outputFolder),
			filenameMetadata: this.createFilenameMetadata(this.settings.filenameFormat)
		};
	}

	private async convertMatchesInContent(
		entry: ScannedFileEntry,
		settings: ConvertBase64ToPNGSettings,
		folderCache: Map<string, Promise<void>>,
		onProgress: (progress: ConversionProgress) => void
	): Promise<FileConversionResult> {
		const { content, file, matches, outputFolderPath, relativeOutputFolderPath, filenameMetadata } = entry;
		if (matches.length === 0) {
			return {
				newContent: content,
				convertedCount: 0,
				skippedCount: 0,
				errors: [],
				totalMatches: 0,
				changed: false
			};
		}

		await this.ensureFolderExistsCached(outputFolderPath, folderCache);

		const replacements: Array<{ start: number; end: number; replacement: string }> = [];
		const errors: ConversionError[] = [];
		let convertedCount = 0;
		let skippedCount = 0;

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
				const filename = await this.createUniqueImageFilename(
					outputFolderPath,
					settings.filenameFormat,
					filenameMetadata,
					index + 1,
					match
				);
				const imagePath = normalizePath(`${outputFolderPath}/${filename}`);
				const relativeImagePath = normalizePath(`${relativeOutputFolderPath}/${filename}`);
				const binaryData = base64ToArrayBuffer(match.base64Payload);

				await this.app.vault.adapter.writeBinary(imagePath, binaryData);
				replacements.push({
					start: match.start,
					end: match.end,
					replacement: formatImageReference(
						relativeImagePath,
						match.altText,
						settings.linkStyle,
						settings.defaultImageSize,
						settings.preserveAltText
					)
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
			totalMatches: matches.length,
			changed: replacements.length > 0
		};
	}

	private buildImageFilename(format: string, timestamp: string | null, index: number, imageType: string): string {
		return format
			.split(DATE_PLACEHOLDER).join(timestamp ?? '')
			.split(INDEX_PLACEHOLDER).join(index.toString())
			.split(TYPE_PLACEHOLDER).join(imageType) + '.png';
	}

	private createFilenameMetadata(format: string): FileFilenameMetadata {
		let timestamp: string | null = null;
		const needsDate = format.includes(DATE_PLACEHOLDER);

		return {
			needsDate,
			getTimestamp: () => {
				if (!needsDate) {
					return '';
				}

				if (!timestamp) {
					timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				}

				return timestamp;
			}
		};
	}

	private getOutputFolderPath(file: TFile, outputFolder: string): string {
		const lastSlashIndex = file.path.lastIndexOf('/');
		const fileDir = lastSlashIndex === -1 ? '' : file.path.substring(0, lastSlashIndex);
		return normalizePath(fileDir ? `${fileDir}/${outputFolder}` : outputFolder);
	}

	private getRelativeOutputFolderPath(outputFolder: string): string {
		return normalizePath(outputFolder);
	}

	private async ensureFolderExistsCached(folderPath: string, folderCache: Map<string, Promise<void>>) {
		const existingOperation = folderCache.get(folderPath);
		if (existingOperation) {
			await existingOperation;
			return;
		}

		const operation = this.ensureFolderExists(folderPath);
		folderCache.set(folderPath, operation);
		await operation;
	}

	private async ensureFolderExists(folderPath: string) {
		if (await this.app.vault.adapter.exists(folderPath)) {
			return;
		}

		await this.app.vault.adapter.mkdir(folderPath);
	}

	private async createUniqueImageFilename(
		outputFolderPath: string,
		format: string,
		filenameMetadata: FileFilenameMetadata,
		index: number,
		match: Base64ImageMatch
	): Promise<string> {
		const timestamp = filenameMetadata.needsDate ? filenameMetadata.getTimestamp() : null;
		const baseFilename = this.buildImageFilename(format, timestamp, index, match.imageType);
		const contentHash = this.computeContentHash(match.base64Payload);
		const filenameWithHash = this.appendFilenameSuffix(baseFilename, contentHash);

		if (!(await this.app.vault.adapter.exists(normalizePath(`${outputFolderPath}/${filenameWithHash}`)))) {
			return filenameWithHash;
		}

		let attempt = 2;
		while (true) {
			const candidateFilename = this.appendFilenameSuffix(baseFilename, `${contentHash}-${attempt}`);
			const candidatePath = normalizePath(`${outputFolderPath}/${candidateFilename}`);
			if (!(await this.app.vault.adapter.exists(candidatePath))) {
				return candidateFilename;
			}
			attempt++;
		}
	}

	private appendFilenameSuffix(filename: string, suffix: string): string {
		const extensionIndex = filename.lastIndexOf('.');
		if (extensionIndex === -1) {
			return `${filename}-${suffix}`;
		}

		return `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`;
	}

	private computeContentHash(base64Payload: string): string {
		let hash = 2166136261;
		for (let index = 0; index < base64Payload.length; index++) {
			hash ^= base64Payload.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}

		return (hash >>> 0).toString(16).padStart(8, '0');
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
			.setDesc('Automatically convert pasted inline base64 image markdown, scanning the pasted text first so regular paste operations do not trigger a full-note rescan.')
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

		new Setting(containerEl)
			.setName('Link style')
			.setDesc('Choose how converted images are written. Markdown keeps optional alt text as `![alt](attachments/image.png)`. Wikilink uses Obsidian embeds such as `![[attachments/image.png]]` or `![[attachments/image.png|300]]`.')
			.addDropdown(dropdown => dropdown
				.addOption('markdown', 'Markdown image link')
				.addOption('wikilink', 'Obsidian wikilink embed')
				.setValue(this.plugin.settings.linkStyle)
				.onChange(async (value: 'markdown' | 'wikilink') => {
					this.plugin.settings.linkStyle = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Default image size')
			.setDesc('Optional size suffix for wikilink output, for example `300` to generate `![[attachments/image.png|300]]`. Leave blank to omit size. This setting is ignored for Markdown links because standard Markdown image syntax has no built-in size field.')
			.addText(text => text
				.setPlaceholder('300')
				.setValue(this.plugin.settings.defaultImageSize)
				.onChange(async (value) => {
					this.plugin.settings.defaultImageSize = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Preserve alt text in Markdown')
			.setDesc('When enabled, Markdown output keeps the original alt text as `![alt](attachments/image.png)`. Wikilink mode currently ignores alt text because Obsidian embeds do not have a separate alt-text field.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.preserveAltText)
				.setDisabled(this.plugin.settings.linkStyle !== 'markdown')
				.onChange(async (value) => {
					this.plugin.settings.preserveAltText = value;
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
