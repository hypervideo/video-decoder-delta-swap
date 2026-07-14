const LEVELS = [
  { id: "high", label: "High", width: 1280, height: 720, bitrate: 2_500_000 },
  { id: "medium", label: "Medium", width: 640, height: 360, bitrate: 900_000 },
  { id: "low", label: "Low", width: 320, height: 180, bitrate: 300_000 },
];

const CODEC_FAMILIES = {
  av1: {
    label: "AV1",
    candidates: ["av01.0.08M.08", "av01.0.05M.08", "av01.0.04M.08", "av01"],
  },
  h264: {
    label: "H.264",
    candidates: ["avc1.64001f", "avc1.4d001f", "avc1.42001f"],
    encoderOptions: { avc: { format: "avc" } },
  },
  vp9: {
    label: "VP9",
    candidates: ["vp09.00.31.08", "vp09.00.30.08", "vp09.00.10.08", "vp09"],
  },
};

const LEVEL_BY_ID = new Map(LEVELS.map((level) => [level.id, level]));
const TARGET_FPS = 30;
const KEYFRAME_INTERVAL = TARGET_FPS * 5;
const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 90;
const MAX_REFERENCE_FRAMES = 150;

const elements = {
  sourceVideo: document.querySelector("#sourceVideo"),
  sourceEmpty: document.querySelector("#sourceEmpty"),
  outputCanvas: document.querySelector("#outputCanvas"),
  outputEmpty: document.querySelector("#outputEmpty"),
  sourceMeta: document.querySelector("#sourceMeta"),
  outputMeta: document.querySelector("#outputMeta"),
  liveBadge: document.querySelector("#liveBadge"),
  startButton: document.querySelector("#startButton"),
  codecSelect: document.querySelector("#codecSelect"),
  resetDecoderButton: document.querySelector("#resetDecoderButton"),
  resetConfidenceButton: document.querySelector("#resetConfidenceButton"),
  forceKeyframeButton: document.querySelector("#forceKeyframeButton"),
  autoSwitch: document.querySelector("#autoSwitch"),
  sessionState: document.querySelector("#sessionState"),
  sessionStateText: document.querySelector("#sessionStateText"),
  laneButtons: [...document.querySelectorAll(".lane")],
  strategyInputs: [...document.querySelectorAll('input[name="strategy"]')],
  frameType: document.querySelector("#frameType"),
  frameTimestamp: document.querySelector("#frameTimestamp"),
  psnrValue: document.querySelector("#psnrValue"),
  psnrMeter: document.querySelector("#psnrMeter"),
  qualityPill: document.querySelector("#qualityPill"),
  decodedFrames: document.querySelector("#decodedFrames"),
  decoderFaults: document.querySelector("#decoderFaults"),
  deltaSwaps: document.querySelector("#deltaSwaps"),
  queueDepth: document.querySelector("#queueDepth"),
  eventTime: document.querySelector("#eventTime"),
  eventMessage: document.querySelector("#eventMessage"),
  year: document.querySelector("#year"),
};

const outputContext = elements.outputCanvas.getContext("2d", { alpha: false });
const referenceCanvas = document.createElement("canvas");
referenceCanvas.width = ANALYSIS_WIDTH;
referenceCanvas.height = ANALYSIS_HEIGHT;
const referenceContext = referenceCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true,
});
const decodedSampleCanvas = document.createElement("canvas");
decodedSampleCanvas.width = ANALYSIS_WIDTH;
decodedSampleCanvas.height = ANALYSIS_HEIGHT;
const decodedSampleContext = decodedSampleCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true,
});

const state = {
  running: false,
  generation: 0,
  stream: null,
  activeLevel: "medium",
  strategy: "continuous",
  codec: null,
  codecFamily: "av1",
  lanes: new Map(),
  singleDecoder: null,
  singleConfiguredLevel: null,
  recoveryPending: false,
  handoffPending: null,
  bridgePending: null,
  reconfigurePending: null,
  lastDecodedFrame: null,
  references: new Map(),
  lastTimestamp: 0,
  lastCaptureAt: 0,
  decodedFrames: 0,
  decoderFaults: 0,
  deltaSwaps: 0,
  recentPsnr: [],
  autoSwitchTimer: null,
  statsTimer: null,
};

function createLane(level) {
  const canvas = document.createElement("canvas");
  canvas.width = level.width;
  canvas.height = level.height;

  return {
    ...level,
    canvas,
    context: canvas.getContext("2d", { alpha: false, desynchronized: true }),
    encoder: null,
    decoder: null,
    decoderAwaitingKey: true,
    decoderConfig: null,
    forceKeyframe: true,
    frameCount: 0,
    bytesWindow: 0,
    bitrateKbps: 0,
    droppedFrames: 0,
    suppressPeriodicKeyframeOnce: false,
    lastChunkType: "key",
  };
}

function setSessionState(status, label) {
  elements.sessionState.dataset.state = status;
  elements.sessionStateText.textContent = label;
}

function logEvent(message) {
  elements.eventMessage.textContent = message;
  elements.eventTime.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function setControlsEnabled(enabled) {
  elements.laneButtons.forEach((button) => { button.disabled = !enabled; });
  elements.autoSwitch.disabled = !enabled;
  elements.resetDecoderButton.disabled = !enabled;
  elements.resetConfidenceButton.disabled = !enabled;
  elements.forceKeyframeButton.disabled = !enabled;
}

function updateActiveLane() {
  elements.laneButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.level === state.activeLevel);
  });
}

function cloneDecoderConfig(config) {
  if (!config) return null;
  const clone = { ...config };
  if (config.description) {
    const bytes = new Uint8Array(config.description);
    clone.description = bytes.slice().buffer;
  }
  return clone;
}

function getFallbackDecoderConfig(lane) {
  return {
    codec: state.codec,
    codedWidth: lane.width,
    codedHeight: lane.height,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  };
}

async function findSupportedCodec(codecFamilyId) {
  if (!("VideoEncoder" in window) || !("VideoDecoder" in window) || !("VideoFrame" in window)) {
    throw new Error("This browser does not expose the WebCodecs video APIs.");
  }

  const family = CODEC_FAMILIES[codecFamilyId];
  const candidates = family.candidates;
  const high = LEVELS[0];

  const probes = candidates.flatMap((codec) => ["prefer-hardware", null].map(async (hardwareAcceleration) => {
    const config = {
      codec,
      width: high.width,
      height: high.height,
      bitrate: high.bitrate,
      framerate: TARGET_FPS,
      latencyMode: "realtime",
      bitrateMode: "variable",
      ...family.encoderOptions,
    };
    if (hardwareAcceleration) config.hardwareAcceleration = hardwareAcceleration;

    try {
      const result = await Promise.race([
        VideoEncoder.isConfigSupported(config),
        new Promise((resolve) => window.setTimeout(() => resolve({ supported: false }), 3500)),
      ]);
      return result.supported ? { codec, codecFamilyId, hardwareAcceleration } : null;
    } catch {
      return null;
    }
  }));

  const results = await Promise.all(probes);
  const supported = results.find(Boolean);
  if (supported) return supported;

  throw new Error(`No ${family.label} WebCodecs encoder is available for a 1280 × 720 stream.`);
}

function encoderConfigFor(lane, support) {
  const config = {
    codec: support.codec,
    width: lane.width,
    height: lane.height,
    bitrate: lane.bitrate,
    framerate: TARGET_FPS,
    latencyMode: "realtime",
    bitrateMode: "variable",
    ...CODEC_FAMILIES[support.codecFamilyId].encoderOptions,
  };

  if (support.hardwareAcceleration) {
    config.hardwareAcceleration = support.hardwareAcceleration;
  }

  return config;
}

function createEncoder(lane, support, generation) {
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (!state.running || generation !== state.generation) return;
      handleEncodedChunk(lane, chunk, metadata);
    },
    error: (error) => {
      if (generation !== state.generation) return;
      laneError(lane, `Encoder fault: ${error.message}`);
    },
  });

  encoder.configure(encoderConfigFor(lane, support));
  return encoder;
}

function createDecoder(outputLevel, isolated, generation) {
  let decoder;
  decoder = new VideoDecoder({
    output: (frame) => {
      if (!state.running || generation !== state.generation) {
        frame.close();
        return;
      }

      const currentOutputLevel = isolated ? outputLevel : state.activeLevel;
      if (!isolated || currentOutputLevel === state.activeLevel) {
        renderDecodedFrame(frame, currentOutputLevel);
      }
      frame.close();
    },
    error: (error) => {
      if (generation !== state.generation) return;
      handleDecoderError(error, isolated ? outputLevel : state.activeLevel, isolated, decoder);
    },
  });
  return decoder;
}

function laneError(lane, message) {
  const health = document.querySelector(`[data-health="${lane.id}"]`);
  health.textContent = "Fault";
  health.classList.remove("is-live");
  setSessionState("error", "Pipeline fault");
  logEvent(`${lane.label}: ${message}`);
}

function handleDecoderError(error, levelId, isolated, decoder) {
  state.decoderFaults += 1;
  elements.decoderFaults.textContent = state.decoderFaults.toLocaleString();
  const level = LEVEL_BY_ID.get(levelId);

  if (isolated) {
    const lane = state.lanes.get(levelId);
    if (lane?.decoder === decoder) lane.decoder = null;
    if (lane) {
      lane.decoderAwaitingKey = true;
      lane.forceKeyframe = true;
    }
  } else if (state.singleDecoder === decoder) {
    state.singleDecoder = null;
    state.singleConfiguredLevel = null;
    state.bridgePending = null;
    state.recoveryPending = true;
    state.lanes.get(state.activeLevel).forceKeyframe = true;
  }

  elements.qualityPill.dataset.quality = "warn";
  elements.qualityPill.textContent = "Decoder fault";
  logEvent(`${level?.label ?? levelId} decoder rejected the handoff: ${error.message}`);
}

function ensureIsolatedDecoder(lane) {
  if (!lane.decoder || lane.decoder.state === "closed") {
    lane.decoder = createDecoder(lane.id, true, state.generation);
  }
  if (lane.decoder.state === "unconfigured") {
    lane.decoder.configure(lane.decoderConfig ?? getFallbackDecoderConfig(lane));
  }
  return lane.decoder;
}

function ensureSingleDecoder() {
  if (!state.singleDecoder || state.singleDecoder.state === "closed") {
    state.singleDecoder = createDecoder(state.activeLevel, false, state.generation);
  }
  return state.singleDecoder;
}

function configureSingleDecoder(lane, reset = false) {
  const decoder = ensureSingleDecoder();
  if (reset && decoder.state === "configured") decoder.reset();
  decoder.configure(lane.decoderConfig ?? getFallbackDecoderConfig(lane));
  state.singleConfiguredLevel = lane.id;
  return decoder;
}

function decodeOrReport(decoder, chunk, lane) {
  try {
    decoder.decode(chunk);
  } catch (error) {
    handleDecoderError(error, lane.id, decoder !== state.singleDecoder, decoder);
  }
}

function handleEncodedChunk(lane, chunk, metadata) {
  lane.frameCount += 1;
  lane.bytesWindow += chunk.byteLength;
  lane.lastChunkType = chunk.type;

  if (metadata?.decoderConfig) {
    lane.decoderConfig = cloneDecoderConfig(metadata.decoderConfig);
  }

  if (state.strategy === "isolated") {
    if (lane.decoderAwaitingKey) {
      if (chunk.type !== "key") return;
      lane.decoderAwaitingKey = false;
    }
    const decoder = ensureIsolatedDecoder(lane);
    decodeOrReport(decoder, chunk, lane);
    return;
  }

  if (lane.id !== state.activeLevel) return;

  if (state.bridgePending) {
    const isExpectedBridge = lane.id === state.bridgePending.levelId
      && chunk.type === "key"
      && chunk.timestamp === state.bridgePending.timestamp;
    if (!isExpectedBridge) return;

    state.bridgePending = null;
    state.recoveryPending = false;
    configureSingleDecoder(lane, true);
    logEvent(`Transcoded bridge admitted at ${lane.width} × ${lane.height}; following target deltas are now live.`);
  } else if (state.recoveryPending) {
    if (chunk.type !== "key") return;
    state.recoveryPending = false;
    configureSingleDecoder(lane, true);
    logEvent(`Decoder recovered on a ${lane.label} keyframe after the failed handoff.`);
  }

  if (state.handoffPending) {
    if (chunk.type !== "key") return;
    state.handoffPending = null;
    configureSingleDecoder(lane, true);
    logEvent(`Keyframe handoff completed at ${lane.width} × ${lane.height}.`);
  } else if (state.reconfigurePending === lane.id) {
    state.reconfigurePending = null;
    configureSingleDecoder(lane, true);
    logEvent(`Decoder reconfigured for ${lane.label}; the first submitted chunk is ${chunk.type}.`);
  }

  let decoder = ensureSingleDecoder();
  if (decoder.state === "unconfigured") {
    if (chunk.type !== "key") {
      lane.forceKeyframe = true;
      return;
    }
    decoder = configureSingleDecoder(lane);
  }

  decodeOrReport(decoder, chunk, lane);
}

function captureReference(timestamp) {
  referenceContext.drawImage(elements.sourceVideo, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const pixels = referenceContext.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  state.references.set(timestamp, pixels.data);

  if (state.references.size > MAX_REFERENCE_FRAMES) {
    const oldest = state.references.keys().next().value;
    state.references.delete(oldest);
  }
}

function calculatePsnr(reference, decoded) {
  let squaredError = 0;
  let samples = 0;

  // Sampling every second pixel keeps the main thread responsive on modest devices.
  for (let index = 0; index < reference.length; index += 8) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = reference[index + channel] - decoded[index + channel];
      squaredError += difference * difference;
      samples += 1;
    }
  }

  const mse = squaredError / samples;
  return mse === 0 ? 60 : Math.min(60, 10 * Math.log10((255 * 255) / mse));
}

function updateQuality(psnr) {
  state.recentPsnr.push(psnr);
  if (state.recentPsnr.length > 24) state.recentPsnr.shift();

  const prior = state.recentPsnr.slice(0, -1);
  const baseline = prior.length
    ? prior.reduce((total, value) => total + value, 0) / prior.length
    : psnr;
  const suspicious = psnr < 24 || baseline - psnr > 8;

  elements.psnrValue.textContent = psnr.toFixed(1);
  elements.psnrMeter.style.width = `${Math.max(3, Math.min(100, ((psnr - 15) / 30) * 100))}%`;
  elements.psnrMeter.style.background = suspicious ? "var(--danger)" : "var(--acid)";
  elements.qualityPill.dataset.quality = suspicious ? "warn" : "good";
  elements.qualityPill.textContent = suspicious ? "Inspect output" : "Signal nominal";
}

function renderDecodedFrame(frame, levelId) {
  outputContext.fillStyle = "#050706";
  outputContext.fillRect(0, 0, elements.outputCanvas.width, elements.outputCanvas.height);

  const scale = Math.min(
    elements.outputCanvas.width / frame.displayWidth,
    elements.outputCanvas.height / frame.displayHeight,
  );
  const width = frame.displayWidth * scale;
  const height = frame.displayHeight * scale;
  const x = (elements.outputCanvas.width - width) / 2;
  const y = (elements.outputCanvas.height - height) / 2;
  outputContext.drawImage(frame, x, y, width, height);

  if (state.lastDecodedFrame) state.lastDecodedFrame.close();
  state.lastDecodedFrame = frame.clone();

  decodedSampleContext.drawImage(frame, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const reference = state.references.get(frame.timestamp);
  if (reference) {
    const decoded = decodedSampleContext.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
    updateQuality(calculatePsnr(reference, decoded));
    state.references.delete(frame.timestamp);
  }

  const lane = state.lanes.get(levelId);
  state.decodedFrames += 1;
  elements.decodedFrames.textContent = state.decodedFrames.toLocaleString();
  elements.outputEmpty.classList.add("is-hidden");
  elements.outputMeta.textContent = `${CODEC_FAMILIES[state.codecFamily].label} · ${lane.width} × ${lane.height} / ${state.strategy}`;
  elements.frameType.textContent = `${lane.lastChunkType} frame`;
  elements.frameTimestamp.textContent = `${(frame.timestamp / 1_000_000).toFixed(2)} s`;
}

function captureFrame(now) {
  if (!state.running || elements.sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (now - state.lastCaptureAt < (1000 / TARGET_FPS) * 0.8) return;
  state.lastCaptureAt = now;

  const timestamp = Math.max(state.lastTimestamp + 1, Math.round(now * 1000));
  state.lastTimestamp = timestamp;
  captureReference(timestamp);

  for (const lane of state.lanes.values()) {
    if (!lane.encoder || lane.encoder.state !== "configured") continue;
    if (lane.encoder.encodeQueueSize > 3) {
      lane.droppedFrames += 1;
      continue;
    }

    lane.context.drawImage(elements.sourceVideo, 0, 0, lane.width, lane.height);
    const frame = new VideoFrame(lane.canvas, {
      timestamp,
      duration: Math.round(1_000_000 / TARGET_FPS),
    });
    const periodicKeyframe = !lane.suppressPeriodicKeyframeOnce
      && lane.frameCount % KEYFRAME_INTERVAL === 0;
    const keyFrame = lane.forceKeyframe || periodicKeyframe;
    lane.encoder.encode(frame, { keyFrame });
    lane.forceKeyframe = false;
    lane.suppressPeriodicKeyframeOnce = false;
    frame.close();
  }
}

function frameLoop(now) {
  captureFrame(now);
  if (state.running) {
    elements.sourceVideo.requestVideoFrameCallback(frameLoop);
  }
}

function refreshStats() {
  let queueDepth = 0;
  for (const lane of state.lanes.values()) {
    lane.bitrateKbps = Math.round((lane.bytesWindow * 8) / 1000);
    lane.bytesWindow = 0;
    queueDepth += lane.encoder?.encodeQueueSize ?? 0;

    const bitrate = document.querySelector(`[data-stat="${lane.id}-bitrate"]`);
    const health = document.querySelector(`[data-health="${lane.id}"]`);
    bitrate.textContent = lane.bitrateKbps.toLocaleString();
    health.textContent = lane.droppedFrames ? `${lane.droppedFrames} skip` : "Live";
    health.classList.add("is-live");
  }
  elements.queueDepth.textContent = queueDepth.toLocaleString();
}

function closeCodecs() {
  if (state.singleDecoder && state.singleDecoder.state !== "closed") {
    state.singleDecoder.close();
  }
  state.singleDecoder = null;

  if (state.lastDecodedFrame) {
    state.lastDecodedFrame.close();
    state.lastDecodedFrame = null;
  }

  for (const lane of state.lanes.values()) {
    if (lane.encoder && lane.encoder.state !== "closed") lane.encoder.close();
    if (lane.decoder && lane.decoder.state !== "closed") lane.decoder.close();
    lane.encoder = null;
    lane.decoder = null;
    lane.decoderAwaitingKey = true;
  }
}

async function startExperiment() {
  elements.startButton.disabled = true;
  elements.codecSelect.disabled = true;
  const selectedFamily = elements.codecSelect.value;
  const selectedCodecLabel = CODEC_FAMILIES[selectedFamily].label;
  elements.startButton.textContent = `Checking ${selectedCodecLabel}…`;
  setSessionState("idle", "Checking support");

  try {
    const support = await findSupportedCodec(selectedFamily);
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
      },
    });

    elements.sourceVideo.srcObject = state.stream;
    await elements.sourceVideo.play();

    state.generation += 1;
    state.running = true;
    state.codec = support.codec;
    state.codecFamily = support.codecFamilyId;
    state.lanes = new Map(LEVELS.map((level) => [level.id, createLane(level)]));
    for (const lane of state.lanes.values()) {
      lane.encoder = createEncoder(lane, support, state.generation);
    }

    const track = state.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    elements.sourceMeta.textContent = `${settings.width ?? elements.sourceVideo.videoWidth} × ${settings.height ?? elements.sourceVideo.videoHeight} / ${Math.round(settings.frameRate ?? TARGET_FPS)} fps`;
    elements.sourceEmpty.classList.add("is-hidden");
    elements.liveBadge.classList.add("is-visible");
    elements.startButton.disabled = false;
    elements.startButton.innerHTML = '<span class="button-icon" aria-hidden="true">■</span> Stop camera';
    setControlsEnabled(true);
    setSessionState("live", `Encoding ${selectedCodecLabel}`);
    logEvent(`Three ${selectedCodecLabel} encoders started with ${state.strategy} decoding.`);

    state.statsTimer = window.setInterval(refreshStats, 1000);
    configureAutoSwitch();
    elements.sourceVideo.requestVideoFrameCallback(frameLoop);
  } catch (error) {
    stopExperiment();
    elements.startButton.disabled = false;
    elements.startButton.innerHTML = '<span class="button-icon" aria-hidden="true">●</span> Try again';
    setSessionState("error", "Cannot start");
    logEvent(error.message);
  }
}

function stopExperiment() {
  state.running = false;
  state.generation += 1;
  window.clearInterval(state.statsTimer);
  window.clearInterval(state.autoSwitchTimer);
  state.statsTimer = null;
  state.autoSwitchTimer = null;
  closeCodecs();

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  state.stream = null;
  elements.sourceVideo.srcObject = null;
  elements.sourceEmpty.classList.remove("is-hidden");
  elements.outputEmpty.classList.remove("is-hidden");
  elements.liveBadge.classList.remove("is-visible");
  elements.startButton.disabled = false;
  elements.codecSelect.disabled = false;
  elements.startButton.innerHTML = '<span class="button-icon" aria-hidden="true">●</span> Start camera';
  setControlsEnabled(false);
  setSessionState("idle", "Ready to run");
}

function resetMetrics() {
  state.recentPsnr = [];
  elements.psnrValue.textContent = "—";
  elements.psnrMeter.style.width = "0%";
  elements.qualityPill.dataset.quality = "idle";
  elements.qualityPill.textContent = "No sample";
}

function resetSignalConfidence() {
  resetMetrics();
  state.decodedFrames = 0;
  state.decoderFaults = 0;
  state.deltaSwaps = 0;
  elements.decodedFrames.textContent = "0";
  elements.decoderFaults.textContent = "0";
  elements.deltaSwaps.textContent = "0";

  for (const lane of state.lanes.values()) {
    lane.droppedFrames = 0;
  }
}

function restartDecoding(reason = "Decoder reset requested.") {
  if (!state.running) return;

  if (state.singleDecoder && state.singleDecoder.state !== "closed") state.singleDecoder.close();
  state.singleDecoder = null;
  state.singleConfiguredLevel = null;
  state.recoveryPending = true;
  state.handoffPending = null;
  state.bridgePending = null;
  state.reconfigurePending = null;

  for (const lane of state.lanes.values()) {
    if (lane.decoder && lane.decoder.state !== "closed") lane.decoder.close();
    lane.decoder = null;
    lane.decoderAwaitingKey = true;
    lane.forceKeyframe = true;
  }
  resetMetrics();
  logEvent(`${reason} The next frame on every lane will be a keyframe.`);
}

function enqueueTranscodedBridge(lane) {
  if (!state.lastDecodedFrame || !lane.encoder || lane.encoder.state !== "configured") {
    return null;
  }

  let bridgeFrame;
  try {
    lane.context.drawImage(state.lastDecodedFrame, 0, 0, lane.width, lane.height);
    const timestamp = Math.max(
      state.lastTimestamp + 1,
      state.lastDecodedFrame.timestamp + 1,
    );
    state.lastTimestamp = timestamp;
    bridgeFrame = new VideoFrame(lane.canvas, {
      timestamp,
      duration: Math.round(1_000_000 / TARGET_FPS),
    });
    lane.encoder.encode(bridgeFrame, { keyFrame: true });
    lane.forceKeyframe = false;
    lane.suppressPeriodicKeyframeOnce = true;
    return timestamp;
  } catch {
    return null;
  } finally {
    bridgeFrame?.close();
  }
}

function switchLevel(levelId, automatic = false) {
  if (!state.running || levelId === state.activeLevel || !LEVEL_BY_ID.has(levelId)) return;
  const previous = LEVEL_BY_ID.get(state.activeLevel);
  const next = state.lanes.get(levelId);
  state.activeLevel = levelId;
  updateActiveLane();

  if (state.strategy === "continuous") {
    state.deltaSwaps += 1;
    elements.deltaSwaps.textContent = state.deltaSwaps.toLocaleString();
    logEvent(`${automatic ? "Auto-cycled" : "Switched"} ${previous.label} → ${next.label}; next delta enters the existing decoder unchanged.`);
  } else if (state.strategy === "reconfigure") {
    state.deltaSwaps += 1;
    elements.deltaSwaps.textContent = state.deltaSwaps.toLocaleString();
    state.reconfigurePending = levelId;
    logEvent(`Switched ${previous.label} → ${next.label}; decoder config changes before the next delta.`);
  } else if (state.strategy === "keyframe") {
    state.handoffPending = levelId;
    next.forceKeyframe = true;
    logEvent(`Switched ${previous.label} → ${next.label}; waiting for a clean keyframe boundary.`);
  } else if (state.strategy === "bridge") {
    const bridgeTimestamp = enqueueTranscodedBridge(next);
    if (bridgeTimestamp === null) {
      state.handoffPending = levelId;
      next.forceKeyframe = true;
      logEvent(`No decoded image was available for the ${next.label} bridge; falling back to a keyframe handoff.`);
      return;
    }

    state.deltaSwaps += 1;
    elements.deltaSwaps.textContent = state.deltaSwaps.toLocaleString();
    state.bridgePending = { levelId, timestamp: bridgeTimestamp };
    logEvent(`Switched ${previous.label} → ${next.label}; transcoding the remembered frame into the target encoder.`);
  } else {
    logEvent(`Switched display to the primed ${next.label} decoder.`);
  }
}

function configureAutoSwitch() {
  window.clearInterval(state.autoSwitchTimer);
  state.autoSwitchTimer = null;
  const interval = Number(elements.autoSwitch.value);
  if (!state.running || interval === 0) return;

  state.autoSwitchTimer = window.setInterval(() => {
    const index = LEVELS.findIndex((level) => level.id === state.activeLevel);
    switchLevel(LEVELS[(index + 1) % LEVELS.length].id, true);
  }, interval);
}

function changeStrategy(strategy) {
  state.strategy = strategy;
  if (state.running) {
    restartDecoding(`Strategy changed to ${strategy}.`);
  }
}

elements.startButton.addEventListener("click", () => {
  if (state.running) stopExperiment();
  else startExperiment();
});

elements.resetDecoderButton.addEventListener("click", () => restartDecoding());

elements.resetConfidenceButton.addEventListener("click", () => {
  resetSignalConfidence();
  logEvent("Signal confidence and cumulative telemetry were reset; the next decoded frame starts a new baseline.");
});

elements.forceKeyframeButton.addEventListener("click", () => {
  if (!state.running) return;
  state.lanes.get(state.activeLevel).forceKeyframe = true;
  logEvent(`A keyframe was requested on the ${LEVEL_BY_ID.get(state.activeLevel).label} lane.`);
});

elements.laneButtons.forEach((button) => {
  button.addEventListener("click", () => switchLevel(button.dataset.level));
});

elements.strategyInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) changeStrategy(input.value);
  });
});

elements.autoSwitch.addEventListener("change", configureAutoSwitch);

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const level = { "1": "high", "2": "medium", "3": "low" }[event.key];
  if (level) switchLevel(level);
});

window.addEventListener("pagehide", stopExperiment);

elements.year.textContent = new Date().getFullYear();
updateActiveLane();

if (!window.isSecureContext) {
  setSessionState("error", "HTTPS required");
  logEvent("Camera and WebCodecs access require HTTPS or a localhost origin.");
}
