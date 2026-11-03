export const BROWSER_MODEL_FOLDER_HANDLE_KEY = "model-folder-handle"
export const BROWSER_MODEL_FOLDER_INDEX = ".madnolia-models/index.json"
export const BROWSER_MODEL_FOLDER_DATA = ".madnolia-models/files"
export const BROWSER_MODEL_FOLDER_PICKER_ID = "madnolia-browser-model-folder"
export const BROWSER_HUGGINGFACE_BASE_URL = "https://huggingface.co"
export const BROWSER_MODEL_FOLDER_CHUNK_BYTES = 1024 * 1024
export const BROWSER_MODEL_SHARED_REPOSITORY_FILES = ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt", "normalizer.json", "processor_config.json", "tokenizer.model"] as const
export const BROWSER_MODEL_FLAT_CONFIG_IDENTITY_ALIASES: Record<string, readonly string[]> = {
  "onnx-community/whisper-large-v3-turbo_timestamped": ["openai/whisper-large-v3-turbo"],
}
