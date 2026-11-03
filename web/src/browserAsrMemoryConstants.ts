export const BROWSER_ASR_WASM_MEMORY_EVIDENCE = {
  artifact: {
    modelId: "Xenova/whisper-large-v3",
    revision: "67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0",
    encoderGraphBytes: 676667,
    encoderExternalDataBytes: 2547875840,
    decoderGraphBytes: 3152042,
    decoderExternalDataBytes: 3626086400,
    externalWeightBytes: 6173962240,
    rawArtifactBytes: 6177790949,
    sourceUrl: "https://huggingface.co/api/models/Xenova/whisper-large-v3/tree/67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0",
  },
  wasmHeap: {
    package: "onnxruntime-web@1.22.0-dev.20250409-89f8206ba4",
    maximumPages: 65536,
    bytesPerPage: 65536,
    maximumBytes: 4294967296,
    sourceUrl: "https://unpkg.com/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/ort-wasm-simd-threaded.mjs",
  },
} as const

export const BROWSER_ASR_WASM_MEMORY_ERROR = `This pinned FP32 Whisper large-v3 artifact has ${BROWSER_ASR_WASM_MEMORY_EVIDENCE.artifact.externalWeightBytes.toLocaleString("en-US")} external weight bytes (~5.75 GiB), exceeding the ONNX Runtime WebAssembly heap limit of ${BROWSER_ASR_WASM_MEMORY_EVIDENCE.wasmHeap.maximumBytes.toLocaleString("en-US")} bytes (4 GiB). Choose WebGPU on capable hardware or explicitly select a compact model. The runtime will not change the model, dtype, or device automatically.`
