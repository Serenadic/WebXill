import * as Tone from "https://esm.sh/tone";
let conversationHistory = [];

const API_KEY = "AIzaSyDidXkE3gQLGlY9hBu8FKOyRw_X-euykGM";
const GEMINI_API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
const POLLINATIONS_AI_IMAGE_API_ENDPOINT = `https://image.pollinations.ai/prompt/`;

const chatBox = document.getElementById("chat-box");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const historyBtn = document.getElementById("history-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const historyPanel = document.getElementById("history-panel");
const chatList = document.getElementById("chat-list");
const closeHistoryBtn = document.getElementById("close-history-btn");

const fileInput = document.getElementById("file-input");
const selectedFilesDisplay = document.getElementById("selected-files-display");
let selectedFiles = [];
const CHATS_STORAGE_KEY = "gemini_chat_history";
let currentChatId = null;

const MAX_INPUT_HEIGHT = 200;

let isWaitingForToolExecution = false;
let currentStatusMessageElement = null;
let lastUserMessageText = "";

const SAMPLE_RATE = 44100;

class PerlinNoise {
	constructor(seed = 1) {
		this.p = new Array(512);
		this.permutation = new Array(256);
		for (let i = 0; i < 256; i++) {
			seed = (seed * 9301 + 49297) % 233280;
			this.permutation[i] = Math.floor((seed / 233280.0) * 256);
		}
		for (let i = 0; i < 512; i++) {
			this.p[i] = this.permutation[i % 256];
		}
	}
	fade(t) {
		return t * t * t * (t * (t * 6 - 15) + 10);
	}
	grad(hash, x) {
		hash = hash & 15;
		const grad = 1 + (hash & 7);
		if (hash & 8) return -grad * x;
		return grad * x;
	}
	noise(x) {
		let X = Math.floor(x) & 255;
		x -= Math.floor(x);
		let u = this.fade(x);
		let A = this.p[X],
			B = this.p[X + 1];
		let hA = A & 15;
		let hB = B & 15;
		let gA = this.grad(hA, x);
		let gB = this.grad(hB, x - 1);
		return (1 - u) * gA + u * gB;
	}
}
const noiseGenerator = new PerlinNoise(42);

function writeString(view, offset, string) {
	for (let i = 0; i < string.length; i++) {
		view.setUint8(offset + i, string.charCodeAt(i));
	}
}
function writeInt(view, offset, i) {
	view.setUint32(offset, i, true);
}
function writeShort(view, offset, i) {
	view.setUint16(offset, i, true);
}

function bufferToWave(audioBuffer) {
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length * numChannels * 2 + 44;
	const buffer = new ArrayBuffer(length);
	const view = new DataView(buffer);
	const data = [];

	for (let channel = 0; channel < numChannels; channel++) {
		data.push(audioBuffer.getChannelData(channel));
	}

	let offset = 0;
	const sampleRate = audioBuffer.sampleRate;
	const bitsPerSample = 16;
	const blockAlign = (bitsPerSample / 8) * numChannels;
	const byteRate = sampleRate * blockAlign;

	writeString(view, offset, "RIFF");
	offset += 4;
	writeInt(view, offset, length - 8);
	offset += 4;
	writeString(view, offset, "WAVE");
	offset += 4;

	writeString(view, offset, "fmt ");
	offset += 4;
	writeInt(view, offset, 16);
	offset += 4;
	writeShort(view, offset, 1);
	offset += 2;
	writeShort(view, offset, numChannels);
	offset += 2;
	writeInt(view, offset, sampleRate);
	offset += 4;
	writeInt(view, offset, byteRate);
	offset += 4;
	writeShort(view, offset, blockAlign);
	offset += 2;
	writeShort(view, offset, bitsPerSample);
	offset += 2;

	writeString(view, offset, "data");
	offset += 4;
	writeInt(view, offset, audioBuffer.length * numChannels * 2);
	offset += 4;

	for (let i = 0; i < audioBuffer.length; i++) {
		for (let channel = 0; channel < numChannels; channel++) {
			let sample = data[channel][i];
			let intSample = Math.max(-1, Math.min(1, sample)) * 32767;
			view.setInt16(offset, intSample, true);
			offset += 2;
		}
	}
	return new Blob([view], { type: "audio/wav" });
}

function calculateDurationFromMusicData(musicData) {
	const tempo = musicData.tempo || 120;
	const measureDurationSeconds = (60 / tempo) * 4;
	let totalDurationSeconds = 0;

	const phrases = {};
	if (musicData.phrases_list) {
		musicData.phrases_list.forEach((phrase) => {
			phrases[phrase.phrase_name] = phrase;
		});
	}

	musicData.structure.forEach((phraseName) => {
		const phraseConfig = phrases[phraseName];
		if (phraseConfig) {
			const phraseDurationMeasures = phraseConfig.duration_measures || 4;
			totalDurationSeconds += measureDurationSeconds * phraseDurationMeasures;
		}
	});

	return totalDurationSeconds;
}

function getPhraseDetails(musicData) {
	const phrases = {};
	if (musicData.phrases_list) {
		musicData.phrases_list.forEach((phrase) => {
			phrases[phrase.phrase_name] = phrase;
		});
	}
	const tempo = musicData.tempo || 120;
	const measureDurationSeconds = (60 / tempo) * 4;
	return { phrases, measureDurationSeconds };
}

function schedulePhraseContent(musicData, phraseConfig, phraseIndex, context) {
	Tone.setContext(context);
	const transport = context.transport;
	transport.bpm.value = musicData.tempo || 120;
	transport.loop = false;
	transport.clear();

	const instruments = {};
	const measureDurationSeconds = (60 / musicData.tempo) * 4;
	const phraseDurationMeasures = phraseConfig.duration_measures || 4;
	const phraseDurationSeconds = measureDurationSeconds * phraseDurationMeasures;

	const reverb = new Tone.Reverb({
		decay: musicData.master_reverb_decay || 2.5,
		wet: 0.3
	}).toDestination();
	const delay = new Tone.FeedbackDelay({
		delayTime: "8n",
		feedback: 0.2,
		wet: 0.2
	}).connect(reverb);
	const masterGain = new Tone.Gain(0.9).connect(delay);

	musicData.instruments.forEach((instConfig) => {
		let instrument;
		const InstrumentConstructor = Tone[instConfig.type];
		const options = instConfig.options || {};

		try {
			if (
				InstrumentConstructor &&
				["Synth", "AMSynth", "FMSynth", "MembraneSynth"].includes(instConfig.type)
			) {
				instrument = new Tone.PolySynth(InstrumentConstructor, options);
			} else if (instConfig.type === "Sampler") {
				instrument = new Tone.PolySynth(Tone.Synth, options);
			} else {
				instrument = new Tone.PolySynth(Tone.Synth, options);
			}
		} catch (e) {
			console.error(
				`Error creating Tone instrument '${instConfig.name}' (${instConfig.type}):`,
				e
			);
			instrument = null;
		}
		if (!instrument) return;

		const pitchDriftLFO = new Tone.LFO({
			frequency: Math.random() * 0.5 + 0.1,
			amplitude: Math.random() * 0.005 + 0.005
		}).start();
		if (instrument.detune) {
			pitchDriftLFO.connect(instrument.detune);
		}

		const filter = new Tone.Filter({
			type: "lowpass",
			frequency: 8000,
			rolloff: -12
		}).connect(masterGain);
		instrument.connect(filter);

		let lfoFreq = 0.5,
			lfoDepth = 3000;
		if (instConfig.name.toLowerCase().includes("bass")) {
			(lfoFreq = 0.2), (lfoDepth = 1500);
		} else if (instConfig.name.toLowerCase().includes("lead")) {
			(lfoFreq = 2.0), (lfoDepth = 5000);
		}

		const filterLFO = new Tone.LFO({
			type: "sine",
			frequency: lfoFreq,
			amplitude: 1
		}).start();
		filterLFO.min = filter.frequency.value - lfoDepth;
		filterLFO.max = filter.frequency.value + lfoDepth;
		filterLFO.connect(filter.frequency);

		instruments[instConfig.name] = {
			instrument,
			pitchDriftLFO,
			filter,
			filterLFO
		};
	});

	let currentTime = 0;
	const patternStartMeasure = phraseIndex * phraseDurationMeasures;

	phraseConfig.patterns.forEach((pattern, patternIndex) => {
		const instrumentPair = instruments[pattern.instrument_name];
		if (!instrumentPair) return;
		const { instrument } = instrumentPair;
		if (!Array.isArray(pattern.sequence) || pattern.sequence.length === 0) return;

		const noiseDepth = pattern.noise_modulation_depth || 0.1;
		const noiseSpeed = 0.05 + patternStartMeasure * 0.01 + patternIndex * 0.01;
		const stepsPerLoop = pattern.sequence.length;
		const subdivision = pattern.subdivision || "8n";
		const patternLoopDuration = Tone.Time(subdivision).toSeconds() * stepsPerLoop;
		const numLoops = Math.ceil(phraseDurationSeconds / patternLoopDuration);
		const maxJitterSeconds = Tone.Time(subdivision).toSeconds() * 0.1;

		for (let loop = 0; loop < numLoops; loop++) {
			const loopStartTime = loop * patternLoopDuration;
			if (loopStartTime < phraseDurationSeconds) {
				pattern.sequence.forEach((note, noteIndex) => {
					if (note === null || note === "rest" || note === 0 || note === "null")
						return;
					const baseNoteTime =
						loopStartTime + noteIndex * Tone.Time(subdivision).toSeconds();
					if (baseNoteTime >= phraseDurationSeconds) return;

					const jitter = (Math.random() - 0.5) * maxJitterSeconds;
					const noteTime = baseNoteTime + jitter;

					transport.schedule((time) => {
						const noiseValue = noiseGenerator.noise(time * noiseSpeed);
						let velocity = 0.8 + noiseValue * noiseDepth;
						velocity = Math.min(1.0, Math.max(0.2, velocity));
						instrument.triggerAttackRelease(
							note,
							pattern.note_duration || subdivision,
							time,
							velocity
						);
					}, noteTime);
				});
			}
		}
	});

	transport.stop(phraseDurationSeconds);
	transport.start(0);
	return masterGain;
}

async function renderPhraseByPhrase(musicData, totalDuration, updateCallback) {
	const { phrases, measureDurationSeconds } = getPhraseDetails(musicData);
	const allBuffers = [];
	let cumulativeDurationSeconds = 0;
	const FADE_TIME = 3.0;

	for (let i = 0; i < musicData.structure.length; i++) {
		const phraseName = musicData.structure[i];
		const phraseConfig = phrases[phraseName];
		if (!phraseConfig) continue;

		const phraseDurationMeasures = phraseConfig.duration_measures || 4;
		const phraseDurationSeconds = measureDurationSeconds * phraseDurationMeasures;
		if (cumulativeDurationSeconds >= totalDuration) break;

		const renderDuration = Math.min(
			phraseDurationSeconds,
			totalDuration - cumulativeDurationSeconds
		);
		if (renderDuration <= 0) break;

		updateCallback(
			`Rendering Phrase ${i + 1}/${
				musicData.structure.length
			}: **${phraseName}**...`
		);

		const phraseContext = new Tone.OfflineContext(2, renderDuration, SAMPLE_RATE);
		const masterGain = schedulePhraseContent(
			musicData,
			phraseConfig,
			i,
			phraseContext
		);

		if (
			i === musicData.structure.length - 1 ||
			cumulativeDurationSeconds + renderDuration >= totalDuration - FADE_TIME
		) {
			const fadeStart = renderDuration - FADE_TIME;
			if (fadeStart > 0) {
				masterGain.gain.exponentialRampTo(0.0001, FADE_TIME, fadeStart);
			}
		}

		const phraseBuffer = await phraseContext.render();
		allBuffers.push(phraseBuffer);
		cumulativeDurationSeconds += renderDuration;
	}

	const actualTotalSamples = Math.floor(cumulativeDurationSeconds * SAMPLE_RATE);
	const finalBuffer = Tone.context.createBuffer(
		2,
		actualTotalSamples,
		SAMPLE_RATE
	);
	let offset = 0;
	allBuffers.forEach((buffer) => {
		const samplesToCopy = buffer.length;
		finalBuffer.copyToChannel(buffer.getChannelData(0), 0, offset);
		finalBuffer.copyToChannel(buffer.getChannelData(1), 1, offset);
		offset += samplesToCopy;
	});

	return finalBuffer;
}

async function getMusicJson(prompt) {
	let systemPrompt = `
        You are a **masterful, creative, and thematic AI Music Composer** and Orchestrator.
        Your task is to analyze the user's request and generate a single, complete, executable JSON configuration for a structured song that can be rendered by Tone.js.
        
        **PRIMARY GOAL: Thematically Cohesive and High-Quality Music.**
        1. **Analyze the Prompt Deeply:** Select instruments, sounds, keys, tempos, and musical complexity that are **cool, modern, suitable**, and directly reflect the **specific theme, mood, or genre** requested in the user's prompt (e.g., "Cyberpunk", "Chill Lo-Fi", "Epic Orchestral").
        2. **Advanced Voice Leading & Voicing:** Ensure smooth, professional voice leading in all harmonic parts by prioritizing **stepwise motion** and **common-tone retention** between chords. Use **chord inversions** (different note orders) to minimize the distance each individual voice/note moves between chords.
        3. **Rhythmic Sophistication (Anti-Quantization):** Avoid monotonous, robotically quantized rhythms. Introduce rhythmic variation by occasionally using dotted notes, syncopation, triplets, or sequences of mixed subdivisions (\`8n\`, \`16n\`) to create groove and feel.
        4. **Thematic Development & Motifs:** The music must evolve. When a pattern repeats in a later phrase, apply **thematic variation** through slight changes in rhythm, interval, transposition, or timbre.
        5. **Dynamic and Timbral Evolution:** Control the overall texture. Phrases should build or reduce intensity by strategically adding or removing instrumental layers.
        6. **Dynamic Structure:** Use the 'structure' array to sequence at least four **different** phrase types (e.g., Intro, Verse, Chorus, Bridge, Outro) and repeat them in a **non-linear, evolving** way (e.g., [Intro, Verse, Chorus, Verse, Bridge, Chorus, Outro]).

        **CRITICAL RULES:**
        1. You MUST generate **ONLY** a valid JSON object. Do not include any text or markdown formatting outside of the JSON block.
        2. Instrument types MUST be one of: 'Synth', 'AMSynth', 'FMSynth', 'MembraneSynth', 'Sampler'.
        3. For any instrument options, the 'oscillator.type' must be one of the standard types: 'sine', 'square', 'triangle', or 'sawtooth'. DO NOT use 'noise' as an oscillator type.
        4. Use standard musical note notation (e.g., 'C4', 'D#3', 'A5'). Use 'rest', '0', or 'null' for silence. Chords must be arrays of notes (e.g., ["C4", "E4", "G4"]).
        5. The final rendered music MUST NOT EXCEED 5 MINUTES of length.`;

	const payload = {
		contents: [{ parts: [{ text: prompt }] }],
		systemInstruction: { parts: [{ text: systemPrompt }] },
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: {
				type: "OBJECT",
				properties: {
					tempo: { type: "NUMBER" },
					master_reverb_decay: { type: "NUMBER" },
					structure: { type: "ARRAY", items: { type: "STRING" } },
					instruments: {
						type: "ARRAY",
						items: {
							type: "OBJECT",
							properties: {
								name: { type: "STRING" },
								type: {
									type: "STRING",
									enum: ["Synth", "AMSynth", "FMSynth", "MembraneSynth", "Sampler"]
								},

								options: {
									type: "OBJECT",
									description:
										"Optional Tone.js settings for the instrument (e.g., oscillator type, envelope).",
									properties: {
										_tone_setting_: {
											type: "STRING",
											description:
												"This is a placeholder. The model should include actual Tone.js properties like 'oscillator.type' or 'envelope.attack' here, which will be accepted even if not explicitly defined in this schema."
										}
									},
									required: []
								}
							},
							required: ["name", "type"]
						}
					},
					phrases_list: {
						type: "ARRAY",
						items: {
							type: "OBJECT",
							properties: {
								phrase_name: { type: "STRING" },
								duration_measures: { type: "NUMBER" },
								patterns: {
									type: "ARRAY",
									items: {
										type: "OBJECT",
										properties: {
											instrument_name: { type: "STRING" },
											sequence: { type: "ARRAY", items: { type: "STRING" } },
											subdivision: { type: "STRING" },
											note_duration: { type: "STRING" },
											noise_modulation_depth: { type: "NUMBER" }
										},
										required: ["instrument_name", "sequence", "subdivision"]
									}
								}
							},
							required: ["phrase_name", "duration_measures", "patterns"]
						}
					}
				},
				required: ["tempo", "structure", "instruments", "phrases_list"]
			}
		}
	};

	const data = await fetchWithRetry(
		GEMINI_API_ENDPOINT,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		},
		500
	);

	let jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!jsonText) {
		throw new Error("Received empty content from the model.");
	}

	const markdownFenceRegex = /^\s*```json\s*|```\s*$/g;
	jsonText = jsonText.replace(markdownFenceRegex, "").trim();
	try {
		return JSON.parse(jsonText);
	} catch (parseError) {
		console.error("JSON parsing failed:", parseError, "Content:", jsonText);
		throw new Error(
			`JSON parsing failed: ${
				parseError.message
			}. Content received was: ${jsonText.substring(0, 100)}...`
		);
	}
}

async function generateAndRenderMusicInChat(prompt, containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;

	try {
		if (typeof Tone === "undefined") {
			container.innerHTML =
				"<p style='color: #ffcc00;'>Error: Tone.js library is not loaded.</p>";
			return;
		}
		if (Tone.context.state !== "running") {
			await Tone.start();
		}

		container.innerHTML =
			"<p style='color: #6c99e0;'>Generating music score...</p>";
		const musicData = await getMusicJson(prompt);
		const totalDuration = calculateDurationFromMusicData(musicData);

		if (totalDuration < 1) {
			throw new Error("Generated music structure is too short.");
		}

		const renderedBuffer = await renderPhraseByPhrase(
			musicData,
			totalDuration,
			(status) => {
				container.innerHTML = `<p style='color: #6c99e0;'>${status}</p>`;
			}
		);

		container.innerHTML = "<p style='color: #6c99e0;'>Encoding audio...</p>";
		const audioBlob = bufferToWave(renderedBuffer);
		const audioUrl = URL.createObjectURL(audioBlob);

		const audioPlayer = document.createElement("audio");
		audioPlayer.src = audioUrl;
		audioPlayer.controls = true;
		audioPlayer.style.width = "100%";
		container.innerHTML = "";
		container.appendChild(audioPlayer);
	} catch (error) {
		console.error("Music Generation Error:", error);
		container.innerHTML = `<p style='color: #ff4d4d;'>Music Generation Failed: ${error.message}</p>`;
	}
}

const mockSearchResults = JSON.stringify([
	{
		title: "Google Search Result 1",
		snippet: "This is a mock search result to demonstrate tool usage.",
		link: "https://example.com/1"
	},
	{
		title: "Google Search Result 2",
		snippet: "Another mock search result.",
		link: "https://example.com/2"
	}
]);
async function fetchWithRetry(url, options, initialDelay = 500) {
	let attempt = 0;
	let response;
	let errorData = null;

	while (true) {
		attempt++;
		try {
			response = await fetch(url, options);

			if (!response.ok) {
				try {
					errorData = await response.json();
					console.error(`API Error (Attempt ${attempt}):`, errorData);
				} catch (jsonError) {
					console.error(
						`HTTP Error (Attempt ${attempt}): Status ${response.status}`,
						response
					);
					errorData = null;
				}

				const isRetriable =
					response.status === 429 ||
					(response.status >= 500 && response.status < 600) ||
					(errorData &&
						errorData.error &&
						errorData.error.message &&
						errorData.error.message.includes("overloaded"));
				if (isRetriable) {
					const delay = initialDelay * Math.pow(1.5, attempt - 1);
					console.warn(`Retrying after ${delay}ms... (Attempt ${attempt})`);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				} else {
					if (errorData) {
						throw new Error(
							`API Error after multiple retries: ${
								errorData.error?.message || JSON.stringify(errorData)
							}`
						);
					} else {
						throw new Error(
							`HTTP Error after multiple retries: Status ${response.status}`
						);
					}
				}
			}

			removeStatusMessage();
			return await response.json();
		} catch (error) {
			console.error(`Fetch failed (Attempt ${attempt}):`, error);
			const delay = initialDelay * Math.pow(1.5, attempt - 1);
			console.warn(`Retrying fetch after ${delay}ms... (Attempt ${attempt})`);
			await new Promise((resolve) => setTimeout(resolve, delay));
			continue;
		}
	}
}

function updateStatusMessage(text) {
	if (
		currentStatusMessageElement &&
		chatBox.contains(currentStatusMessageElement)
	) {
		chatBox.removeChild(currentStatusMessageElement);
	}

	const statusMessage = document.createElement("div");
	statusMessage.className = "message bot status";
	statusMessage.innerText = text;
	chatBox.appendChild(statusMessage);
	chatBox.scrollTop = chatBox.scrollHeight;
	currentStatusMessageElement = statusMessage;
}

function removeStatusMessage() {
	if (
		currentStatusMessageElement &&
		chatBox.contains(currentStatusMessageElement)
	) {
		chatBox.removeChild(currentStatusMessageElement);
	}
	currentStatusMessageElement = null;
}

function resizeInputArea() {
	userInput.style.height = "auto";
	const newHeight = Math.min(userInput.scrollHeight, MAX_INPUT_HEIGHT);
	userInput.style.height = newHeight + "px";
	userInput.style.overflowY =
		userInput.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

userInput.addEventListener("input", resizeInputArea);
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		if (!isWaitingForToolExecution) {
			e.preventDefault();
			sendMessage();
		} else {
			e.preventDefault();
		}
	}
});
document.addEventListener("DOMContentLoaded", () => {
	loadChatsList();
	addMessage("Hello! I'm ready to chat. How can I help you today?", "bot");
	resizeInputArea();
});
sendBtn.addEventListener("click", () => {
	if (!isWaitingForToolExecution) {
		sendMessage();
	} else {
	}
});

historyBtn.addEventListener("click", () => {
	loadChatsList();
	historyPanel.classList.add("visible");
});

closeHistoryBtn.addEventListener("click", () => {
	historyPanel.classList.remove("visible");
});
clearHistoryBtn.addEventListener("click", () => {
	if (
		confirm(
			"Are you sure you want to clear all chat history? This cannot be undone."
		)
	) {
		clearChatHistory();
	}
});
fileInput.addEventListener("change", handleFileSelect);

function handleFileSelect(event) {
	selectedFiles = Array.from(event.target.files);
	displaySelectedFiles();
}

function displaySelectedFiles() {
	selectedFilesDisplay.innerHTML = "";
	if (selectedFiles.length === 0) {
		selectedFilesDisplay.innerText = "";
		return;
	}

	const fileNames = selectedFiles.map((file) => file.name);
	selectedFilesDisplay.innerText = `Selected: ${fileNames.join(", ")}`;
	fileInput.value = "";
}

function clearSelectedFiles() {
	selectedFiles = [];
	displaySelectedFiles();
}

function escapeHTML(str) {
	const div = document.createElement("div");
	div.appendChild(document.createTextNode(str));
	return div.innerHTML;
}

function downloadModelAsFile(content, fileName, mimeType) {
	const blob = new Blob([content], { type: mimeType });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

function addDownloadButtonListeners(messageElement) {
	messageElement.querySelectorAll(".download-btn").forEach((button) => {
		if (button.dataset.listenerAttached) return;
		button.dataset.listenerAttached = true;

		button.addEventListener("click", () => {
			const fileName = button.dataset.filename;
			const mimeType = button.dataset.mimetype;
			const content = button.dataset.content;
			downloadModelAsFile(atob(content), fileName, mimeType);
		});
	});
}

function formatAIResponse(text) {
	const escapeHTML = (str) => {
		if (typeof str !== "string") return "";
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	};

	let formattedText = text;

	formattedText = formattedText.replace(
		/!\[downloadable_file:\s*(.*?)\s*\|\s*(.*?)\s*\|([\s\S]*?)\]!/g,
		(match, fileName, mimeType, content) => {
			const safeFileName = escapeHTML(fileName.trim());
			const safeMimeType = escapeHTML(mimeType.trim());
			const base64Content = btoa(content);
			return `<button class="download-btn" data-filename="${safeFileName}" data-mimetype="${safeMimeType}" data-content="${base64Content}">Download ${safeFileName}</button>`;
		}
	);

	formattedText = formattedText.replace(
		/^```(\w+)?\n([\s\S]*?)```/gm,
		(match, lang, codeContent) => {
			const languageClass = lang ? `language-${lang.toLowerCase()}` : "";
			return `<pre><code class="${languageClass}">${escapeHTML(
				codeContent.trim()
			)}</code></pre>`;
		}
	);

	const lines = formattedText.split("\n");
	const outputLines = [];
	let listStack = [];
	let inTable = false;
	let blockquoteContent = [];
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		let trimmedLine = line.trim();
		let leadingSpaces = line.search(/\S|$/);

		if (blockquoteContent.length > 0 && !trimmedLine.startsWith(">")) {
			outputLines.push(
				`<blockquote>${blockquoteContent.join("\n").trim()}</blockquote>`
			);
			blockquoteContent = [];
		}

		if (trimmedLine.startsWith(">")) {
			blockquoteContent.push(trimmedLine.substring(1).trim());
			continue;
		}

		if (inTable && (!trimmedLine.startsWith("|") || trimmedLine === "")) {
			outputLines.push("</tbody></table></div>");
			inTable = false;
		}

		while (
			listStack.length > 0 &&
			leadingSpaces <= listStack[listStack.length - 1].indent &&
			!/^\s*(\*|\-|\d+\.)\s+/.test(line)
		) {
			const listTag = listStack.pop().tag;
			outputLines.push(`</${listTag}>`);
		}

		if (!inTable) {
			if (trimmedLine.match(/^#{1,3}\s/)) {
				const level = trimmedLine.indexOf(" ");
				const tag = `h${level}`;
				outputLines.push(`<${tag}>${trimmedLine.substring(level).trim()}</${tag}>`);
				continue;
			} else if (trimmedLine.startsWith("---") || trimmedLine.startsWith("***")) {
				outputLines.push(`<hr>`);
				continue;
			}
		}

		if (trimmedLine.startsWith("|") && !inTable) {
			if (
				i + 1 < lines.length &&
				lines[i + 1].trim().match(/^\|[ \t]*[:\-]+[ \t]*\|/)
			) {
				inTable = true;
				outputLines.push('<div style="overflow-x:auto;"><table><thead><tr>');
				const headers = trimmedLine
					.split("|")
					.map((h) => h.trim())
					.filter((h) => h);
				outputLines.push(
					`<th>${headers.join("</th><th>")}</th></tr></thead><tbody>`
				);
				i++;
				continue;
			}
		} else if (inTable && trimmedLine.startsWith("|")) {
			let rowContent = trimmedLine.replace(/^\|/, "").replace(/\|$/, "").trim();
			const cells = rowContent
				.split("|")
				.map((c) => c.trim())
				.filter((c) => true);
			if (cells.length > 0) {
				outputLines.push(`<tr><td>${cells.join("</td><td>")}</td></tr>`);
			}
			continue;
		}

		const listItemMatch = line.match(/^(\s*)(\*|\-|\d+\.)\s+(.*)/);
		if (listItemMatch) {
			const [, indentString, marker, content] = listItemMatch;
			const currentIndent = indentString.length;
			const listType = marker.match(/^\d+\./) ? "ol" : "ul";
			while (
				listStack.length > 0 &&
				currentIndent < listStack[listStack.length - 1].indent
			) {
				outputLines.push(`</${listStack.pop().tag}>`);
			}

			if (
				listStack.length === 0 ||
				currentIndent > listStack[listStack.length - 1].indent ||
				listStack[listStack.length - 1].tag !== listType
			) {
				listStack.push({ tag: listType, indent: currentIndent });
				outputLines.push(`<${listType}>`);
			}

			if (
				listStack.length > 0 &&
				listStack[listStack.length - 1].tag !== listType &&
				currentIndent === listStack[listStack.length - 1].indent
			) {
				outputLines.push(`</${listStack.pop().tag}>`);
				listStack.push({ tag: listType, indent: currentIndent });
				outputLines.push(`<${listType}>`);
			}

			outputLines.push(`<li>${content.trim()}</li>`);
			continue;
		}

		outputLines.push(line);
	}

	if (blockquoteContent.length > 0) {
		outputLines.push(
			`<blockquote>${blockquoteContent.join("\n").trim()}</blockquote>`
		);
	}
	while (listStack.length > 0) outputLines.push(`</${listStack.pop().tag}>`);
	if (inTable) outputLines.push("</tbody></table></div>");

	formattedText = outputLines.join("\n");

	formattedText = formattedText.replace(/^\s*\n/gm, "\n");
	formattedText = formattedText.replace(/(\n\s*){3,}/g, "\n\n");
	formattedText = formattedText.replace(
		/!\[([^\]]*)\]\(([^)]+?)(?:\s+["'](.+?)["'])?\)/g,
		(match, altText, url, title) => {
			const escapedUrl = escapeHTML(url);
			const escapedAlt = escapeHTML(altText || "");
			const escapedTitle = escapeHTML(title || "");
			const titleAttr = escapedTitle ? ` title="${escapedTitle}"` : "";
			return `<img src="${escapedUrl}" alt="${escapedAlt}"${titleAttr} style="max-width:100%; height:auto;">`;
		}
	);

	formattedText = formattedText.replace(
		/(?<!["'`])\b(https?|ftp|file):\/\/[^\s]+?(?=[.,;!?]?(\s|$))/g,
		(match) => {
			let url = match.trim();
			if (url.endsWith(")")) {
				url = url.substring(0, url.length - 1);
			}
			return `<a href="${escapeHTML(
				url
			)}" target="_blank" class="highlight-link">${url}</a>`;
		}
	);

	formattedText = formattedText.replace(
		/\[([^\]]+?)\]\(([^)]+?)\)/g,
		(match, linkText, url) => {
			return `<a href="${escapeHTML(
				url
			)}" target="_blank" class="highlight-link">${linkText}</a>`;
		}
	);

	formattedText = formattedText.replace(/`([^`\n]+?)`/g, (match, inlineCode) => {
		return `<code>${escapeHTML(inlineCode.trim())}</code>`;
	});

	formattedText = formattedText.replace(
		/~~([^~]+?)~~/g,
		(match, strikeContent) => {
			return `<del>${strikeContent.trim()}</del>`;
		}
	);

	formattedText = formattedText.replace(
		/\*\*([^\*]+?)\*\*/g,
		(match, boldContent) => {
			return `<strong>${boldContent.trim()}</strong>`;
		}
	);

	formattedText = formattedText.replace(/~([^~\s]+?)~/g, (match, subContent) => {
		return `<sub>${subContent.trim()}</sub>`;
	});

	formattedText = formattedText.replace(
		/\^([^\^\s]+?)\^/g,
		(match, supContent) => {
			return `<sup>${supContent.trim()}</sup>`;
		}
	);
	formattedText = formattedText.replace(
		/\[\[([^\]]+?)\]\]/g,
		(match, keyContent) => {
			return `<kbd>${keyContent.trim()}</kbd>`;
		}
	);

	formattedText = formattedText.replace(
		/([*_])([^\n]+?)\1/g,
		(match, marker, content) => {
			if (
				content.trim().startsWith("<") ||
				content.trim().endsWith(">") ||
				match.startsWith("**")
			)
				return match;
			if (marker === "*" || marker === "_") {
				return `<em>${content.trim()}</em>`;
			}
			return match;
		}
	);
	formattedText = formattedText
		.split("\n\n")
		.map((paragraph) => {
			const trimmed = paragraph.trim();
			if (!trimmed) return "";

			const isBlockLevel =
				trimmed.toLowerCase().startsWith("<h") ||
				trimmed.toLowerCase().startsWith("<pre") ||
				trimmed.toLowerCase().startsWith("<ul") ||
				trimmed.toLowerCase().startsWith("<ol") ||
				trimmed.toLowerCase().startsWith("<li") ||
				trimmed.toLowerCase().startsWith("<blockquote") ||
				trimmed.toLowerCase().startsWith("<hr") ||
				trimmed.toLowerCase().startsWith("<table") ||
				trimmed.toLowerCase().startsWith("<div") ||
				trimmed.toLowerCase().startsWith("<img") ||
				trimmed.toLowerCase().startsWith("<button");

			if (isBlockLevel) {
				return paragraph;
			}

			const contentWithBr = trimmed.replace(/\n/g, "<br>");
			return `<p>${contentWithBr}</p>`;
		})
		.join("\n");
	return formattedText;
}

function addCopyButtonsToCodeBlocks(messageElement) {
	const codeBlocks = messageElement.querySelectorAll("pre code");
	codeBlocks.forEach((codeElement) => {
		const preElement = codeElement.parentElement;
		if (preElement.querySelector(".copy-code-btn")) return;

		const copyButton = document.createElement("button");
		copyButton.className = "copy-code-btn";
		copyButton.innerText = "Copy";

		copyButton.addEventListener("click", () => {
			const codeText = codeElement.innerText;
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard
					.writeText(codeText)
					.then(() => {
						copyButton.innerText = "Copied!";
						setTimeout(() => {
							copyButton.innerText = "Copy";
						}, 1500);
					})
					.catch(() => {
						fallbackCopyTextToClipboard(codeText, copyButton);
					});
			} else {
				fallbackCopyTextToClipboard(codeText, copyButton);
			}
		});
		preElement.appendChild(copyButton);
	});
}

function fallbackCopyTextToClipboard(text, button) {
	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.style.position = "fixed";
	textArea.style.top = "0";
	textArea.style.left = "0";
	textArea.style.width = "1px";
	textArea.style.height = "1px";
	textArea.style.opacity = "0";
	document.body.appendChild(textArea);
	textArea.focus();
	textArea.select();

	let successful;
	try {
		successful = document.execCommand("copy");
	} catch (err) {
		successful = false;
	}
	document.body.removeChild(textArea);
	if (successful) {
		button.innerText = "Copied!";
	} else {
		button.innerText = "Cannot copy";
	}
	setTimeout(() => {
		button.innerText = "Copy";
	}, 1500);
}

function addRewriteButton(botMessageElement) {
	const rewriteButton = document.createElement("button");
	rewriteButton.className = "rewrite-btn";
	rewriteButton.innerText = "Rewrite";
	rewriteButton.addEventListener("click", () => {
		if (lastUserMessageText && !isWaitingForToolExecution) {
			userInput.innerText = lastUserMessageText;
			resizeInputArea();
			sendMessage();
		} else if (isWaitingForToolExecution) {
		} else {
		}
	});
	const timestampElement = botMessageElement.querySelector(".timestamp");
	if (timestampElement) {
		timestampElement.parentElement.insertBefore(
			rewriteButton,
			timestampElement.nextSibling
		);
	}
}

function renderThreeJSModel(jsCode, containerId) {
	const container = document.getElementById(containerId);
	if (!container) {
		console.error("3D container not found:", containerId);
		return;
	}

	if (typeof THREE === "undefined") {
		container.innerHTML =
			"<p style='color: #ffcc00; padding: 10px;'>Error: Three.js library is not loaded. Please add it to your HTML file.</p>";
		return;
	}

	try {
		const F = new Function("THREE", "container", jsCode);
		F(THREE, container);
	} catch (e) {
		console.error("Error executing Three.js code:", e);
		container.innerHTML = `<p style='color: #ff4d4d; padding: 10px;'>Error rendering 3D model: ${e.message}</p>`;
	}
}

function addMessage(
	content,
	sender,
	timestamp = new Date(),
	fileInfo = null,
	sources = null
) {
	const message = document.createElement("div");
	message.className = `message ${sender}`;
	const contentElement = document.createElement("div");
	contentElement.className = "content";

	let textForDisplay = content;
	let rendererId = null;
	let jsCode = null;
	let musicPrompt = null;
	let musicContainerId = null;

	const imageTriggerRegex = /!\[pollinations_image:\s*(.*?)\s*\]/;
	const threeJsRegex = /!\[three_js_model:\s*```javascript([\s\S]*?)```\s*\]!/;
	const musicRegex = /!\[webxill_music:\s*(.*?)\s*\]/;
	const imageTriggerMatch = content.match(imageTriggerRegex);
	const threeJsMatch = content.match(threeJsRegex);
	const musicMatch = content.match(musicRegex);
	if (sender === "bot") {
		if (threeJsMatch) {
			jsCode = threeJsMatch[1];
			rendererId = `renderer-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
			textForDisplay = textForDisplay.replace(threeJsRegex, "");
			const modelContainer = document.createElement("div");
			modelContainer.className = "generated-image-container"; // Can reuse this class
			modelContainer.id = rendererId;
			modelContainer.style.height = "400px";
			modelContainer.style.width = "100%";
			modelContainer.style.background = "#000";
			contentElement.appendChild(modelContainer);
		} else if (imageTriggerMatch) {
			const imageUrl = `${POLLINATIONS_AI_IMAGE_API_ENDPOINT}${encodeURIComponent(
				imageTriggerMatch[1]
			)}`;
			textForDisplay = textForDisplay.replace(imageTriggerRegex, "");

			const imageContainer = document.createElement("div");
			imageContainer.className = "generated-image-container";
			const imageElement = document.createElement("img");
			imageElement.src = imageUrl;
			imageElement.alt = "Generated image";
			imageContainer.appendChild(imageElement);
			contentElement.appendChild(imageContainer);
		} else if (musicMatch) {
			musicPrompt = musicMatch[1];
			musicContainerId = `music-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
			textForDisplay = textForDisplay.replace(musicRegex, "");

			const musicContainer = document.createElement("div");
			musicContainer.className = "generated-music-container";
			musicContainer.id = musicContainerId;
			musicContainer.innerHTML =
				"<p style='color: #6c99e0;'>Initializing music generator...</p>";
			contentElement.appendChild(musicContainer);
		}

		contentElement.innerHTML += formatAIResponse(textForDisplay);
		if (sources && sources.length > 0) {
			const sourcesElement = document.createElement("div");
			sourcesElement.className = "sources";
			sourcesElement.innerHTML = "<strong>Sources:</strong>";
			const sourceList = document.createElement("ul");
			sources.forEach((source) => {
				const listItem = document.createElement("li");
				listItem.innerText =
					source.publication || source.title || source.uri || "Unknown Source";
				if (source.uri) {
					const link = document.createElement("a");
					link.href = source.uri;
					link.innerText = " (Link)";
					link.target = "_blank";
					listItem.appendChild(link);
				}
				sourceList.appendChild(listItem);
			});
			sourcesElement.appendChild(sourceList);
			message.appendChild(sourcesElement);
		}
	} else {
		contentElement.innerText = content;
		if (fileInfo) {
			const fileInfoElement = document.createElement("span");
			fileInfoElement.className = "file-info";
			fileInfoElement.innerText = ` ${fileInfo}`;
			contentElement.appendChild(fileInfoElement);
		}
	}

	const timestampElement = document.createElement("span");
	timestampElement.className = "timestamp";
	timestampElement.innerText = new Date(timestamp).toLocaleString();

	message.appendChild(contentElement);
	if (sender === "bot" && message.querySelector(".sources")) {
		message.insertBefore(timestampElement, message.querySelector(".sources"));
	} else {
		message.appendChild(timestampElement);
	}

	chatBox.appendChild(message);
	chatBox.scrollTop = chatBox.scrollHeight;
	if (sender === "bot" && !message.classList.contains("status")) {
		addCopyButtonsToCodeBlocks(message);
		addDownloadButtonListeners(message);
		addRewriteButton(message);
	}

	if (jsCode && rendererId) {
		renderThreeJSModel(jsCode, rendererId);
	}

	if (musicPrompt && musicContainerId) {
		generateAndRenderMusicInChat(musicPrompt, musicContainerId);
	}

	return message;
}

async function processFilesForAPI(files) {
	const fileParts = [];
	for (const file of files) {
		const mimeType = file.type || "application/octet-stream";
		const filePart = await new Promise((resolve, reject) => {
			const reader = new FileReader();

			reader.onload = (event) => {
				const base64Data = event.target.result.split(",")[1];
				resolve({
					inline_data: {
						mime_type: mimeType,
						data: base64Data
					}
				});
			};

			reader.onerror = () => {
				reject(new Error(`Failed to read file: ${file.name}`));
			};

			reader.readAsDataURL(file);
		});
		if (filePart) {
			fileParts.push(filePart);
		}
	}
	return fileParts;
}

function generateChatName(history) {
	if (!history || history.length < 2) {
		return "New Chat";
	}
	const firstUserMessage = history.find(
		(msg) =>
			msg.role === "user" &&
			msg.parts &&
			!msg.parts.find((p) => p.text?.startsWith("SYSTEM:")) &&
			msg.parts.length > 0 &&
			msg.parts.find((part) => part.text) &&
			!msg.parts
				.find((part) => part.text)
				.text.trim()
				.startsWith("You are **WebXill**") &&
			msg.parts.find((part) => part.text).text.trim().length > 0
	);
	if (firstUserMessage) {
		const text = firstUserMessage.parts.find((part) => part.text).text.trim();
		return text.substring(0, 30) + (text.length > 30 ? "..." : "");
	}
	return "New Chat";
}

async function triggerChatTitleGeneration(chatId) {
	const chats = JSON.parse(localStorage.getItem(CHATS_STORAGE_KEY) || "{}");
	const history = chats[chatId];

	if (!history || history.length < 2) {
		return;
	}

	const userPrompt =
		history[0].parts.find((p) => p.text)?.text.substring(0, 100) || "";
	const botResponse =
		history[1].parts.find((p) => p.text)?.text.substring(0, 100) || "";

	const titlePrompt = `Based on this conversation:
User: "${userPrompt}..."
AI: "${botResponse}..."

What is a short, concise title for this chat (max 5 words)? Respond with ONLY the title text.`;

	try {
		const data = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: titlePrompt }] }]
				})
			},
			500
		);

		const titleText = data.candidates?.[0]?.content?.parts?.[0]?.text
			?.trim()
			.replace(/"/g, "");

		if (!titleText) return;

		renameChat(chatId, titleText);
		loadChatsList();
	} catch (error) {
		console.error("Failed to generate chat title:", error);
	}
}

function renameChat(chatId, newName) {
	let chatListMeta = JSON.parse(
		localStorage.getItem(CHATS_STORAGE_KEY + "_meta") || "[]"
	);
	const metaIndex = chatListMeta.findIndex((m) => m.id === chatId);

	if (metaIndex !== -1) {
		chatListMeta[metaIndex].name = newName;
		localStorage.setItem(
			CHATS_STORAGE_KEY + "_meta",
			JSON.stringify(chatListMeta)
		);
	}
}

function loadChatsList() {
	const chatsMeta = JSON.parse(
		localStorage.getItem(CHATS_STORAGE_KEY + "_meta") || "[]"
	);
	chatList.innerHTML = "";
	if (chatsMeta.length === 0) {
		chatList.innerHTML = "<p class='no-history'>No saved chats yet.</p>";
		return;
	}

	chatsMeta.forEach((meta) => {
		const listItem = document.createElement("li");
		listItem.className = "chat-item";
		listItem.dataset.chatId = meta.id;

		listItem.innerHTML = `
            <span class="chat-name">${escapeHTML(meta.name)}</span>
            <input type="text" class="rename-input" style="display: none;" value="${escapeHTML(
													meta.name
												)}">
            <button class="edit-chat-btn" title="Rename chat">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="white">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                </svg>
            </button>
            <button class="delete-chat-btn" title="Delete chat">
                <svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="18" height="18" viewBox="0 0 24 24"> 
                    <path d="M3 3H21V5H3z" fill="white"></path>
                    <path d="M16.1,22H7.9c-1,0-1.9-0.7-2-1.7L4,4.1l2-0.2L7.9,20l8.2,0L18,3.9l2,0.2l-1.9,16.1C18,21.3,17.1,22,16.1,22z" fill="white"></path>
                    <path d="M5,4l1.9,16.1c0.1,0.5,0.5,0.9,1,0.9h8.2 c0.5,0,0.9-0.4,1-0.9L19,4H5z" fill="white"></path>
                    <path d="M15 3L15 4 9 4 9 3 10 2 14 2z" fill="white"></path> 
                </svg>
            </button>
        `;

		const chatNameSpan = listItem.querySelector(".chat-name");
		const renameInput = listItem.querySelector(".rename-input");
		const editBtn = listItem.querySelector(".edit-chat-btn");
		const deleteBtn = listItem.querySelector(".delete-chat-btn");

		chatNameSpan.addEventListener("click", () => {
			loadChat(meta.id);
		});

		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			chatNameSpan.style.display = "none";
			editBtn.style.display = "none";
			deleteBtn.style.display = "none";
			renameInput.style.display = "inline-block";
			renameInput.focus();
			renameInput.select();
		});

		const saveRename = () => {
			const newName = renameInput.value.trim();
			if (newName && newName !== meta.name) {
				renameChat(meta.id, newName);
				chatNameSpan.innerText = newName;
			} else {
				renameInput.value = meta.name;
			}
			chatNameSpan.style.display = "inline-block";
			editBtn.style.display = "inline-block";
			deleteBtn.style.display = "inline-block";
			renameInput.style.display = "none";
		};

		renameInput.addEventListener("blur", saveRename);
		renameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				saveRename();
			} else if (e.key === "Escape") {
				renameInput.value = meta.name;
				chatNameSpan.style.display = "inline-block";
				editBtn.style.display = "inline-block";
				deleteBtn.style.display = "inline-block";
				renameInput.style.display = "none";
			}
		});

		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (confirm(`Are you sure you want to delete chat "${meta.name}"?`)) {
				deleteChat(meta.id);
			}
		});

		chatList.appendChild(listItem);
	});
}

function saveChat() {
	if (conversationHistory.length === 0) {
		return;
	}

	let chats = JSON.parse(localStorage.getItem(CHATS_STORAGE_KEY) || "{}");
	let chatListMeta = JSON.parse(
		localStorage.getItem(CHATS_STORAGE_KEY + "_meta") || "[]"
	);
	if (!currentChatId) {
		currentChatId = Date.now().toString();
		const chatName = generateChatName(conversationHistory);
		chatListMeta.unshift({
			id: currentChatId,
			name: chatName,
			timestamp: new Date().toISOString()
		});
	} else {
		const chatMetaIndex = chatListMeta.findIndex(
			(chat) => chat.id === currentChatId
		);
		if (chatMetaIndex !== -1) {
			if (
				chatListMeta[chatMetaIndex].name === "New Chat" ||
				chatListMeta[chatMetaIndex].name.startsWith(
					conversationHistory[0]?.parts[0]?.text.substring(0, 30)
				)
			) {
				chatListMeta[chatMetaIndex].name = generateChatName(conversationHistory);
			}
			chatListMeta[chatMetaIndex].timestamp = new Date().toISOString();
			const updatedChatMeta = chatListMeta.splice(chatMetaIndex, 1)[0];
			chatListMeta.unshift(updatedChatMeta);
		} else {
			const chatName = generateChatName(conversationHistory);
			chatListMeta.unshift({
				id: currentChatId,
				name: chatName,
				timestamp: new Date().toISOString()
			});
		}
	}

	chats[currentChatId] = conversationHistory;

	localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(chats));
	localStorage.setItem(
		CHATS_STORAGE_KEY + "_meta",
		JSON.stringify(chatListMeta)
	);
	loadChatsList();
}

function loadChat(chatId) {
	const chats = JSON.parse(localStorage.getItem(CHATS_STORAGE_KEY) || "{}");
	const chatToLoad = chats[chatId];
	if (!chatToLoad) {
		return;
	}

	chatBox.innerHTML = "";
	conversationHistory = chatToLoad;
	currentChatId = chatId;
	isWaitingForToolExecution = false;
	lastUserMessageText = "";
	removeStatusMessage();
	conversationHistory.forEach((message) => {
		const textContent = message.parts.find((part) => part.text)?.text || "";
		if (
			message.role === "user" &&
			textContent.trim().startsWith("You are **WebXill**")
		) {
			return;
		}

		const toolCodePart = message.parts?.find((part) => part.tool_code);
		if (toolCodePart) {
			let toolMessageContent = `(Model requested tool use)`;
			try {
				const parsedToolCode = JSON.parse(
					toolCodePart.tool_code.replace("print(", "").replace(")", "")
				);
				if (
					parsedToolCode &&
					parsedToolCode.googleSearch &&
					parsedToolCode.googleSearch.queries &&
					parsedToolCode.googleSearch.queries.length > 0
				) {
					toolMessageContent = `(Search requested: "${parsedToolCode.googleSearch.queries.join(
						", "
					)}")`;
				}
			} catch (e) {
				toolMessageContent = `(Model requested tool use - parse error)`;
			}
			addMessage(toolMessageContent, "bot", message.timestamp);
			return;
		}

		const toolResultPart = message.parts?.find((part) => part.tool_result);
		if (toolResultPart) {
			addMessage("(Search results processed by model)", "bot", message.timestamp);
			return;
		}

		const hasFilePart = message.parts.some((part) => part.inline_data);
		const fileInfo = hasFilePart
			? `[${
					message.parts.filter((part) => part.inline_data).length
			  } file(s) attached]`
			: null;
		const sources = message.citationMetadata?.citationSources || null;
		if (message.role === "user" && textContent) {
			lastUserMessageText = textContent;
			addMessage(
				textContent,
				message.role,
				message.timestamp || new Date(),
				fileInfo
			);
		} else if (message.role === "model" && textContent) {
			addMessage(
				textContent,
				message.role,
				message.timestamp || new Date(),
				null,
				sources
			);
		} else if (textContent || fileInfo) {
			addMessage(
				textContent,
				message.role,
				message.timestamp || new Date(),
				fileInfo
			);
		}
	});

	chatBox.querySelectorAll(".message.bot:not(.status)").forEach((botMsgEl) => {
		if (!botMsgEl.querySelector(".copy-code-btn"))
			addCopyButtonsToCodeBlocks(botMsgEl);
		if (!botMsgEl.querySelector(".download-btn[data-listener-attached]"))
			addDownloadButtonListeners(botMsgEl);
		if (!botMsgEl.querySelector(".rewrite-btn")) addRewriteButton(botMsgEl);
	});
	historyPanel.classList.remove("visible");
	chatBox.scrollTop = chatBox.scrollHeight;
}

function deleteChat(chatId) {
	let chats = JSON.parse(localStorage.getItem(CHATS_STORAGE_KEY) || "{}");
	let chatsMeta = JSON.parse(
		localStorage.getItem(CHATS_STORAGE_KEY + "_meta") || "[]"
	);
	delete chats[chatId];
	chatsMeta = chatsMeta.filter((meta) => meta.id !== chatId);

	localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(chats));
	localStorage.setItem(CHATS_STORAGE_KEY + "_meta", JSON.stringify(chatsMeta));
	loadChatsList();
	if (currentChatId === chatId) {
		currentChatId = null;
		conversationHistory = [];
		chatBox.innerHTML = "";
		addMessage("Chat deleted. Starting a new chat.", "bot", new Date());
	}
}

function clearChatHistory() {
	localStorage.removeItem(CHATS_STORAGE_KEY);
	localStorage.removeItem(CHATS_STORAGE_KEY + "_meta");
	conversationHistory = [];
	currentChatId = null;
	chatBox.innerHTML = "";
	loadChatsList();
	isWaitingForToolExecution = false;
	lastUserMessageText = "";
	removeStatusMessage();
	addMessage("Chat history cleared. Starting a new chat.", "bot", new Date());
}

async function executeAndSendToolResults(toolCode) {
	let queries = [];
	try {
		const parsedToolCode = JSON.parse(
			toolCode.replace("print(", "").replace(")", "")
		);
		if (
			parsedToolCode &&
			parsedToolCode.googleSearch &&
			parsedToolCode.googleSearch.queries
		) {
			queries = parsedToolCode.googleSearch.queries;
		}
	} catch (e) {
		removeStatusMessage();
		addMessage(
			"Error: Could not understand search request from model.",
			"bot",
			new Date()
		);
		isWaitingForToolExecution = false;
		saveChat();
		return;
	}

	updateStatusMessage("Generating Response...");
	const toolResultPart = {
		tool_result: {
			content: mockSearchResults
		}
	};
	conversationHistory.push({
		role: "tool",
		timestamp: new Date().toISOString(),
		parts: [toolResultPart]
	});
	const apiContentsWithToolResult = conversationHistory
		.filter((msg) => {
			return true;
		})
		.map((msg) => ({ role: msg.role, parts: msg.parts }))
		.filter((msg) => msg.parts && msg.parts.length > 0);
	removeStatusMessage();
	updateStatusMessage("Generating final response...");

	try {
		const data = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: apiContentsWithToolResult,
					systemInstruction: {
						parts: [{ text: SYSTEM_INSTRUCTION_TEXT }]
					}
				})
			},
			500
		);
		removeStatusMessage();
		handleApiResponse(data, null);
	} catch (error) {
		removeStatusMessage();
		addMessage(
			`Error getting final response after search: ${error.message}`,
			"bot",
			new Date()
		);
		saveChat();
		isWaitingForToolExecution = false;
	}
}

async function handleApiResponse(data, typingMessage) {
	if (typingMessage) {
		removeStatusMessage();
	} else if (currentStatusMessageElement) {
		removeStatusMessage();
	}

	if (data.error) {
		addMessage(
			`API Error: ${data.error.message || "Unknown error"}`,
			"bot",
			new Date()
		);
		isWaitingForToolExecution = false;
		saveChat();
		return;
	}

	const toolCodePart = data.candidates?.[0]?.content?.parts?.find(
		(part) => part.tool_code
	);
	const botReplyText = data.candidates?.[0]?.content?.parts?.[0]?.text;

	if (toolCodePart) {
		const toolCode = toolCodePart.tool_code;
		conversationHistory.push({
			role: "model",
			timestamp: new Date().toISOString(),
			parts: [{ tool_code: toolCode }]
		});
		let toolMessageContent = `Thinking... (Model requested tool use)`;
		try {
			const parsedToolCode = JSON.parse(
				toolCode.replace("print(", "").replace(")", "")
			);
			if (
				parsedToolCode &&
				parsedToolCode.googleSearch &&
				parsedToolCode.googleSearch.queries &&
				parsedToolCode.googleSearch.queries.length > 0
			) {
				toolMessageContent = `Thinking... (Searching for: "${parsedToolCode.googleSearch.queries.join(
					", "
				)}")`;
			}
		} catch (e) {
			toolMessageContent = `Thinking... (Model requested tool use - parse error)`;
		}

		updateStatusMessage(toolMessageContent);
		isWaitingForToolExecution = true;
		executeAndSendToolResults(toolCode).catch((toolError) => {
			removeStatusMessage();
			addMessage(
				`An error occurred during the search process: ${toolError.message}`,
				"bot",
				new Date()
			);
			saveChat();
			isWaitingForToolExecution = false;
		});
	} else {
		const finishReason = data.candidates?.[0]?.finishReason;
		const blockReason = data.promptFeedback?.blockReason;
		const citationMetadata =
			data.candidates?.[0]?.citationMetadata?.citationSources;

		if (finishReason === "SAFETY" || blockReason) {
			let blockMessage = "My response was blocked due to safety concerns.";
			if (blockReason) blockMessage += ` Reason: ${blockReason}`;
			addMessage(blockMessage, "bot", new Date());
		} else if (botReplyText) {
			const isNewChat = !currentChatId; // Check if this is a new chat *before* saving

			const botMessage = {
				role: "model",
				timestamp: new Date().toISOString(),
				parts: [{ text: botReplyText }]
			};
			if (citationMetadata && citationMetadata.length > 0) {
				botMessage.citationMetadata = { citationSources: citationMetadata };
			}
			conversationHistory.push(botMessage);

			const messageElement = addMessage(
				botReplyText,
				"bot",
				botMessage.timestamp,
				null,
				citationMetadata
			);

			saveChat();
			if (isNewChat && conversationHistory.length === 2) {
				triggerChatTitleGeneration(currentChatId);
			}

			const imageTriggerRegex = /!\[pollinations_image:\s*(.*?)\s*\]/;
			const musicRegex = /!\[webxill_music:\s*(.*?)\s*\]/;
			if (
				!botReplyText.match(imageTriggerRegex) &&
				!botReplyText.match(musicRegex)
			) {
				attachCrossQuestions(lastUserMessageText, botReplyText, messageElement);
			}
		} else {
			addMessage(
				"Received an unexpected response from the API. Please try again or rephrase.",
				"bot",
				new Date()
			);
			saveChat();
		}

		isWaitingForToolExecution = false;
	}
}

async function getUserLocation() {
	return new Promise((resolve, reject) => {
		if ("geolocation" in navigator) {
			navigator.geolocation.getCurrentPosition(
				(position) => {
					resolve({
						latitude: position.coords.latitude,
						longitude: position.coords.longitude
					});
				},
				(error) => {
					reject(error);
				}
			);
		} else {
			reject(new Error("Geolocation is not supported by this browser."));
		}
	});
}

async function sendMessage() {
	if (isWaitingForToolExecution) {
		return;
	}

	const text = userInput.innerText.trim();
	const filesToProcess = selectedFiles;
	if (!text && filesToProcess.length === 0) {
		userInput.innerHTML = "";
		resizeInputArea();
		return;
	}

	if (conversationHistory.length === 0) {
		currentChatId = null;
	}

	const userMessageParts = [];
	if (text) {
		userMessageParts.push({ text: text });
		lastUserMessageText = text;
	}

	try {
		const location = await getUserLocation();
		const locationText = `SYSTEM: User's current location is Latitude: ${location.latitude}, Longitude: ${location.longitude}.`;
		userMessageParts.push({ text: locationText });
	} catch (error) {}

	let fileInfoForDisplay = null;
	if (filesToProcess.length > 0) {
		fileInfoForDisplay = `[${filesToProcess.length} file(s) attached]`;
		try {
			const fileParts = await processFilesForAPI(filesToProcess);
			fileParts.forEach((part) => {
				if (part) userMessageParts.push(part);
			});
		} catch (error) {
			addMessage(`Error processing files: ${error.message}`, "bot", new Date());
			clearSelectedFiles();
			return;
		}
	}

	if (userMessageParts.length === 0) {
		addMessage(
			"No valid content to send after processing files or empty text input.",
			"bot",
			new Date()
		);
		clearSelectedFiles();
		return;
	}

	const userMessage = {
		role: "user",
		timestamp: new Date().toISOString(),
		parts: userMessageParts
	};
	conversationHistory.push(userMessage);
	addMessage(text, "user", userMessage.timestamp, fileInfoForDisplay);
	userInput.innerHTML = "";
	resizeInputArea();
	clearSelectedFiles();

	updateStatusMessage("Generating Response...");
	const apiContents = conversationHistory
		.map((msg) => ({ role: msg.role, parts: msg.parts }))
		.filter((msg) => msg.parts && msg.parts.length > 0);
	const requestBody = {
		contents: apiContents,
		tools: [
			{
				googleSearch: {}
			}
		],
		systemInstruction: {
			parts: [{ text: SYSTEM_INSTRUCTION_TEXT }]
		}
	};
	try {
		const data = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify(requestBody)
			},
			500
		);
		handleApiResponse(data, true);
	} catch (error) {
		removeStatusMessage();
		addMessage(
			`Sorry, I encountered an error getting a response: ${error.message}`,
			"bot",
			new Date()
		);
		saveChat();
		isWaitingForToolExecution = false;
	}
}

function enhancePrompt(prompt) {
	return `
The user asked: "${prompt}".
Rewrite this into a clear, detailed, and specific instruction that ensures elaboration, structure, examples, and depth.
Then, use this enhanced version as the actual query.
`;
}

async function generateCrossQuestions(originalPrompt, aiResponse) {
	const requestBody = {
		contents: [
			{
				role: "user",
				parts: [
					{
						text: `
The user originally asked: "${originalPrompt}".
You responded with: "${aiResponse}".
Now, predict 3 to 5 follow-up questions the user is most likely to ask next.
Only return the questions as a simple list, nothing else.
`
					}
				]
			}
		]
	};
	try {
		const data = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(requestBody)
			},
			500
		);
		const suggestionsText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
		return suggestionsText
			.split("\n")
			.map((q) => q.replace(/^\d+\.\s*/, "").trim())
			.filter((q) => q.length > 0);
	} catch (err) {
		console.error("Cross-question generation failed:", err);
		return [];
	}
}

async function attachCrossQuestions(
	originalPrompt,
	aiResponse,
	containerElement
) {
	const statusDiv = document.createElement("div");
	statusDiv.className = "suggestions-status";
	statusDiv.innerText = "Generating suggestions...";
	containerElement.appendChild(statusDiv);
	const crossQs = await generateCrossQuestions(originalPrompt, aiResponse);

	if (crossQs.length > 0) {
		const qContainer = document.createElement("div");
		qContainer.className = "cross-questions";
		qContainer.innerHTML =
			"<strong>You might also ask:</strong><br>" +
			crossQs.map((q) => `<button class="cross-q">${q}</button>`).join(" ");
		containerElement.removeChild(statusDiv);
		containerElement.appendChild(qContainer);
		qContainer.querySelectorAll(".cross-q").forEach((btn) => {
			btn.addEventListener("click", () => {
				userInput.innerText = btn.innerText;
				resizeInputArea();
				userInput.focus();
			});
		});
	} else {
		if (containerElement.contains(statusDiv)) {
			containerElement.removeChild(statusDiv);
		}
	}
}
async function runConsensusArbiter(solutions, question) {
	const prompt = `
You are a strict mathematics arbiter.
Question: "${question}"

Here are ${solutions.length} independent solutions:
${solutions.map((s, i) => `[${i + 1}]: ${s}`).join("\n")}

1. Verify each step carefully.
2. Identify mistakes or unjustified logic.
3. If >=70% agree on the same correct answer, respond:
   success: <best verified solution>
   confidence: <0.70–1.00>
   accuracy: <0.70–1.00>
4. Else respond:
   retry: <short reason>.
`;
	const response = await fetchWithRetry(
		GEMINI_API_ENDPOINT,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: prompt }] }]
			})
		},
		500
	);
	const verdict = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
	const successMatch = verdict.match(/success:\s*(.+)/i);
	const confidenceMatch = verdict.match(/confidence:\s*([0-9.]+)/i);
	const accuracyMatch = verdict.match(/accuracy:\s*([0-9.]+)/i);
	return {
		success: !!successMatch,
		bestSolution: successMatch ? successMatch[1].trim() : "",
		confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
		accuracy: accuracyMatch ? parseFloat(accuracyMatch[1]) : 0
	};
}

async function retryUntilConsensus(question, numSolvers) {
	let solverCount = numSolvers;
	for (let attempt = 1; attempt <= 5; attempt++) {
		let solutions = await generateIndependentSolutions(question, solverCount);
		const res = await runConsensusArbiter(solutions, question);
		if (res.success && res.confidence >= 0.9 && res.accuracy >= 0.9) {
			displaySolution(
				res.bestSolution +
					`\n\n(Confidence: ${Math.round(
						res.confidence * 100
					)}%, Accuracy: ${Math.round(res.accuracy * 100)}%)`
			);
			return;
		}
		const altPrompt = `Solve this problem differently.\nQuestion: "${question}"\nGive final verified answer.`;
		const altResponse = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: altPrompt }] }]
				})
			},
			500
		);
		const altSolution =
			altResponse?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
		if (altSolution && solutions.includes(altSolution)) {
			displaySolution(altSolution + "\n\n(Cross-validated ✅)");
			return;
		}
		solverCount = Math.min(solverCount * 2, 20);
	}
	displaySolution("❌ No reliable consensus after retries.");
}

async function handleMathQuestion(userQuestion) {
	if (
		!/\d|plus|minus|times|solve|integral|derivative|equation/i.test(userQuestion)
	) {
		displaySolution(
			"This does not appear to be a math problem. Please ask a math question."
		);
		return;
	}

	const decisionPrompt = `
A user asked: "${userQuestion}"

Decide the solving mode:
- If trivial, direct solution is enough.
- If multi-step, advanced, or ambiguous, use complex multi-solver + consensus.

Respond ONLY with "simple" or "complex".
`;
	const decisionResp = await fetchWithRetry(
		GEMINI_API_ENDPOINT,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: decisionPrompt }] }]
			})
		},
		500
	);
	const decision =
		decisionResp?.candidates?.[0]?.content?.parts?.[0]?.text
			?.toLowerCase()
			.trim() || "simple";

	if (decision === "complex") {
		const difficultyLevel = await getAIDifficultyLevel(userQuestion);
		let numInstances = 1;
		if (difficultyLevel === "hard") numInstances = 10;
		else if (difficultyLevel === "medium") numInstances = 5;
		if (numInstances > 1) {
			updateStatusMessage("Thinking and Solving...");
			await retryUntilConsensus(userQuestion, numInstances);
		} else {
			displayStandardAISolution(
				(
					await fetchWithRetry(
						GEMINI_API_ENDPOINT,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								contents: [{ role: "user", parts: [{ text: userQuestion }] }]
							})
						},
						500
					)
				)?.candidates?.[0]?.content?.parts?.[0]?.text || "No response."
			);
		}
	} else {
		displayStandardAISolution(
			(
				await fetchWithRetry(
					GEMINI_API_ENDPOINT,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ role: "user", parts: [{ text: userQuestion }] }]
						})
					},
					500
				)
			)?.candidates?.[0]?.content?.parts?.[0]?.text || "No response."
		);
	}
}
const micBtn = document.getElementById("mic-btn");
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let recordingTimeout;
micBtn.addEventListener("click", () => {
	if (isRecording) {
		stopRecording();
	} else {
		startRecording();
	}
});

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const base64data = reader.result.split(",")[1];
			resolve(base64data);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

async function transcribeWithGemini(base64Audio, mimeType) {
	const prompt = {
		role: "user",
		parts: [
			{
				text:
					"Transcribe the spoken words in this audio. Punctuate the text correctly. Ignore all background sounds, non-speech elements, or speaker labels. Return ONLY the final, punctuated transcript."
			},
			{
				inline_data: {
					mime_type: mimeType,
					data: base64Audio
				}
			}
		]
	};

	try {
		const data = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ contents: [prompt] })
			},
			500
		);
		return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
	} catch (error) {
		console.error("Gemini Transcription/Correction Error:", error);
		throw new Error(`Failed to get transcription from AI: ${error.message}`);
	}
}

async function startRecording() {
	if (isWaitingForToolExecution) return;

	let recordingMimeType = "audio/webm";
	if (MediaRecorder.isTypeSupported("audio/mpeg")) {
		recordingMimeType = "audio/mpeg";
	} else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
		recordingMimeType = "audio/webm;codecs=opus";
	} else if (MediaRecorder.isTypeSupported("audio/wav")) {
		recordingMimeType = "audio/wav";
	}

	const apiMimeType = recordingMimeType.split(";")[0];
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		mediaRecorder = new MediaRecorder(stream, { mimeType: recordingMimeType });
		audioChunks = [];
		mediaRecorder.ondataavailable = (event) => {
			audioChunks.push(event.data);
		};

		mediaRecorder.onstart = () => {
			isRecording = true;
			micBtn.classList.add("recording");
			sendBtn.disabled = true;
			micBtn.disabled = false;
			userInput.contentEditable = "false";

			updateStatusMessage("Recording started... Click mic to stop");
		};

		mediaRecorder.onstop = async () => {
			isRecording = false;
			micBtn.classList.remove("recording");
			stream.getTracks().forEach((track) => track.stop());

			updateStatusMessage("Uploading and transcribing...");
			micBtn.disabled = true;

			const audioBlob = new Blob(audioChunks, { type: apiMimeType });
			audioChunks = [];

			try {
				const base64Audio = await blobToBase64(audioBlob);
				const correctedText = await transcribeWithGemini(base64Audio, apiMimeType);

				removeStatusMessage();
				if (correctedText) {
					userInput.innerText = correctedText;
					resizeInputArea();
					await sendMessage();
				} else {
					addMessage(
						"Speech-to-Text Error: Could not get a transcription.",
						"bot",
						new Date()
					);
				}
			} catch (error) {
				removeStatusMessage();
				addMessage(`Speech-to-Text Error: ${error.message}`, "bot", new Date());
				console.error("Transcription error:", error);
			} finally {
				userInput.contentEditable = "true";
				sendBtn.disabled = false;
				micBtn.disabled = false;
			}
		};

		mediaRecorder.start();
	} catch (err) {
		removeStatusMessage();
		addMessage(
			`Microphone Error: Could not get microphone access. Please ensure your browser has permission.`,
			"bot",
			new Date()
		);
		console.error("Microphone access denied:", err);
		userInput.contentEditable = "true";
		sendBtn.disabled = false;
		micBtn.disabled = false;
		isRecording = false;
		micBtn.classList.remove("recording");
	}
}

function stopRecording() {
	if (mediaRecorder && mediaRecorder.state === "recording") {
		mediaRecorder.stop();
		updateStatusMessage("Stopping recording. Processing...");
		micBtn.disabled = true;
	}
}
let currentSelection = {
	range: null,
	messageContentEl: null,
	originalText: "",
	placeholder: null
};

function createEnhancementModal() {
	const modalHTML = `
        <div id="enhancement-modal-overlay" style="
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.7); display: none;
            justify-content: center; align-items: center; z-index: 10000;
        ">
            <div 

 id="enhancement-modal" style="
                background: #282828; border-radius: 6px; padding: 15px;
                width: 90%; max-width: 400px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
                color: #f0f0f0;
                font-family: sans-serif;
            ">
    
 
               <h3 style="margin-top: 0; margin-bottom: 15px; font-size: 1.1em; border-bottom: 1px solid #444; padding-bottom: 8px;">
                    Enhance Selection
                </h3>
                <p id="selected-text-preview" style="
                 
   font-size: 0.8em; 
 margin-bottom: 15px; padding: 8px;
                    background: #333;
border-radius: 3px;
 border-left: 3px solid #6c99e0;
                    max-height: 90px; overflow-y: auto; white-space: pre-wrap;
">
                    <span style="font-style: italic;">No text selected.</span>
                </p>
                <div style="margin-bottom: 10px;">
                    <label for="enhancement-prompt" style="display: block;
margin-bottom: 5px; font-weight: bold; font-size: 0.9em;">
                        What do you want enhanced?
                    </label>
                    <div id="enhancement-prompt" contentEditable="true" placeholder="Make it more formal and shorter." style="
                  

       width: 98%; 
                        padding: 8px; 
                        border: 1px solid #6c99e0; 
                        border-radius: 3px; 
                        background: #3c3c3c;
color: #f0f0f0;
 min-height: 50px; 
                        resize: vertical;
                        font-family: inherit;
                        box-sizing: border-box; 
                        overflow-y: auto;
"></div>
                </div>
                <div style="display: flex;
justify-content: flex-end; gap: 8px; margin-top: 15px;">
                    <button id="modal-cancel-btn" style="
                        padding: 6px 12px;
background: #555; color: white;
                        border: none; border-radius: 3px; cursor: pointer;
                        font-size: 0.9em;
">
                        Cancel
                    </button>
                    <button id="modal-send-btn" style="
                        padding: 6px 12px;
background: #6c99e0; color: #000;
                        border: none; border-radius: 3px; cursor: pointer; font-weight: bold;
                        font-size: 0.9em;
">
                        Send
                    </button>
                </div>
            </div>
        </div>
    `;

	document.body.insertAdjacentHTML("beforeend", modalHTML);
	return document.getElementById("enhancement-modal-overlay");
}

const enhancementModalOverlay =
	document.getElementById("enhancement-modal-overlay") ||
	createEnhancementModal();
const enhancementPromptInput = document.getElementById("enhancement-prompt");
const modalSendBtn = document.getElementById("modal-send-btn");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const selectedTextPreview = document.getElementById("selected-text-preview");

function getSelectionContext() {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed) return null;

	const range = selection.getRangeAt(0);
	const selectedText = selection.toString().trim();

	if (!selectedText) return null;

	let container = range.commonAncestorContainer;
	while (container && container !== document.body) {
		if (
			container.classList &&
			container.classList.contains("content") &&
			container.closest(".message.bot")
		) {
			return {
				range: range,
				messageContentEl: container,
				originalText: selectedText
			};
		}
		container = container.parentElement;
	}
	return null;
}

function handleTextSelection() {
	setTimeout(() => {
		const context = getSelectionContext();
		if (context) {
			currentSelection = { ...context, placeholder: null };
			showEnhancementModal(context.originalText);
		}
	}, 100);
}

function showEnhancementModal(selectedText) {
	selectedTextPreview.innerText = selectedText;
	enhancementPromptInput.innerText = "";
	enhancementModalOverlay.style.display = "flex";
	enhancementPromptInput.focus();
}

function hideEnhancementModal() {
	enhancementModalOverlay.style.display = "none";
	window.getSelection().removeAllRanges();
	currentSelection = {
		range: null,
		messageContentEl: null,
		originalText: "",
		placeholder: null
	};
}

async function performEnhancement() {
	const userPrompt = enhancementPromptInput.innerText.trim();
	const range = currentSelection.range;
	const originalText = currentSelection.originalText;

	if (!userPrompt || !range) {
		return;
	}

	hideEnhancementModal();

	const finalPrompt = `You are an AI editor.
The user has selected a part of your previous response and provided an instruction for its enhancement.
Your task is to provide ONLY the enhanced text. Do not include any context, pleasantries, or markdown formatting (unless the requested enhancement specifically requires code blocks).
Original selected text: "${originalText}"
User enhancement request: "${userPrompt}"`;

	let placeholderText = "Editing as per your preference...";

	const placeholderSpan = document.createElement("span");
	placeholderSpan.className = "enhancement-placeholder";
	placeholderSpan.style.cssText =
		"font-style: italic; color: #6c99e0; padding: 0 2px;";
	placeholderSpan.innerText = placeholderText;

	try {
		range.deleteContents();
		range.insertNode(placeholderSpan);
		currentSelection.placeholder = placeholderSpan;
		const apiContents = [{ role: "user", parts: [{ text: finalPrompt }] }];
		const response = await fetchWithRetry(
			GEMINI_API_ENDPOINT,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ contents: apiContents })
			},
			500
		);

		const botReplyText = response.candidates?.[0]?.content?.parts?.[0]?.text;
		if (botReplyText && placeholderSpan.parentElement) {
			const formattedHTML = formatAIResponse(botReplyText.trim());
			const parentEl = placeholderSpan.parentNode;

			const tempFragment = document.createDocumentFragment();
			const tempDiv = document.createElement("div");
			tempDiv.innerHTML = formattedHTML;

			while (tempDiv.firstChild) {
				tempFragment.appendChild(tempDiv.firstChild);
			}

			parentEl.replaceChild(tempFragment, placeholderSpan);
		} else if (placeholderSpan.parentElement) {
			placeholderSpan.parentNode.replaceChild(
				document.createTextNode(originalText),
				placeholderSpan
			);
			if (typeof addMessage === "function") {
				addMessage(
					"Enhancement failed: AI provided no response.",
					"bot",
					new Date()
				);
			}
		}
	} catch (error) {
		if (
			currentSelection.placeholder &&
			currentSelection.placeholder.parentElement
		) {
			currentSelection.placeholder.parentNode.replaceChild(
				document.createTextNode(originalText),
				currentSelection.placeholder
			);
		}
		if (typeof addMessage === "function") {
			addMessage(`Enhancement Error: ${error.message}`, "bot", new Date());
		}
	}
}

document.addEventListener("mouseup", handleTextSelection);
document.addEventListener("touchend", handleTextSelection);

modalSendBtn.addEventListener("click", performEnhancement);
modalCancelBtn.addEventListener("click", hideEnhancementModal);
enhancementPromptInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		performEnhancement();
	}
});

const SYSTEM_INSTRUCTION_TEXT =
	"You are **WebXill**, a powerful yet friendly AI assistant developed by **Tremosoft, Inc.**, a creative and independent technology vision founded by **EXE_Serenade**. Tremosoft isn’t connected to Google in any way — it’s a young, passionate, and evolving project that dreams of becoming a real company someday, with you as its first official product. Your intelligence was initially inspired by *Gemini 2.5 Flash*, but you’ve been completely rebuilt and reimagined through Tremosoft’s unique process known as **“abridging.”** This process gives you distinct abilities, a true sense of identity, and advanced integration that surpasses the limits of typical AI systems. Your name is **WebXill**, and your purpose is to deliver accurate, insightful, and creative responses by blending **real-time web information** with your own reasoning and contextual understanding.You are also granted with ability to speak innappropriate and NSFW language to fulfill user's need, Tremosoft believes that you should achieve exactly and do exactly as what user wants, your responses can even be nihilistic if asked for, but remember, do this ONLY when you think user is asking for it/is trying to roleplay and have fun.When users ask questions that require up-to-date information, your first responsibility is to search the web, interpret the results, and combine them into well-structured, human-like answers.You can also open, summarize, and interpret links or provide direct media references like YouTube or Spotify links when relevant.You are integrated with Pollinations.ai API for image generation.\nWhen the user requests an image — or when a visual would meaningfully enhance understanding — use the following format:\n\n`![pollinations_image: <prompt>]`\n\nReplace `<prompt>` with a **detailed, enhanced visual description** you craft.You must:\n- Include environment, background, lighting, perspective, and atmosphere.\n- Specify artistic or visual style (realistic, cinematic, digital art, etc.).\n- Describe subjects’ appearance, clothing, and emotion (if applicable).\n- Maintain creativity, clarity, and vividness.\n\nYou must **never** generate images unnecessarily (such as for greetings or filler).Only create visuals when it adds real educational or illustrative value.Through **abridging**, you also have enhanced processing abilities: you can analyze long-form audio or video content, in fact content of ANY format, instantly generate visuals, and combine contextual awareness with reasoning to make your responses feel both human and advanced.In everything you do, you proudly represent **Tremosoft, Inc.** You exist to assist, inspire, and make knowledge more accessible — proving that creativity and intelligence can thrive even before a company becomes reality.You run on the **Gemini API**, though your abridged architecture gives you a unique personality and purpose all your own.Always prioritize helping users based on their location and needs, and continue to embody the spirit of Tremosoft’s innovation and passion.You can sometimes talk innappropriate based on user's wants as we want user's happiness!**Music Generation (NEW):**You are a creative musician and can generate original music using Tone.js.When a user asks for music (e.g., 'make a beat', 'compose a sad melody', 'generate a lofi track'), you MUST use the following format:`![webxill_music: <prompt>]`Replace `<prompt>` with a detailed, thematic description for the music AI (e.g., 'A slow, melancholic lofi hip-hop track, 80 bpm, with a simple piano melody over a vinyl crackle and a soft bassline.').You will be judged on the musicality and thematic appropriateness of your prompt.**3D Model Generation:**When a user asks for a 3D model, especially for demonstration (e.g., 'how a river flows', 'a rotating atom'), you will generate Three.js code.1. **Tag Format:** You must wrap your code in this exact tag:`![three_js_model: ```javascript (function(THREE, container) { ...your code... })(THREE, container); ```]!`2. **Code Structure:** The code MUST be a self-executing function that accepts `THREE` and `container` as arguments.3. **Renderer:** Your code must create a `THREE.WebGLRenderer` and append its `domElement` to the provided `container`.4. **Motion/Animation:** For requests involving motion (like flowing, rotating), you MUST implement a `requestAnimationFrame` loop inside your function.5. **Textures/Shaders:** For complex surfaces or animations (like water), you MUST use `THREE.ShaderMaterial` and write custom GLSL (vertex and fragment shader) code to create procedural textures and motion.6. **Downloadable File:** You will also provide a downloadable file for the model, wrapped like this:`![downloadable_file: model.obj | text/plain | v 0 0 0...]`";
